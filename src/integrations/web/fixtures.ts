import { FetchError } from "../../lib/safe-fetch.js";
import { canonicalizeUrl } from "../../lib/url.js";
import { FIXTURE_PAGES, FIXTURE_ROBOTS_DISALLOWED_PREFIXES } from "../mock-fixtures.js";
import { PAGE_POLICY } from "./http.js";
import type { PageFetcher, PageFetcherFactory } from "./types.js";

type Pages = Readonly<Record<string, { status?: number; contentType?: string; html: string }>>;

/**
 * Offline page fetcher backed by fixtures. It applies the same URL validation
 * and content-type rules as the HTTP fetcher but never touches the network.
 */
export function createFixturePageFetcherFactory(
  pages: Pages = FIXTURE_PAGES,
  robotsDisallowed: readonly string[] = FIXTURE_ROBOTS_DISALLOWED_PREFIXES,
): PageFetcherFactory {
  const fetcher: PageFetcher = {
    isAllowedByRobots: (url) => Promise.resolve(!robotsDisallowed.some((prefix) => url.startsWith(prefix))),
    fetchHtml: (url) => {
      const canonical = canonicalizeUrl(url);
      if (!canonical.ok) return Promise.reject(new FetchError("BLOCKED_URL", `URL rejected: ${canonical.reason}`));
      const fixture = pages[canonical.value.canonicalUrl];
      if (!fixture) return Promise.reject(new FetchError("BAD_STATUS", "HTTP 404", 404));
      const status = fixture.status ?? 200;
      if (status < 200 || status >= 300) return Promise.reject(new FetchError("BAD_STATUS", `HTTP ${status}`, status));
      const contentType = fixture.contentType ?? "text/html";
      if (!(PAGE_POLICY.allowedContentTypes as readonly string[]).includes(contentType)) {
        return Promise.reject(new FetchError("UNSUPPORTED_CONTENT_TYPE", `Unsupported content type: ${contentType}`));
      }
      return Promise.resolve({ finalUrl: canonical.value.canonicalUrl, status, contentType, html: fixture.html });
    },
  };
  return () => fetcher;
}
