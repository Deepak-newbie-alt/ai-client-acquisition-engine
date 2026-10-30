import ipaddr from "ipaddr.js";
import { parse as parseDomain } from "tldts";

export const MAX_URL_LENGTH = 2048;

export type UrlRejectReason =
  | "INVALID_URL"
  | "TOO_LONG"
  | "UNSUPPORTED_SCHEME"
  | "CREDENTIALS_NOT_ALLOWED"
  | "PORT_NOT_ALLOWED"
  | "IP_LITERAL_NOT_ALLOWED"
  | "BLOCKED_HOSTNAME"
  | "NO_PUBLIC_SUFFIX";

export interface CanonicalUrl {
  canonicalUrl: string;
  hostname: string;
  registrableDomain: string;
}

export type CanonicalizeResult =
  | { ok: true; value: CanonicalUrl }
  | { ok: false; reason: UrlRejectReason };

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"];

const TRACKING_PARAMS = new Set([
  "gclid",
  "dclid",
  "fbclid",
  "msclkid",
  "yclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "ref_src",
]);

const isTrackingParam = (key: string) => {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || TRACKING_PARAMS.has(k);
};

// Rejects ASCII control characters and whitespace. The WHATWG parser silently
// strips tabs and newlines, which would let "exa\nmple.com" pass as example.com.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000- \u007f]/;

/**
 * Validates a URL as a candidate public web source and returns its canonical
 * form. This is a syntactic check only; DNS-level SSRF protection happens at
 * fetch time (see network.ts), including on every redirect.
 */
export function canonicalizeUrl(input: string): CanonicalizeResult {
  const trimmed = input.trim();
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: "TOO_LONG" };
  if (trimmed === "" || UNSAFE_CHARS.test(trimmed)) return { ok: false, reason: "INVALID_URL" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "INVALID_URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "UNSUPPORTED_SCHEME" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "CREDENTIALS_NOT_ALLOWED" };
  }
  // The parser clears default ports, so any remaining port is non-standard.
  if (url.port !== "") return { ok: false, reason: "PORT_NOT_ALLOWED" };

  const hostname = url.hostname.replace(/\.$/, "");
  // The parser normalizes decimal, octal and hex IPv4 forms to dotted quads.
  if (hostname.startsWith("[") || ipaddr.isValid(hostname)) {
    return { ok: false, reason: "IP_LITERAL_NOT_ALLOWED" };
  }
  if (hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    return { ok: false, reason: "BLOCKED_HOSTNAME" };
  }

  const parsed = parseDomain(hostname, { allowPrivateDomains: false });
  if (!parsed.domain || !parsed.isIcann || parsed.hostname !== hostname) {
    return { ok: false, reason: "NO_PUBLIC_SUFFIX" };
  }

  url.hostname = hostname;
  url.hash = "";

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !isTrackingParam(key))
    .sort(([ak, av], [bk, bv]) => (ak === bk ? cmp(av, bv) : cmp(ak, bk)));
  url.search = new URLSearchParams(params).toString();

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }

  return {
    ok: true,
    value: { canonicalUrl: url.toString(), hostname, registrableDomain: parsed.domain },
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface DedupeResult {
  /** Valid URLs not seen before, in input order. */
  fresh: CanonicalUrl[];
  /** Valid URLs whose canonical form is already a stored source. */
  known: CanonicalUrl[];
  /** Inputs that canonicalized to a URL already present earlier in the batch. */
  duplicates: { input: string; canonicalUrl: string }[];
  rejected: { input: string; reason: UrlRejectReason }[];
}

export function dedupeUrls(
  inputs: readonly string[],
  knownCanonicalUrls: ReadonlySet<string> = new Set(),
): DedupeResult {
  const result: DedupeResult = { fresh: [], known: [], duplicates: [], rejected: [] };
  const seen = new Set<string>();

  for (const input of inputs) {
    const r = canonicalizeUrl(input);
    if (!r.ok) {
      result.rejected.push({ input, reason: r.reason });
      continue;
    }
    const { canonicalUrl } = r.value;
    if (seen.has(canonicalUrl)) {
      result.duplicates.push({ input, canonicalUrl });
      continue;
    }
    seen.add(canonicalUrl);
    (knownCanonicalUrls.has(canonicalUrl) ? result.known : result.fresh).push(r.value);
  }
  return result;
}
