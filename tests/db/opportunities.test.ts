import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadScoringConfig } from "../../src/config/scoring.js";
import { MockLlmProvider } from "../../src/integrations/llm/mock.js";
import { MockSearchProvider } from "../../src/integrations/search/mock.js";
import { MockEmailProvider } from "../../src/integrations/email/mock.js";
import { MockLlmProvider as DraftLlm } from "../../src/integrations/llm/mock.js";
import { createFixturePageFetcherFactory } from "../../src/integrations/web/fixtures.js";
import { refreshOpportunities } from "../../src/modules/opportunities/service.js";
import { runResearch } from "../../src/modules/research/pipeline.js";
import { createToken, createUser, queuedRun, silentLogger, TEST_PASSWORD, testConfig } from "./fixtures.js";
import { createTestDb, resetDb } from "./test-database.js";

const db = createTestDb();
const config = testConfig();
const scoring = loadScoringConfig();
const pages = createFixturePageFetcherFactory();
const app = createApp({
  config,
  db,
  logger: silentLogger,
  researchQueue: { enqueue: () => undefined },
  rateLimits: { loginPer15Min: 1_000, researchCreatePerHour: 1_000 },
  scoring,
  pages,
  email: new MockEmailProvider(),
  llm: new DraftLlm(),
});
const CSRF = { "x-ace-csrf": "1" };

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

async function research() {
  const run = await queuedRun(db, config.limits);
  await runResearch(run.id, {
    db,
    search: new MockSearchProvider(),
    llm: new MockLlmProvider(),
    pages,
    limits: config.limits,
    logger: silentLogger,
  });
  return refreshOpportunities(db, scoring);
}

/** The cluster containing evidence from the given source URL suffix. */
async function clusterFor(urlSuffix: string) {
  const link = await db.clusterEvidence.findFirstOrThrow({
    where: { evidence: { source: { canonicalUrl: { endsWith: urlSuffix } } } },
    include: { cluster: { include: { scores: true } } },
  });
  return link.cluster;
}

async function signedIn(role: "ADMIN" | "REVIEWER" = "ADMIN") {
  await createUser(db, { email: `${role.toLowerCase()}@example.com`, role });
  const agent = request.agent(app);
  await agent.post("/api/auth/login").set(CSRF).send({ email: `${role.toLowerCase()}@example.com`, password: TEST_PASSWORD });
  return agent;
}

