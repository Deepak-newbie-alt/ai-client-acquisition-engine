import { describe, expect, it } from "vitest";
import { canonicalizeUrl, dedupeUrls, MAX_URL_LENGTH, type UrlRejectReason } from "../../src/lib/url.js";

const canonical = (input: string) => {
  const r = canonicalizeUrl(input);
  if (!r.ok) throw new Error(`expected ${input} to be accepted, got ${r.reason}`);
  return r.value;
};

describe("canonicalizeUrl", () => {
  it.each([
    ["HTTPS://WWW.Example.COM/Path", "https://www.example.com/Path"],
    ["https://example.com/a/#section", "https://example.com/a"],
    ["https://example.com/a///", "https://example.com/a"],
    ["https://example.com", "https://example.com/"],
    ["https://example.com:443/x", "https://example.com/x"],
    ["http://example.com:80/x", "http://example.com/x"],
    ["https://example.com./x", "https://example.com/x"],
    ["https://example.com/a/../b/./c", "https://example.com/b/c"],
    ["  https://example.com/x  ", "https://example.com/x"],
    ["https://example.com/?b=2&a=1&a=0", "https://example.com/?a=0&a=1&b=2"],
    [
      "https://example.com/p?utm_source=x&UTM_Medium=y&gclid=1&fbclid=2&id=7",
      "https://example.com/p?id=7",
    ],
    ["https://bücher.de/katalog", "https://xn--bcher-kva.de/katalog"],
  ])("canonicalizes %s", (input, expected) => {
    expect(canonical(input).canonicalUrl).toBe(expected);
  });

  it("derives the registrable domain using the public suffix list", () => {
    expect(canonical("https://shop.blog.example.co.uk/x").registrableDomain).toBe("example.co.uk");
    expect(canonical("https://www.example.com/").hostname).toBe("www.example.com");
  });

  it.each<[string, UrlRejectReason]>([
    ["not a url", "INVALID_URL"],
    ["", "INVALID_URL"],
    ["https://exa\nmple.com/", "INVALID_URL"],
    ["https://example.com/\tpath", "INVALID_URL"],
    ["https://example.com/a b", "INVALID_URL"],
    ["javascript:alert(1)", "UNSUPPORTED_SCHEME"],
    ["file:///etc/passwd", "UNSUPPORTED_SCHEME"],
    ["ftp://example.com/file", "UNSUPPORTED_SCHEME"],
    ["data:text/html,<script>alert(1)</script>", "UNSUPPORTED_SCHEME"],
    ["gopher://example.com:70/", "UNSUPPORTED_SCHEME"],
    ["https://user:pass@example.com/", "CREDENTIALS_NOT_ALLOWED"],
    ["https://example.com@169.254.169.254/", "CREDENTIALS_NOT_ALLOWED"],
    ["https://example.com:8080/", "PORT_NOT_ALLOWED"],
    ["http://example.com:443/", "PORT_NOT_ALLOWED"],
    ["http://127.0.0.1/", "IP_LITERAL_NOT_ALLOWED"],
    ["http://169.254.169.254/latest/meta-data/", "IP_LITERAL_NOT_ALLOWED"],
    ["http://2130706433/", "IP_LITERAL_NOT_ALLOWED"],
    ["http://0x7f.1/", "IP_LITERAL_NOT_ALLOWED"],
    ["http://017700000001/", "IP_LITERAL_NOT_ALLOWED"],
    ["http://127.1/", "IP_LITERAL_NOT_ALLOWED"],
    ["http://8.8.8.8/", "IP_LITERAL_NOT_ALLOWED"],
    ["http://[::1]/", "IP_LITERAL_NOT_ALLOWED"],
    ["http://[::ffff:127.0.0.1]/", "IP_LITERAL_NOT_ALLOWED"],
    ["http://[fd00:ec2::254]/", "IP_LITERAL_NOT_ALLOWED"],
    ["http://localhost/", "BLOCKED_HOSTNAME"],
    ["http://LOCALHOST./", "BLOCKED_HOSTNAME"],
    ["http://app.localhost/", "BLOCKED_HOSTNAME"],
    ["http://metadata.google.internal/", "BLOCKED_HOSTNAME"],
    ["http://printer.local/", "BLOCKED_HOSTNAME"],
    ["http://router.home.arpa/", "BLOCKED_HOSTNAME"],
    ["http://intranet/", "NO_PUBLIC_SUFFIX"],
    ["http://co.uk/", "NO_PUBLIC_SUFFIX"],
    ["http://example.invalid/", "NO_PUBLIC_SUFFIX"],
    ["http://service.corp/", "NO_PUBLIC_SUFFIX"],
    [`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`, "TOO_LONG"],
  ])("rejects %s", (input, reason) => {
    expect(canonicalizeUrl(input)).toEqual({ ok: false, reason });
  });
});

describe("dedupeUrls", () => {
  it("separates fresh, known, duplicate and rejected URLs, preserving order", () => {
    const result = dedupeUrls(
      [
        "https://a.example.com/x?utm_source=feed",
        "https://b.example.com/",
        "https://A.example.com/x#top",
        "http://localhost/",
        "https://known.example.org/page/",
        "https://c.example.net/",
      ],
      new Set(["https://known.example.org/page"]),
    );

    expect(result.fresh.map((u) => u.canonicalUrl)).toEqual([
      "https://a.example.com/x",
      "https://b.example.com/",
      "https://c.example.net/",
    ]);
    expect(result.known.map((u) => u.canonicalUrl)).toEqual(["https://known.example.org/page"]);
    expect(result.duplicates).toEqual([
      { input: "https://A.example.com/x#top", canonicalUrl: "https://a.example.com/x" },
    ]);
    expect(result.rejected).toEqual([{ input: "http://localhost/", reason: "BLOCKED_HOSTNAME" }]);
  });

  it("treats http and https as distinct URLs (content hashing catches copies later)", () => {
    const result = dedupeUrls(["http://example.com/a", "https://example.com/a"]);
    expect(result.fresh).toHaveLength(2);
  });
});
