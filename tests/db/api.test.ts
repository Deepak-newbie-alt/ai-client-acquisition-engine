import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadScoringConfig } from "../../src/config/scoring.js";
import { MockEmailProvider } from "../../src/integrations/email/mock.js";
import { MockLlmProvider as DraftLlm } from "../../src/integrations/llm/mock.js";
import { createFixturePageFetcherFactory } from "../../src/integrations/web/fixtures.js";
import { hashToken } from "../../src/modules/auth/tokens.js";
import { createToken, createUser, silentLogger, TEST_PASSWORD, testConfig } from "./fixtures.js";
import { createTestDb, resetDb } from "./test-database.js";

const db = createTestDb();
const config = testConfig();
const enqueued: string[] = [];
const researchQueue = { enqueue: (id: string) => void enqueued.push(id) };

const makeApp = (rateLimits = { loginPer15Min: 1_000, researchCreatePerHour: 1_000 }) =>
  createApp({
    config,
    db,
    logger: silentLogger,
    researchQueue,
    rateLimits,
    scoring: loadScoringConfig(),
    pages: createFixturePageFetcherFactory(),
    email: new MockEmailProvider(),
    llm: new DraftLlm(),
  });

const app = makeApp();
const CSRF = { "x-ace-csrf": "1" };
const validRun = { industry: "HVAC", country: "GB", keywords: ["scheduling"], resultLimit: 5 };

beforeEach(async () => {
  await resetDb(db);
  enqueued.length = 0;
});
afterAll(() => db.$disconnect());

