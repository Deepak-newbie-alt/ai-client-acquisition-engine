import { describe, expect, it } from "vitest";
import { tavilyCountry, TavilySearchProvider } from "../../src/integrations/search/tavily.js";
import { SearchProviderError } from "../../src/integrations/search/types.js";

const API_KEY = "tvly-test-key-should-never-leak";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

function fakeTavily(...replies: Reply[]) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers }),
    );
  };
  return { calls, fetch: fetchImpl };
}

const ok = (results: unknown[] = [], credits: number | null = 1) => ({
  body: { query: "q", results, response_time: 1.2, ...(credits === null ? {} : { usage: { credits } }) },
});

function provider(fetchImpl: typeof fetch, depth: "basic" | "advanced" = "basic") {
  const sleeps: number[] = [];
  const p = new TavilySearchProvider({
    apiKey: API_KEY,
    depth,
    usdPerCredit: 0.008,
    fetch: fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return Object.assign(p, { sleeps });
}

const request = { query: "hvac scheduling", maxResults: 40, country: "GB" };

const failure = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SearchProviderError);
  return err as SearchProviderError;
};

describe("TavilySearchProvider", () => {
  it("requests snippets only, caps results, and maps hits and cost", async () => {
    const api = fakeTavily(
      ok([
        { url: "https://example.com/a", title: "A", content: "snippet", score: 0.9, raw_content: null },
        { url: "https://example.org/b", title: null, content: null, score: null },
      ]),
    );
    const response = await provider(api.fetch).search(request);

    expect(response).toEqual({
      hits: [
        { url: "https://example.com/a", title: "A", snippet: "snippet", score: 0.9 },
        { url: "https://example.org/b", title: null, snippet: null, score: null },
      ],
      costMicros: 8_000n,
    });
    const [call] = api.calls;
    expect(call?.url).toBe("https://api.tavily.com/search");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call?.body).toEqual({
      query: "hvac scheduling",
      max_results: 20,
      search_depth: "basic",
      topic: "general",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: true,
      country: "united kingdom",
    });
  });

  it("charges by reported credits, falling back to the depth's list cost", async () => {
    expect((await provider(fakeTavily(ok([], 2)).fetch).search(request)).costMicros).toBe(16_000n);
    expect((await provider(fakeTavily(ok([], null)).fetch, "advanced").search(request)).costMicros).toBe(16_000n);
    expect(provider(fakeTavily().fetch, "advanced").estimateCostMicros()).toBe(16_000n);
  });

  it("retries 429 (honouring Retry-After) and 5xx, then succeeds", async () => {
    const api = fakeTavily({ status: 429, headers: { "retry-after": "2" } }, { status: 503 }, ok());
    const p = provider(api.fetch);
    await expect(p.search(request)).resolves.toMatchObject({ hits: [] });
    expect(api.calls).toHaveLength(3);
    expect(p.sleeps[0]).toBe(2_000);
  });

  it("retries network errors, then fails without leaking the key", async () => {
    const api = fakeTavily(new TypeError("fetch failed"));
    const err = await failure(provider(api.fetch).search(request));
    expect(err.code).toBe("UNAVAILABLE");
    expect(api.calls).toHaveLength(3);
    expect(err.message).not.toContain(API_KEY);
  });

  it.each([
    [401, "AUTH"],
    [432, "QUOTA"],
    [433, "QUOTA"],
  ])("does not retry HTTP %s (%s)", async (status, code) => {
    const api = fakeTavily({ status, body: { detail: { error: `bad key ${API_KEY}` } } });
    const err = await failure(provider(api.fetch).search(request));
    expect(err).toMatchObject({ code, status });
    expect(err.message).not.toContain(API_KEY);
    expect(api.calls).toHaveLength(1);
  });

  it("retries once without the country when Tavily rejects the request", async () => {
    const api = fakeTavily({ status: 422 }, ok());
    await expect(provider(api.fetch).search(request)).resolves.toMatchObject({ hits: [] });
    expect(api.calls[0]?.body).toHaveProperty("country", "united kingdom");
    expect(api.calls[1]?.body).not.toHaveProperty("country");
  });

  it("rejects responses with an unexpected shape", async () => {
    const api = fakeTavily({ body: { results: "not-an-array" } });
    expect((await failure(provider(api.fetch).search(request))).code).toBe("INVALID_RESPONSE");
  });
});

describe("tavilyCountry", () => {
  it("maps ISO codes to lowercase English names", () => {
    expect(tavilyCountry("gb")).toBe("united kingdom");
    expect(tavilyCountry("DE")).toBe("germany");
    expect(tavilyCountry("US")).toBe("united states");
  });
});
