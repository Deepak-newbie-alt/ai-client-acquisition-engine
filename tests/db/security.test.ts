import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../../src/app.js";
import { loadScoringConfig } from "../../src/config/scoring.js";
import { MockEmailProvider } from "../../src/integrations/email/mock.js";
import { MockLlmProvider } from "../../src/integrations/llm/mock.js";
import { createFixturePageFetcherFactory } from "../../src/integrations/web/fixtures.js";
import { createLogger } from "../../src/lib/logger.js";
import { createToken, createUser, silentLogger, TEST_PASSWORD, testConfig } from "./fixtures.js";
import { createTestDb, resetDb } from "./test-database.js";

const db = createTestDb();
const CSRF = { "x-ace-csrf": "1" };

function makeApp(overrides: Partial<AppDeps> = {}, env: Record<string, string> = {}) {
  return createApp({
    config: testConfig(env),
    db,
    logger: silentLogger,
    researchQueue: { enqueue: () => undefined },
    rateLimits: { loginPer15Min: 1_000, researchCreatePerHour: 1_000 },
    scoring: loadScoringConfig(),
    pages: createFixturePageFetcherFactory(),
    email: new MockEmailProvider(),
    llm: new MockLlmProvider(),
    ...overrides,
  });
}

const PRODUCTION = { NODE_ENV: "production", APP_ORIGIN: "https://ace.example.com" };

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

describe("HTTP hardening", () => {
  it("sends security headers and hides the framework", async () => {
    const res = await request(makeApp()).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
    // HTTPS-only headers are left out on plain-http development servers.
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  });

  it("enables HSTS and Secure session cookies in production", async () => {
    await createUser(db);
    const app = makeApp({}, PRODUCTION);
    const health = await request(app).get("/api/health");
    expect(health.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(health.headers["content-security-policy"]).toContain("upgrade-insecure-requests");

    const login = await request(app)
      .post("/api/auth/login")
      .set({ ...CSRF, origin: "https://ace.example.com" })
      .send({ email: "admin@example.com", password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    const cookie = String(login.headers["set-cookie"]);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it("refuses oversized and non-JSON bodies without echoing them", async () => {
    const app = makeApp();
    const big = await request(app)
      .post("/api/auth/login")
      .set(CSRF)
      .set("content-type", "application/json")
      .send(JSON.stringify({ email: "a@example.com", password: "x".repeat(200_000) }));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: { code: "INVALID_BODY", message: "Request body could not be read" } });

    const text = await request(app).post("/api/auth/login").set(CSRF).set("content-type", "text/plain").send("<script>");
    expect(text.status).toBe(400);
    expect(JSON.stringify(text.body)).not.toContain("<script>");
  });

  it("returns a generic 500 and logs the error without secrets", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    // An HTTP-client-style error carrying its request config, as SDK errors do.
    const failure = Object.assign(new Error("database exploded"), {
      config: { headers: { authorization: "Bearer sk-very-secret" } },
      apiKey: "sk-very-secret",
    });
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "researchRun") return { findMany: () => Promise.reject(failure) };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const token = await createToken(db, ["research:read"]);

    const res = await request(makeApp({ db: failingDb, logger: createLogger("error", sink) }))
      .get("/api/research-runs")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });

    const log = lines.join("");
    expect(log).toContain("database exploded");
    expect(log).not.toContain("sk-very-secret");
    expect(log).not.toContain(token);
  });
});

