import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { sanitizeAuditMetadata } from "../../src/modules/audit/audit.js";
import { hashPassword, verifyPassword } from "../../src/modules/auth/password.js";
import { monthStartUtc } from "../../src/modules/research/budget.js";
import { ResearchQueue } from "../../src/modules/research/queue.js";
import { buildSearchQuery, createResearchRunSchema } from "../../src/modules/research/schemas.js";

describe("research request schema", () => {
  const schema = createResearchRunSchema(20);
  const valid = { industry: "HVAC services", country: "gb", keywords: ["scheduling"], resultLimit: 10 };

  it("normalizes valid requests", () => {
    expect(schema.parse(valid)).toEqual({ ...valid, country: "GB" });
    expect(schema.parse({ ...valid, keywords: undefined }).keywords).toEqual([]);
  });

  it.each([
    ["result limit above the configured cap", { resultLimit: 21 }],
    ["zero results", { resultLimit: 0 }],
    ["non-integer limit", { resultLimit: 2.5 }],
    ["country name instead of code", { country: "United Kingdom" }],
    ["unknown company size", { companySize: "huge" }],
    ["too many keywords", { keywords: Array.from({ length: 11 }, (_, i) => `kw${i}`) }],
    ["control characters", { industry: "HVAC\u0000" }],
    ["unknown fields", { sendEmails: true }],
  ])("rejects %s", (_label, change) => {
    expect(schema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});

describe("buildSearchQuery", () => {
  it("is deterministic and strips search operators from user text", () => {
    const query = buildSearchQuery({
      industry: 'plumbing" OR site:internal',
      country: "GB",
      companySize: "11-50",
      keywords: ["(invoicing)", "dispatch"],
    });
    expect(query).toBe(
      "plumbing OR site internal small business 11-50 employees invoicing dispatch manual process OR time-consuming OR spreadsheet OR paperwork country GB",
    );
    expect(query).not.toMatch(/["():]/);
  });
});

describe("monthStartUtc", () => {
  it("returns the first instant of the UTC month", () => {
    expect(monthStartUtc(new Date("2026-03-31T23:59:59Z")).toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("ResearchQueue", () => {
  it("runs jobs one at a time, in order, surviving failures", async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const queue = new ResearchQueue(async (id) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      order.push(id);
      concurrent--;
      if (id === "b") throw new Error("boom");
    }, pino({ level: "silent" }));

    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("a"); // already running: ignored
    queue.enqueue("c");
    await queue.onIdle();
    expect(order).toEqual(["a", "b", "c"]);
    expect(maxConcurrent).toBe(1);
  });
});

describe("sanitizeAuditMetadata", () => {
  it("drops credential-like keys and non-primitive values", () => {
    expect(
      sanitizeAuditMetadata({
        industry: "HVAC",
        count: 3,
        cost: 12n,
        apiKey: "sk-123",
        password: "hunter2",
        sessionToken: "abc",
        nested: { secret: "x" },
        long: "x".repeat(600),
      }),
    ).toEqual({ industry: "HVAC", count: 3, cost: "12", long: `${"x".repeat(500)}…` });
  });
});

describe("password hashing", () => {
  const fast = { N: 2 ** 10, r: 8, p: 1 };

  it("verifies the right password only", async () => {
    const hash = await hashPassword("correct horse battery", fast);
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
  });

  it("rejects short passwords and tampered parameters", async () => {
    await expect(hashPassword("short", fast)).rejects.toThrow();
    const hash = await hashPassword("correct horse battery", fast);
    expect(await verifyPassword("correct horse battery", hash.replace("$1024$", "$1073741824$"))).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});
