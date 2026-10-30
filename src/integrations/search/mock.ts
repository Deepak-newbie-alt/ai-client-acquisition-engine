import { FIXTURE_SEARCH_HITS } from "../mock-fixtures.js";
import type { SearchHit, SearchProvider, SearchRequest } from "./types.js";

export interface MockSearchOptions {
  hits?: readonly SearchHit[] | ((request: SearchRequest) => readonly SearchHit[]);
  costMicros?: bigint;
  fail?: boolean;
}

export class MockSearchProvider implements SearchProvider {
  readonly name = "mock";
  readonly requests: SearchRequest[] = [];

  constructor(private readonly options: MockSearchOptions = {}) {}

  estimateCostMicros(): bigint {
    return this.options.costMicros ?? 0n;
  }

  search(request: SearchRequest) {
    this.requests.push(request);
    if (this.options.fail) return Promise.reject(new Error("mock search failure"));
    const hits = typeof this.options.hits === "function" ? this.options.hits(request) : (this.options.hits ?? FIXTURE_SEARCH_HITS);
    return Promise.resolve({ hits: hits.slice(0, request.maxResults), costMicros: this.options.costMicros ?? 0n });
  }
}