describe("clustering and scoring", () => {
  it("puts every valid piece of evidence in exactly one cluster", async () => {
    const result = await research();
    const evidence = await db.evidence.count({ where: { validationStatus: "VALID" } });
    expect(evidence).toBeGreaterThan(0);
    expect(await db.clusterEvidence.count()).toBe(evidence);
    expect(result.assigned + result.created).toBe(evidence);
    expect(result.scored).toBe(await db.problemCluster.count());
  });

  it("groups the same problem across independent businesses, counting one site once", async () => {
    await research();
    const scheduling = await clusterFor("/blog/scheduling-on-a-whiteboard");
    // Blog and about page are both example.com (one business); the forum is another.
    expect(await clusterFor("/about")).toMatchObject({ id: scheduling.id });
    expect(await clusterFor("/t/managing-technician-schedules")).toMatchObject({ id: scheduling.id });
    expect(scheduling.independentCompanyCount).toBe(2);
    expect(scheduling.independentSourceCount).toBeGreaterThanOrEqual(3);

    // The syndicated copy adds nothing to the paperwork problem.
    const paperwork = await clusterFor("/articles/field-service-paperwork");
    expect(paperwork.independentCompanyCount).toBe(1);
  });

  it("stores six transparent component scores per cluster with the weights version", async () => {
    await research();
    const cluster = await clusterFor("/blog/scheduling-on-a-whiteboard");
    expect(cluster.scores).toHaveLength(6);
    for (const s of cluster.scores) {
      expect(s.weightsVersion).toBe(scoring.version);
      expect(s.weight).toBe(scoring.weights[s.component]);
      expect(s.rationale.length).toBeGreaterThan(10);
    }
    const byComponent = Object.fromEntries(cluster.scores.map((s) => [s.component, s.value]));
    expect(byComponent.RECURRENCE).toBe(2);
    expect(byComponent.BUYER_ACCESSIBILITY).toBeNull(); // no companies linked yet
    expect(cluster.scoreCoverage).toBeLessThan(1);
    expect(cluster.totalScore).toBeGreaterThan(0);

    // Score evidence links point at evidence in the same cluster.
    const links = await db.scoreEvidence.findMany({ where: { score: { clusterId: cluster.id } }, select: { evidenceId: true } });
    const members = new Set((await db.clusterEvidence.findMany({ where: { clusterId: cluster.id } })).map((m) => m.evidenceId));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => members.has(l.evidenceId))).toBe(true);
  });

  it("is idempotent and does not duplicate clusters when sources are seen again", async () => {
    await research();
    const clusters = await db.problemCluster.findMany({ orderBy: { id: "asc" }, select: { id: true, totalScore: true } });

    expect(await refreshOpportunities(db, scoring)).toMatchObject({ assigned: 0, created: 0 });
    await research(); // second run reuses the same sources
    expect(await db.problemCluster.findMany({ orderBy: { id: "asc" }, select: { id: true, totalScore: true } })).toEqual(clusters);
  });

  it("drops rejected evidence and deletes clusters left empty", async () => {
    await research();
    const paperwork = await clusterFor("/articles/field-service-paperwork");
    await db.evidence.updateMany({
      where: { clusters: { some: { clusterId: paperwork.id } } },
      data: { validationStatus: "REJECTED" },
    });
    await refreshOpportunities(db, scoring);
    expect(await db.problemCluster.count({ where: { id: paperwork.id } })).toBe(0);
    expect(await db.clusterEvidence.count({ where: { evidence: { validationStatus: "REJECTED" } } })).toBe(0);
  });
});

