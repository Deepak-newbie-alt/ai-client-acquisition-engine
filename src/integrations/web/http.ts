import { createSafeTransport, fetchPublicDocument, type HttpTransport } from "../../lib/safe-fetch.js";
import { RobotsChecker } from "../../modules/sources/robots.js";
import type { PageFetcherFactory } from "./types.js";

export const PRODUCT_TOKEN = "ACEResearchBot";
export const USER_AGENT = `${PRODUCT_TOKEN}/0.1 (personal business research; respects robots.txt)`;

export const PAGE_POLICY = {
  timeoutMs: 10_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  allowedContentTypes: ["text/html", "application/xhtml+xml"],
  userAgent: USER_AGENT,
  accept: "text/html, application/xhtml+xml;q=0.9",
} as const;

export function createHttpPageFetcherFactory(transport: HttpTransport = createSafeTransport()): PageFetcherFactory {
  return () => {
    const robots = new RobotsChecker(transport, USER_AGENT, PRODUCT_TOKEN);
    return {
      isAllowedByRobots: (url) => robots.isAllowed(url),
      fetchHtml: async (url) => {
        const doc = await fetchPublicDocument(url, transport, PAGE_POLICY);
        return { finalUrl: doc.finalUrl, status: doc.status, contentType: doc.contentType, html: doc.text };
      },
    };
  };
}
