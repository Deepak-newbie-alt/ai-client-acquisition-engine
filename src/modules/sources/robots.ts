import { createRequire } from "node:module";
import { FetchError, fetchPublicDocument, type FetchPolicy, type HttpTransport } from "../../lib/safe-fetch.js";

// robots-parser is CommonJS and its bundled typings are malformed (a stray
// ambient `declare module`), so the small surface used here is typed locally.
type RobotsParserFn = (url: string, contents: string) => { isAllowed(url: string, ua?: string): boolean | undefined };
const robotsParser = createRequire(import.meta.url)("robots-parser") as RobotsParserFn;

export const ROBOTS_POLICY = {
  timeoutMs: 5_000,
  // RFC 9309 requires parsing at least 500 KiB.
  maxBytes: 512 * 1024,
  maxRedirects: 5,
  allowedContentTypes: null,
  accept: "text/plain, */*;q=0.1",
} as const satisfies Omit<FetchPolicy, "userAgent">;

/**
 * Per-origin robots.txt checks with RFC 9309 semantics: a 4xx response means
 * no restrictions; a 5xx or unreachable robots.txt means everything is
 * disallowed. Results are cached for the lifetime of the checker (one run).
 */
export class RobotsChecker {
  private readonly cache = new Map<string, Promise<(url: string) => boolean>>();

  constructor(
    private readonly transport: HttpTransport,
    private readonly userAgent: string,
    private readonly productToken: string,
  ) {}

  async isAllowed(url: string): Promise<boolean> {
    const origin = new URL(url).origin;
    let rules = this.cache.get(origin);
    if (!rules) {
      rules = this.load(origin);
      this.cache.set(origin, rules);
    }
    return (await rules)(url);
  }

  private async load(origin: string): Promise<(url: string) => boolean> {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const doc = await fetchPublicDocument(robotsUrl, this.transport, {
        ...ROBOTS_POLICY,
        userAgent: this.userAgent,
      });
      const robot = robotsParser(robotsUrl, doc.text);
      return (url) => robot.isAllowed(url, this.productToken) !== false;
    } catch (err) {
      if (err instanceof FetchError && err.code === "BAD_STATUS" && err.status && err.status >= 400 && err.status < 500) {
        return () => true;
      }
      return () => false;
    }
  }
}
