import type { AppConfig } from "../config/env.js";
import { AnthropicLlmProvider } from "./llm/anthropic.js";
import { MockLlmProvider } from "./llm/mock.js";
import type { LlmProvider } from "./llm/types.js";
import { MockSearchProvider } from "./search/mock.js";
import { TavilySearchProvider } from "./search/tavily.js";
import type { SearchProvider } from "./search/types.js";
import { createFixturePageFetcherFactory } from "./web/fixtures.js";
import { createHttpPageFetcherFactory } from "./web/http.js";
import type { PageFetcherFactory } from "./web/types.js";

export interface Integrations {
  search: SearchProvider;
  llm: LlmProvider;
  pages: PageFetcherFactory;
}

export function createIntegrations(config: AppConfig): Integrations {
  const search: SearchProvider =
    config.search.provider === "tavily"
      ? new TavilySearchProvider({
          apiKey: config.search.apiKey,
          depth: config.search.depth,
          usdPerCredit: config.search.usdPerCredit,
        })
      : new MockSearchProvider();

  const llm: LlmProvider =
    config.llm.provider === "anthropic"
      ? new AnthropicLlmProvider({
          apiKey: config.llm.apiKey,
          model: config.llm.model,
          effort: config.llm.effort,
          pricing: config.llm.pricing,
        })
      : new MockLlmProvider();

  return {
    search,
    llm,
    pages: config.pageFetcher === "http" ? createHttpPageFetcherFactory() : createFixturePageFetcherFactory(),
  };
}