describe("opportunity API", () => {
  it("is for signed-in users only", async () => {
    const token = await createToken(db, ["research:read", "research:write"]);
    expect((await request(app).get("/api/opportunities")).status).toBe(401);
    expect((await request(app).get("/api/opportunities").set("authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).get("/api/companies").set("authorization", `Bearer ${token}`)).status).toBe(403);
  });

  it("lists ranked opportunities and shows scores, rationale and evidence", async () => {
    await research();
    const agent = await signedIn("REVIEWER");
    const list = await agent.get("/api/opportunities");
    expect(list.status).toBe(200);
    const totals = (list.body.opportunities as { totalScore: number }[]).map((o) => o.totalScore);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));

    const id = list.body.opportunities[0].id as string;
    const detail = await agent.get(`/api/opportunities/${id}`);
    expect(detail.body.scores).toHaveLength(6);
    expect(detail.body.evidence[0]).toMatchObject({ excerpt: expect.any(String), kind: expect.any(String), source: { canonicalUrl: expect.any(String) } });

    const weights = await agent.get("/api/opportunities/scoring");
    expect(weights.body).toMatchObject({ scoring: { version: scoring.version }, disclaimer: expect.stringContaining("not probabilities") });
  });

  it("edits reviewed alternatives and rescoring uses them", async () => {
    await research();
    const agent = await signedIn();
    const cluster = await clusterFor("/blog/scheduling-on-a-whiteboard");
    const res = await agent
      .patch(`/api/opportunities/${cluster.id}`)
      .set(CSRF)
      .send({ buyer: "Owner-operator of a 5-15 technician firm", alternatives: [{ name: "FleetSuite", fit: "good" }] });
    expect(res.status).toBe(200);
    const updated = await clusterFor("/blog/scheduling-on-a-whiteboard");
    expect(updated.buyer).toBe("Owner-operator of a 5-15 technician firm");
    expect(updated.scores.find((s) => s.component === "DIFFERENTIATION")?.value).toBe(1);

    expect((await agent.patch(`/api/opportunities/${cluster.id}`).set(CSRF).send({ alternatives: [{ name: "X", fit: "great" }] })).status).toBe(400);
    expect((await agent.patch(`/api/opportunities/${cluster.id}`).set(CSRF).send({})).status).toBe(400);
  });

  it("merges duplicate clusters", async () => {
    await research();
    const agent = await signedIn();
    const a = await clusterFor("/articles/field-service-paperwork");
    const b = await clusterFor("/blog/scheduling-on-a-whiteboard");
    const before = await db.clusterEvidence.count({ where: { clusterId: { in: [a.id, b.id] } } });

    expect((await agent.post(`/api/opportunities/${a.id}/merge`).set(CSRF).send({ intoId: a.id })).status).toBe(400);
    const res = await agent.post(`/api/opportunities/${a.id}/merge`).set(CSRF).send({ intoId: b.id });
    expect(res.status).toBe(200);
    expect(await db.problemCluster.count({ where: { id: a.id } })).toBe(0);
    expect(await db.clusterEvidence.count({ where: { clusterId: b.id } })).toBe(before);
    expect(await db.auditEvent.count({ where: { action: "opportunity.merged", entityId: b.id } })).toBe(1);
  });

  it("lets a reviewer reject evidence, which then leaves its cluster", async () => {
    await research();
    const agent = await signedIn("REVIEWER");
    const evidence = await db.evidence.findFirstOrThrow({ where: { source: { canonicalUrl: { endsWith: "/about" } } } });
    const res = await agent.patch(`/api/evidence/${evidence.id}`).set(CSRF).send({ validationStatus: "REJECTED", validationNote: "About page, not a problem report" });
    expect(res.status).toBe(200);
    expect(await db.clusterEvidence.count({ where: { evidenceId: evidence.id } })).toBe(0);
  });
});

describe("companies, contacts and suppression", () => {
  it("creates a company from a source, links its pages and enables buyer accessibility", async () => {
    await research();
    const agent = await signedIn();
    const source = await db.sourceDocument.findFirstOrThrow({ where: { canonicalUrl: { endsWith: "/blog/scheduling-on-a-whiteboard" } } });

    const created = await agent.post("/api/companies").set(CSRF).send({ name: "Example Heating & Cooling", fromSourceId: source.id });
    expect(created.status).toBe(201);
    const companyId = created.body.company.id as string;
    expect(created.body.company).toMatchObject({ domain: "example.com", provenanceSourceId: source.id });
    expect(await db.sourceDocument.count({ where: { companyId } })).toBe(await db.sourceDocument.count({ where: { registrableDomain: "example.com" } }));
    expect((await agent.post("/api/companies").set(CSRF).send({ name: "Dup", website: "https://www.example.com/" })).status).toBe(409);

    const buyerScore = async () =>
      (await clusterFor("/blog/scheduling-on-a-whiteboard")).scores.find((s) => s.component === "BUYER_ACCESSIBILITY")?.value;
    expect(await buyerScore()).toBe(0); // linked, but no contact yet

    const contact = await agent
      .post(`/api/companies/${companyId}/contacts`)
      .set(CSRF)
      .send({ email: "Office@Example.com", role: "Office", sourceUrl: "https://www.example.com/contact" });
    expect(contact.status).toBe(201);
    expect(contact.body.contact).toMatchObject({ emailNormalized: "office@example.com", verificationStatus: "UNVERIFIED" });
    expect(await buyerScore()).toBe(5);

    // Suppressing the address makes the company unreachable again.
    expect((await agent.post("/api/suppressions").set(CSRF).send({ scope: "EMAIL", value: "office@example.com", reason: "Asked not to be contacted" })).status).toBe(201);
    await refreshOpportunities(db, scoring);
    expect(await buyerScore()).toBe(0);
    const detail = await agent.get(`/api/companies/${companyId}`);
    expect(detail.body.contacts[0]).toMatchObject({ suppressed: true });
  });

  it("requires a public source URL and a valid email for contacts", async () => {
    const agent = await signedIn();
    const company = await agent.post("/api/companies").set(CSRF).send({ name: "Example", website: "https://example.org" });
    const add = (body: object) => agent.post(`/api/companies/${company.body.company.id}/contacts`).set(CSRF).send(body);
    expect((await add({ email: "a@example.org" })).status).toBe(400);
    expect((await add({ email: "a@example.org", sourceUrl: "http://127.0.0.1/team" })).status).toBe(400);
    expect((await add({ email: "not-an-email", sourceUrl: "https://example.org/team" })).status).toBe(400);
    expect((await agent.post("/api/companies").set(CSRF).send({ name: "Bad", website: "http://localhost/" })).status).toBe(400);
  });

  it("verifies a contact only if the address appears on its source page", async () => {
    const agent = await signedIn();
    const company = await agent.post("/api/companies").set(CSRF).send({ name: "Example", website: "https://www.example.com" });
    const id = company.body.company.id as string;
    const listed = await agent.post(`/api/companies/${id}/contacts`).set(CSRF).send({ email: "office@example.com", sourceUrl: "https://www.example.com/contact" });
    const unlisted = await agent.post(`/api/companies/${id}/contacts`).set(CSRF).send({ email: "ceo@example.com", sourceUrl: "https://www.example.com/contact" });
    const missing = await agent.post(`/api/companies/${id}/contacts`).set(CSRF).send({ email: "x@example.com", sourceUrl: "https://www.example.com/no-such-page" });

    expect((await agent.post(`/api/contacts/${listed.body.contact.id}/verify`).set(CSRF)).body.contact.verificationStatus).toBe("VERIFIED");
    expect((await agent.post(`/api/contacts/${unlisted.body.contact.id}/verify`).set(CSRF)).body.contact.verificationStatus).toBe("INVALID");
    const failed = await agent.post(`/api/contacts/${missing.body.contact.id}/verify`).set(CSRF);
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe("VERIFY_FETCH_FAILED");
  });

  it("validates suppressions and lets only admins remove them", async () => {
    const reviewer = await signedIn("REVIEWER");
    expect((await reviewer.post("/api/suppressions").set(CSRF).send({ scope: "EMAIL", value: "nope", reason: "x y" })).status).toBe(400);
    expect((await reviewer.post("/api/suppressions").set(CSRF).send({ scope: "DOMAIN", value: "not a domain", reason: "x y" })).status).toBe(400);
    const created = await reviewer.post("/api/suppressions").set(CSRF).send({ scope: "DOMAIN", value: "Example.NET", reason: "Do not contact" });
    expect(created.status).toBe(201);
    expect(created.body.suppression).toMatchObject({ value: "example.net", source: "manual" });
    expect((await reviewer.post("/api/suppressions").set(CSRF).send({ scope: "DOMAIN", value: "example.net", reason: "again" })).status).toBe(409);

    const id = created.body.suppression.id as string;
    expect((await reviewer.delete(`/api/suppressions/${id}`).set(CSRF)).status).toBe(403);
    const admin = await signedIn("ADMIN");
    expect((await admin.delete(`/api/suppressions/${id}`).set(CSRF)).status).toBe(204);
  });

  it("exposes the audit trail to signed-in users", async () => {
    await research();
    const agent = await signedIn();
    const run = await db.researchRun.findFirstOrThrow();
    const res = await agent.get(`/api/audit-events?entityType=ResearchRun&entityId=${run.id}`);
    expect(res.status).toBe(200);
    expect((res.body.events as { action: string }[]).map((e) => e.action)).toEqual([
      "research_run.succeeded",
      "research_run.started",
      "research_run.created",
    ]);
  });
});
