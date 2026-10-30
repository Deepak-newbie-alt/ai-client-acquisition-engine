export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
}

/**
 * Retrieves public HTML for the research pipeline. Implementations must apply
 * SSRF protection; the pipeline treats everything returned as untrusted.
 * Errors are thrown as FetchError.
 */
export interface PageFetcher {
  isAllowedByRobots(url: string): Promise<boolean>;
  fetchHtml(url: string): Promise<FetchedPage>;
}

/** Creates a fetcher for one research run (robots.txt results are cached per run). */
export type PageFetcherFactory = () => PageFetcher;
