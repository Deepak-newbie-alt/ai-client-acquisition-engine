export interface SearchRequest {
  query: string;
  maxResults: number;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  signal?: AbortSignal;
}

export interface SearchHit {
  url: string;
  title: string | null;
  snippet: string | null;
  score: number | null;
}

export interface SearchResponse {
  hits: SearchHit[];
  /** Actual cost in millionths of a US dollar. */
  costMicros: bigint;
}

export interface SearchProvider {
  readonly name: string;
  /** Upper-bound cost of one search call, used to reserve budget before calling. */
  estimateCostMicros(request: SearchRequest): bigint;
  search(request: SearchRequest): Promise<SearchResponse>;
}

export class SearchProviderError extends Error {
  constructor(
    readonly code: "AUTH" | "QUOTA" | "BAD_REQUEST" | "RATE_LIMITED" | "UNAVAILABLE" | "INVALID_RESPONSE",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}