async function signedIn(email = "admin@example.com") {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").set(CSRF).send({ email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe("authentication", () => {
  it("serves health without auth but protects everything else", async () => {
    expect((await request(app).get("/api/health")).status).toBe(200);
    const res = await request(app).get("/api/research-runs");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
  });

  it("logs in with a hardened session cookie and never returns the password hash", async () => {
    await createUser(db);
    const res = await request(app)
      .post("/api/auth/login")
      .set(CSRF)
      .send({ email: " Admin@Example.com ", password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(expect.objectContaining({ email: "admin@example.com", role: "ADMIN" }));
    expect(JSON.stringify(res.body)).not.toContain("scrypt");
    const cookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/^ace_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api/);
  });

  it.each([
    ["wrong password", "admin@example.com", "not the password at all"],
    ["unknown email", "nobody@example.com", TEST_PASSWORD],
    ["disabled user", "disabled@example.com", TEST_PASSWORD],
  ])("rejects %s with the same response", async (_label, email, password) => {
    await createUser(db);
    await createUser(db, { email: "disabled@example.com", disabled: true });
    const res = await request(app).post("/api/auth/login").set(CSRF).send({ email, password });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("requires the CSRF header for login", async () => {
    await createUser(db);
    const res = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: TEST_PASSWORD });
    expect(res.status).toBe(403);
  });

  it("rejects expired sessions and sessions of disabled users", async () => {
    const user = await createUser(db);
    const agent = await signedIn();
    expect((await agent.get("/api/auth/me")).status).toBe(200);

    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await agent.get("/api/auth/me")).status).toBe(401);

    const agent2 = await signedIn();
    await db.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    expect((await agent2.get("/api/auth/me")).status).toBe(401);
  });

  it("revokes the session on logout", async () => {
    await createUser(db);
    const agent = await signedIn();
    expect((await agent.post("/api/auth/logout").set(CSRF)).status).toBe(204);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    expect(await db.session.count({ where: { revokedAt: null } })).toBe(0);
  });

  it("rate-limits login attempts", async () => {
    const limited = makeApp({ loginPer15Min: 2, researchCreatePerHour: 1_000 });
    const attempt = () => request(limited).post("/api/auth/login").set(CSRF).send({ email: "x@example.com", password: "wrong-password" });
    await attempt();
    await attempt();
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("CSRF protection for cookie sessions", () => {
  it("rejects state changes without the header or from another origin", async () => {
    await createUser(db);
    const agent = await signedIn();
    expect((await agent.post("/api/research-runs").send(validRun)).status).toBe(403);
    expect(
      (await agent.post("/api/research-runs").set(CSRF).set("origin", "https://evil.example.com").send(validRun)).status,
    ).toBe(403);
    expect(enqueued).toHaveLength(0);

    const ok = await agent.post("/api/research-runs").set(CSRF).set("origin", config.appOrigin).send(validRun);
    expect(ok.status).toBe(202);
  });
});

describe("service tokens", () => {
  it("lets a scoped token create runs without CSRF headers", async () => {
    const token = await createToken(db, ["research:read", "research:write"]);
    const res = await request(app).post("/api/research-runs").set("authorization", `Bearer ${token}`).send(validRun);
    expect(res.status).toBe(202);
    expect(res.body.run).toMatchObject({ status: "QUEUED", requestedByType: "SERVICE", country: "GB" });
    expect(enqueued).toEqual([res.body.run.id]);
  });

  it("enforces scopes", async () => {
    const reader = await createToken(db, ["research:read"]);
    const auth = { authorization: `Bearer ${reader}` };
    expect((await request(app).get("/api/research-runs").set(auth)).status).toBe(200);
    expect((await request(app).post("/api/research-runs").set(auth).send(validRun)).status).toBe(403);
  });

  it("can never act as a user", async () => {
    const token = await createToken(db, ["research:read", "research:write"]);
    const res = await request(app).get("/api/auth/me").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it.each([
    ["malformed header", "Token abc"],
    ["unknown token", "Bearer ace_st_doesnotexist"],
    ["non-service token", "Bearer some-random-value"],
  ])("rejects a %s", async (_label, header) => {
    expect((await request(app).get("/api/research-runs").set("authorization", header)).status).toBe(401);
  });

  it("rejects revoked tokens and stores only a hash", async () => {
    const token = await createToken(db, ["research:read"]);
    const record = await db.serviceToken.findFirstOrThrow();
    expect(record.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(record)).not.toContain(token);
    await db.serviceToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    expect((await request(app).get("/api/research-runs").set("authorization", `Bearer ${token}`)).status).toBe(401);
  });
});

describe("research run endpoints", () => {
  it.each([
    ["result limit above the configured maximum", { resultLimit: 21 }],
    ["unknown fields", { sendEmail: true }],
    ["bad country code", { country: "GBR" }],
  ])("returns 400 for %s", async (_label, change) => {
    const token = await createToken(db, ["research:write"]);
    const res = await request(app)
      .post("/api/research-runs")
      .set("authorization", `Bearer ${token}`)
      .send({ ...validRun, ...change });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for malformed JSON without leaking parser details", async () => {
    const token = await createToken(db, ["research:write"]);
    const res = await request(app)
      .post("/api/research-runs")
      .set("authorization", `Bearer ${token}`)
      .set("content-type", "application/json")
      .send('{"industry": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: "INVALID_BODY", message: "Request body could not be read" } });
  });

  it("refuses new runs when the monthly budget is exhausted", async () => {
    await db.usageEvent.create({
      data: { kind: "SEARCH", provider: "test", operation: "seed", costMicros: config.limits.monthlyBudgetMicros },
    });
    const token = await createToken(db, ["research:write"]);
    const res = await request(app).post("/api/research-runs").set("authorization", `Bearer ${token}`).send(validRun);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("BUDGET_EXCEEDED");
  });

  it("rate-limits run creation", async () => {
    const limited = makeApp({ loginPer15Min: 1_000, researchCreatePerHour: 1 });
    const token = await createToken(db, ["research:write"]);
    const create = () => request(limited).post("/api/research-runs").set("authorization", `Bearer ${token}`).send(validRun);
    expect((await create()).status).toBe(202);
    expect((await create()).status).toBe(429);
  });

  it("shows run details, cancels once, and 404s unknown or malformed ids", async () => {
    const token = await createToken(db, ["research:read", "research:write"]);
    const auth = { authorization: `Bearer ${token}` };
    const created = await request(app).post("/api/research-runs").set(auth).send(validRun);
    const id = created.body.run.id as string;

    const detail = await request(app).get(`/api/research-runs/${id}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ run: { id, costMicros: "0" }, sources: [] });

    expect((await request(app).post(`/api/research-runs/${id}/cancel`).set(auth)).body.run.status).toBe("CANCELLED");
    expect((await request(app).post(`/api/research-runs/${id}/cancel`).set(auth)).status).toBe(409);

    const retry = await request(app).post(`/api/research-runs/${id}/retry`).set(auth);
    expect(retry.status).toBe(202);
    expect(retry.body.run.id).not.toBe(id);

    expect((await request(app).get("/api/research-runs/not-a-uuid").set(auth)).status).toBe(404);
    expect((await request(app).get("/api/research-runs/00000000-0000-4000-8000-000000000000").set(auth)).status).toBe(404);
    expect((await request(app).get("/api/no-such-route").set(auth)).status).toBe(404);
  });
});
