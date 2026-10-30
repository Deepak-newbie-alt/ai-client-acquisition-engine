import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ReadableStream } from "node:stream/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlockedAddressError } from "../../src/lib/network.js";
import {
  createSafeLookup,
  createSafeTransport,
  fetchPublicDocument,
  FetchError,
  hasCause,
  type FetchPolicy,
  type HttpTransport,
} from "../../src/lib/safe-fetch.js";

const policy: FetchPolicy = {
  timeoutMs: 1_000,
  maxBytes: 1_000,
  maxRedirects: 2,
  allowedContentTypes: ["text/html"],
  userAgent: "test-agent",
  accept: "text/html",
};

interface FakeRoute {
  status?: number;
  headers?: Record<string, string>;
  chunks?: string[];
}

function fakeTransport(routes: Record<string, FakeRoute>): HttpTransport & { calls: string[] } {
  const calls: string[] = [];
  const transport = (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return Promise.reject(new Error(`unexpected request to ${url}`));
    const encoder = new TextEncoder();
    return Promise.resolve({
      status: route.status ?? 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8", ...route.headers }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of route.chunks ?? ["<p>ok</p>"]) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
    });
  };
  return Object.assign(transport, { calls });
}

const expectFetchError = async (promise: Promise<unknown>, code: string) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(FetchError);
  expect((err as FetchError).code).toBe(code);
};

describe("fetchPublicDocument", () => {
  it("returns decoded text for an allowed HTML page", async () => {
    const transport = fakeTransport({ "https://example.com/a": { chunks: ["<p>caf", "é</p>"] } });
    const doc = await fetchPublicDocument("https://example.com/a?utm_source=x", transport, policy);
    expect(doc).toMatchObject({ finalUrl: "https://example.com/a", status: 200, contentType: "text/html", text: "<p>café</p>" });
    expect(transport.calls).toEqual(["https://example.com/a"]);
  });

  it("follows relative redirects and revalidates each hop", async () => {
    const transport = fakeTransport({
      "https://example.com/old": { status: 301, headers: { location: "/new" } },
      "https://example.com/new": {},
    });
    const doc = await fetchPublicDocument("https://example.com/old", transport, policy);
    expect(doc.finalUrl).toBe("https://example.com/new");
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1/admin",
    "http://localhost:8080/",
    "http://[::1]/",
    "file:///etc/passwd",
  ])("refuses a redirect to %s without requesting it", async (location) => {
    const transport = fakeTransport({ "https://example.com/r": { status: 302, headers: { location } } });
    await expectFetchError(fetchPublicDocument("https://example.com/r", transport, policy), "BLOCKED_URL");
    expect(transport.calls).toEqual(["https://example.com/r"]);
  });

  it("refuses a blocked initial URL without any request", async () => {
    const transport = fakeTransport({});
    await expectFetchError(fetchPublicDocument("http://10.0.0.1/", transport, policy), "BLOCKED_URL");
    expect(transport.calls).toHaveLength(0);
  });

  it("limits the number of redirects", async () => {
    const transport = fakeTransport({
      "https://example.com/1": { status: 302, headers: { location: "/2" } },
      "https://example.com/2": { status: 302, headers: { location: "/3" } },
      "https://example.com/3": { status: 302, headers: { location: "/4" } },
    });
    await expectFetchError(fetchPublicDocument("https://example.com/1", transport, policy), "TOO_MANY_REDIRECTS");
  });

  it("rejects disallowed content types", async () => {
    const transport = fakeTransport({ "https://example.com/f": { headers: { "content-type": "application/pdf" } } });
    await expectFetchError(fetchPublicDocument("https://example.com/f", transport, policy), "UNSUPPORTED_CONTENT_TYPE");
  });

  it("rejects oversized bodies by header and while streaming", async () => {
    const declared = fakeTransport({ "https://example.com/big": { headers: { "content-length": "5000" } } });
    await expectFetchError(fetchPublicDocument("https://example.com/big", declared, policy), "TOO_LARGE");

    const streamed = fakeTransport({ "https://example.com/big": { chunks: ["x".repeat(600), "x".repeat(600)] } });
    await expectFetchError(fetchPublicDocument("https://example.com/big", streamed, policy), "TOO_LARGE");
  });

  it("reports non-2xx statuses with the status code", async () => {
    const transport = fakeTransport({ "https://example.com/missing": { status: 404 } });
    const err = await fetchPublicDocument("https://example.com/missing", transport, policy).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "BAD_STATUS", status: 404 });
  });

  it("times out slow responses", async () => {
    const slow: HttpTransport = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await expectFetchError(fetchPublicDocument("https://example.com/slow", slow, { ...policy, timeoutMs: 50 }), "TIMEOUT");
  });
});

describe("createSafeLookup", () => {
  const lookupOnce = (addresses: string[], options: { all?: boolean } = {}) =>
    new Promise<{ err: Error | null; address: unknown }>((resolve) => {
      const lookup = createSafeLookup(() =>
        Promise.resolve(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))),
      );
      lookup("host.example.com", options, (err, address) => resolve({ err, address }));
    });

  it("passes through public addresses", async () => {
    expect(await lookupOnce(["93.184.215.14"])).toEqual({ err: null, address: "93.184.215.14" });
    expect((await lookupOnce(["93.184.215.14"], { all: true })).address).toEqual([{ address: "93.184.215.14", family: 4 }]);
  });

  it("fails for private or mixed answers", async () => {
    expect((await lookupOnce(["10.0.0.5"])).err).toBeInstanceOf(BlockedAddressError);
    expect((await lookupOnce(["93.184.215.14", "169.254.169.254"])).err).toBeInstanceOf(BlockedAddressError);
  });
});

describe("createSafeTransport (real sockets)", () => {
  let server: Server;
  let port: number;
  let requests = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      requests++;
      res.end("should never be reached");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("never connects when DNS points a public-looking name at loopback", async () => {
    const transport = createSafeTransport({ resolver: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]) });
    const err = await transport(`http://rebind.example.com:${port}/`, {
      signal: AbortSignal.timeout(2_000),
      headers: {},
    }).catch((e: unknown) => e);
    expect(hasCause(err, BlockedAddressError)).toBe(true);
    expect(requests).toBe(0);
  });

  it("maps the blocked lookup to BLOCKED_ADDRESS through fetchPublicDocument", async () => {
    const transport = createSafeTransport({ resolver: () => Promise.resolve([{ address: "192.168.1.10", family: 4 }]) });
    await expectFetchError(fetchPublicDocument("https://intranet-looking.example.com/", transport, policy), "BLOCKED_ADDRESS");
  });
});