describe("authorization boundaries", () => {
  it("keeps service tokens away from people, outreach and audit data, whatever their scopes", async () => {
    const token = await createToken(db, ["research:read", "research:write", "outreach:sync"]);
    const app = makeApp();
    for (const path of ["/api/companies", "/api/contacts/00000000-0000-4000-8000-000000000000", "/api/outreach/drafts", "/api/audit-events", "/api/suppressions", "/api/auth/me"]) {
      const res = await request(app).get(path).set("authorization", `Bearer ${token}`);
      expect(res.status, path).toBe(403);
    }
    const send = await request(app)
      .post("/api/outreach/drafts/00000000-0000-4000-8000-000000000000/send")
      .set("authorization", `Bearer ${token}`);
    expect(send.status).toBe(403);
  });

  it("rejects malformed and unknown bearer tokens instead of treating them as anonymous", async () => {
    const app = makeApp();
    for (const header of ["Bearer", "Bearer ace_st_not-a-real-token", "Basic YWRtaW46eA==", "Bearer a b"]) {
      const res = await request(app).get("/api/research-runs").set("authorization", header);
      expect(res.status, header).toBe(401);
    }
  });
});

describe("usage budget visibility", () => {
  it("reports this month's spend against the configured limits", async () => {
    await db.usageEvent.createMany({
      data: [
        { kind: "SEARCH", provider: "tavily", operation: "search", costMicros: 8_000n },
        { kind: "LLM", provider: "anthropic", operation: "extract_evidence", costMicros: 42_000n },
        // Last month's usage does not count.
        { kind: "LLM", provider: "anthropic", operation: "extract_evidence", costMicros: 9_000_000n, createdAt: new Date(Date.UTC(2000, 0, 1)) },
      ],
    });
    const token = await createToken(db, ["research:read"]);
    const res = await request(makeApp()).get("/api/usage").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ spentMicros: "50000", monthlyBudgetMicros: "10000000", runBudgetMicros: "1000000" });
    expect(res.body.byKind).toEqual(
      expect.arrayContaining([
        { kind: "SEARCH", costMicros: "8000" },
        { kind: "LLM", costMicros: "42000" },
      ]),
    );
    expect((await request(makeApp()).get("/api/usage")).status).toBe(401);
  });
});

describe("rate limits behind a reverse proxy", () => {
  const attempt = (app: ReturnType<typeof makeApp>, ip: string) =>
    request(app).post("/api/auth/login").set(CSRF).set("x-forwarded-for", ip).send({ email: "x@example.com", password: "wrong" });

  it("limits per client IP when TRUST_PROXY is set", async () => {
    const app = makeApp({ rateLimits: { loginPer15Min: 2 } }, { TRUST_PROXY: "1" });
    expect((await attempt(app, "203.0.113.1")).status).toBe(401);
    expect((await attempt(app, "203.0.113.1")).status).toBe(401);
    expect((await attempt(app, "203.0.113.1")).status).toBe(429);
    // A different client is not locked out by someone else's attempts.
    expect((await attempt(app, "203.0.113.2")).status).toBe(401);
  });

  it("ignores spoofed X-Forwarded-For when the API is reached directly", async () => {
    const app = makeApp({ rateLimits: { loginPer15Min: 2 } });
    expect((await attempt(app, "203.0.113.1")).status).toBe(401);
    expect((await attempt(app, "203.0.113.2")).status).toBe(401);
    expect((await attempt(app, "203.0.113.3")).status).toBe(429);
  });
});

describe("dashboard serving", () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>ACE</title>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("serves the built dashboard with safe caching and nothing outside it", async () => {
    const app = makeApp({}, { WEB_DIST_DIR: dir });
    const index = await request(app).get("/");
    expect(index.status).toBe(200);
    expect(index.text).toContain("<title>ACE</title>");
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(index.headers["content-security-policy"]).toContain("default-src 'self'");

    const asset = await request(app).get("/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");

    for (const path of ["/.env", "/assets/../.env", "/%2e%2e/package.json", "/assets/%2e%2e/%2e%2e/package.json", "/missing"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain("SECRET");
    }
    // Unknown API paths still answer with JSON, not the dashboard.
    const api = await request(app).get("/api/nope");
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses to start with a directory that has no build", () => {
    expect(() => makeApp({}, { WEB_DIST_DIR: join(dir, "assets") })).toThrow(/no index\.html/);
  });
});
