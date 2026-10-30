import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import type { ReadableStream } from "node:stream/web";
import { Agent, fetch as undiciFetch } from "undici";
import { BlockedAddressError, resolvePublicAddresses, systemResolver, type HostResolver } from "./network.js";
import { canonicalizeUrl } from "./url.js";

export type FetchErrorCode =
  | "BLOCKED_URL"
  | "BLOCKED_ADDRESS"
  | "TOO_MANY_REDIRECTS"
  | "BAD_STATUS"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "NETWORK";

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

/** Performs one request without following redirects. */
export type HttpTransport = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<HttpResponseLike>;

/**
 * DNS lookup for outbound connections that refuses non-public addresses.
 * Because the socket connects to the address validated here, a hostname cannot
 * pass validation and then re-resolve to a private address (DNS rebinding).
 */
export function createSafeLookup(resolver: HostResolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolvePublicAddresses(hostname, resolver).then(
      (addresses) => {
        const family = options.family === 4 || options.family === 6 ? options.family : undefined;
        const usable: LookupAddress[] = family ? addresses.filter((a) => a.family === family) : addresses;
        const first = usable[0];
        if (!first) {
          callback(Object.assign(new Error(`No usable address for ${hostname}`), { code: "ENOTFOUND" }), "");
        } else if (options.all) {
          callback(null, usable);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (err: Error) => callback(err, ""),
    );
  };
}

/**
 * Production transport. Every connection goes through the safe lookup; IP
 * literal hosts never reach DNS, so callers must reject them first (fetchPublicPage
 * does, via canonicalizeUrl). Proxy environment variables are not honoured.
 */
export function createSafeTransport(
  options: { resolver?: HostResolver; connectTimeoutMs?: number } = {},
): HttpTransport {
  const agent = new Agent({
    connect: { lookup: createSafeLookup(options.resolver), timeout: options.connectTimeoutMs ?? 5_000 },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });

  return async (url, init) => {
    const res = await undiciFetch(url, {
      method: "GET",
      headers: init.headers,
      signal: init.signal,
      redirect: "manual",
      dispatcher: agent,
    });
    return res;
  };
}

export interface FetchPolicy {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** Lowercase MIME types; null accepts any (used for robots.txt). */
  allowedContentTypes: readonly string[] | null;
  userAgent: string;
  accept: string;
}

export interface FetchedDocument {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  bytes: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * GETs a public URL with SSRF checks on the initial URL and every redirect,
 * plus strict limits on time, size and content type.
 */
export async function fetchPublicDocument(
  url: string,
  transport: HttpTransport,
  policy: FetchPolicy,
): Promise<FetchedDocument> {
  const signal = AbortSignal.timeout(policy.timeoutMs);
  const headers = { "user-agent": policy.userAgent, accept: policy.accept };
  let current = url;

  try {
    for (let redirects = 0; ; redirects++) {
      const canonical = canonicalizeUrl(current);
      if (!canonical.ok) throw new FetchError("BLOCKED_URL", `URL rejected: ${canonical.reason}`);
      const target = canonical.value.canonicalUrl;

      const res = await transport(target, { signal, headers });

      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (!location) throw new FetchError("BAD_STATUS", "Redirect without location", res.status);
        if (redirects >= policy.maxRedirects) throw new FetchError("TOO_MANY_REDIRECTS", "Too many redirects");
        current = new URL(location, target).toString();
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel();
        throw new FetchError("BAD_STATUS", `HTTP ${res.status}`, res.status);
      }

      const rawType = res.headers.get("content-type") ?? "";
      const mime = (rawType.split(";")[0] ?? "").trim().toLowerCase();
      if (policy.allowedContentTypes && !policy.allowedContentTypes.includes(mime)) {
        await res.body?.cancel();
        throw new FetchError("UNSUPPORTED_CONTENT_TYPE", `Unsupported content type: ${mime || "none"}`, res.status);
      }

      const declaredLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > policy.maxBytes) {
        await res.body?.cancel();
        throw new FetchError("TOO_LARGE", "Response exceeds size limit", res.status);
      }

      const body = await readLimited(res.body, policy.maxBytes);
      return {
        requestedUrl: url,
        finalUrl: target,
        status: res.status,
        contentType: mime,
        text: decode(body, rawType),
        bytes: body.byteLength,
      };
    }
  } catch (err) {
    if (err instanceof FetchError) throw err;
    if (hasCause(err, BlockedAddressError)) throw new FetchError("BLOCKED_ADDRESS", "Host resolves to a non-public address");
    if (signal.aborted) throw new FetchError("TIMEOUT", "Request timed out");
    throw new FetchError("NETWORK", "Network error");
  }
}

/** undici wraps connection errors (fetch failed -> cause -> ...). */
export function hasCause(err: unknown, type: new (...args: never[]) => Error): boolean {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current instanceof type) return true;
    // (cast: after the instanceof check TypeScript narrows `current` to never)
    current = (current as Error).cause;
  }
  return false;
}

async function readLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError("TOO_LARGE", "Response exceeds size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
