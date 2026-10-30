import { z } from "zod";
import { SearchProviderError, type SearchProvider, type SearchRequest, type SearchResponse } from "./types.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_MAX_RESULTS = 20;
const CREDITS_PER_SEARCH = { basic: 1, advanced: 2 } as const;

export type TavilySearchDepth = keyof typeof CREDITS_PER_SEARCH;

export interface TavilyProviderOptions {
  apiKey: string;
  depth: TavilySearchDepth;
  usdPerCredit: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Test hooks. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const responseSchema = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      content: z.string().nullish(),
      score: z.number().nullish(),
    }),
  ),
  usage: z.object({ credits: z.number().nonnegative() }).nullish(),
});

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** Tavily expects lowercase English country names, e.g. "united kingdom". */
export function tavilyCountry(isoAlpha2: string): string | undefined {
  try {
    return regionNames.of(isoAlpha2.toUpperCase())?.toLowerCase();
  } catch {
    return undefined;
  }
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/**
 * Tavily Search behind the SearchProvider interface. Only snippet metadata is
 * requested (no raw content, answers or images); pages are fetched separately
 * through the SSRF-protected fetcher.
 */
export class TavilySearchProvider implements SearchProvider {
  readonly name = "tavily";
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TavilyProviderOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  estimateCostMicros(): bigint {
    return this.creditsToMicros(CREDITS_PER_SEARCH[this.options.depth]);
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const country = tavilyCountry(request.country);
    let response: Response;
    try {
      response = await this.post(this.body(request, country), request.signal);
    } catch (err) {
      // An unrecognised country name is the most likely cause of a 400/422;
      // retry once without it (the query text still names the country).
      if (!(err instanceof SearchProviderError && err.code === "BAD_REQUEST" && country)) throw err;
      response = await this.post(this.body(request, undefined), request.signal);
    }

    const parsed = responseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new SearchProviderError("INVALID_RESPONSE", "Tavily returned an unexpected response");

    const credits = parsed.data.usage?.credits ?? CREDITS_PER_SEARCH[this.options.depth];
    return {
      hits: parsed.data.results.map((r) => ({
        url: r.url,
        title: r.title ?? null,
        snippet: r.content ?? null,
        score: r.score ?? null,
      })),
      costMicros: this.creditsToMicros(credits),
    };
  }

  private body(request: SearchRequest, country: string | undefined) {
    return {
      query: request.query,
      max_results: Math.min(request.maxResults, TAVILY_MAX_RESULTS),
      search_depth: this.options.depth,
      topic: "general",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: true,
      ...(country ? { country } : {}),
    };
  }

  /** POST with bounded retries on 429, 5xx and network errors. */
  private async post(body: object, signal?: AbortSignal): Promise<Response> {
    const maxRetries = this.options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
      let response: Response;
      try {
        response = await this.fetchImpl(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
      } catch {
        if (signal?.aborted || attempt >= maxRetries) {
          throw new SearchProviderError("UNAVAILABLE", "Could not reach Tavily");
        }
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (response.ok) return response;
      await response.body?.cancel();
      if (RETRYABLE(response.status) && attempt < maxRetries) {
        await this.sleep(retryAfterMs(response) ?? backoffMs(attempt));
        continue;
      }
      throw errorForStatus(response.status);
    }
  }

  private creditsToMicros(credits: number): bigint {
    return BigInt(Math.ceil(credits * this.options.usdPerCredit * 1_000_000));
  }
}

const backoffMs = (attempt: number) => Math.min(500 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250);

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 10_000) : undefined;
}

function errorForStatus(status: number): SearchProviderError {
  if (status === 401 || status === 403) return new SearchProviderError("AUTH", "Tavily rejected the API key", status);
  if (status === 432 || status === 433) return new SearchProviderError("QUOTA", "Tavily plan or usage limit reached", status);
  if (status === 400 || status === 422) return new SearchProviderError("BAD_REQUEST", "Tavily rejected the request", status);
  if (status === 429) return new SearchProviderError("RATE_LIMITED", "Tavily rate limit reached", status);
  return new SearchProviderError("UNAVAILABLE", `Tavily error (HTTP ${status})`, status);
}
