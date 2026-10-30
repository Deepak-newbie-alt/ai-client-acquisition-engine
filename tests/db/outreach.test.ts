import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadScoringConfig } from "../../src/config/scoring.js";
import { MockEmailProvider } from "../../src/integrations/email/mock.js";
import { MockLlmProvider } from "../../src/integrations/llm/mock.js";
import { MockSearchProvider } from "../../src/integrations/search/mock.js";
import { createFixturePageFetcherFactory } from "../../src/integrations/web/fixtures.js";
import { outreachContentHash } from "../../src/lib/hash.js";
import { refreshOpportunities } from "../../src/modules/opportunities/service.js";
import { OPT_OUT_LINE } from "../../src/modules/outreach/content.js";
import { sendDraft } from "../../src/modules/outreach/service.js";
import { runResearch } from "../../src/modules/research/pipeline.js";
import { createToken, createUser, queuedRun, silentLogger, TEST_PASSWORD, testConfig } from "./fixtures.js";
import { createTestDb, resetDb } from "./test-database.js";

const db = createTestDb();
const config = testConfig({ OUTREACH_SENDER_NAME: "Dana Smith", OUTREACH_POSTAL_ADDRESS: "1 High St, Springfield" });
const scoring = loadScoringConfig();
const pages = createFixturePageFetcherFactory();
const CSRF = { "x-ace-csrf": "1" };

let email: MockEmailProvider;
let llm: MockLlmProvider;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb(db);
  email = new MockEmailProvider("outreach@sender.example.com");
  llm = new MockLlmProvider();
  app = createApp({
    config,
    db,
    logger: silentLogger,
    researchQueue: { enqueue: () => undefined },
    rateLimits: { loginPer15Min: 1_000, researchCreatePerHour: 1_000, sendsPerHour: 1_000, draftsPerHour: 1_000 },
    scoring,
    pages,
    email,
    llm,
  });
});
afterAll(() => db.$disconnect());

interface Draft {
  id: string;
  status: string;
  contentHash: string;
  subject: string;
  body: string;
  recipientEmail: string;
  providerThreadId: string | null;
}

async function signIn(role: "ADMIN" | "REVIEWER" = "ADMIN"): Promise<TestAgent> {
  const user = await createUser(db, { email: `${role.toLowerCase()}@example.com`, role });
  const agent = request.agent(app);
  await agent.post("/api/auth/login").set(CSRF).send({ email: user.email, password: TEST_PASSWORD });
  return agent;
}

async function contact(address = "owner@example.com", domain = address.split("@")[1]!) {
  const company = await db.company.upsert({ where: { domain }, create: { name: "Example HVAC", domain }, update: {} });
  return db.contact.create({
    data: { companyId: company.id, email: address, emailNormalized: address, sourceUrl: `https://${domain}/contact`, retrievedAt: new Date() },
  });
}

const manual = { mode: "manual", subject: "Question about scheduling", body: "Hi,\nHow do you schedule jobs today?" };

async function createDraft(agent: TestAgent, contactId: string, extra: object = {}): Promise<Draft> {
  const res = await agent.post("/api/outreach/drafts").set(CSRF).send({ ...manual, contactId, ...extra });
  expect(res.status).toBe(201);
  return res.body.draft as Draft;
}

const approve = (agent: TestAgent, d: { id: string; contentHash: string }) =>
  agent.post(`/api/outreach/drafts/${d.id}/approve`).set(CSRF).send({ contentHash: d.contentHash });
const send = (agent: TestAgent, d: { id: string; contentHash: string }) =>
  agent.post(`/api/outreach/drafts/${d.id}/send`).set(CSRF).send({ contentHash: d.contentHash });
const status = async (id: string) => (await db.outreachDraft.findUniqueOrThrow({ where: { id } })).status;

describe("drafting", () => {
  it("generates a personalized draft from research without sending anything", async () => {
    const run = await queuedRun(db, config.limits);
    await runResearch(run.id, { db, search: new MockSearchProvider(), llm, pages, limits: config.limits, logger: silentLogger });
    await refreshOpportunities(db, scoring);
    const agent = await signIn();
    const source = await db.sourceDocument.findFirstOrThrow({ where: { canonicalUrl: { endsWith: "/blog/scheduling-on-a-whiteboard" } } });
    const company = (await agent.post("/api/companies").set(CSRF).send({ name: "Example Heating", fromSourceId: source.id })).body.company as { id: string };
    const person = (
      await agent.post(`/api/companies/${company.id}/contacts`).set(CSRF).send({ email: "office@example.com", name: "Pat Lee", sourceUrl: "https://www.example.com/contact" })
    ).body.contact as { id: string };
    const cluster = await db.clusterEvidence.findFirstOrThrow({ where: { evidence: { sourceId: source.id } } });

    const res = await agent.post("/api/outreach/drafts").set(CSRF).send({ contactId: person.id, opportunityId: cluster.clusterId, mode: "generate" });
    expect(res.status).toBe(201);
    const draft = res.body.draft as Draft & { generatedByModel: string };
    expect(draft).toMatchObject({ status: "DRAFT", recipientEmail: "office@example.com", generatedByModel: "mock-evidence-extractor" });
    expect(draft.body).toContain("Hi Pat,");
    expect(draft.body).toContain("I read on your website"); // quotes the company's own page
    expect(draft.body).toContain(`Dana Smith\n1 High St, Springfield\n${OPT_OUT_LINE}`);
    expect(draft.contentHash).toBe(outreachContentHash(draft));
    expect(email.attempts).toBe(0);
    expect(await db.usageEvent.count({ where: { operation: "draft_outreach", runId: null } })).toBe(1);
  });

  it("allows only one in-progress draft per contact and none to suppressed or invalid contacts", async () => {
    const agent = await signIn();
    const c = await contact();
    await createDraft(agent, c.id);
    const dup = await agent.post("/api/outreach/drafts").set(CSRF).send({ ...manual, contactId: c.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("ACTIVE_DRAFT_EXISTS");

    const suppressed = await contact("noreply@other.example.org");
    await db.suppressionRecord.create({ data: { scope: "DOMAIN", value: "other.example.org", reason: "test", source: "manual" } });
    expect((await agent.post("/api/outreach/drafts").set(CSRF).send({ ...manual, contactId: suppressed.id })).body.error.code).toBe("SUPPRESSED");

    const invalid = await contact("gone@third.example.net");
    await db.contact.update({ where: { id: invalid.id }, data: { verificationStatus: "INVALID" } });
    expect((await agent.post("/api/outreach/drafts").set(CSRF).send({ ...manual, contactId: invalid.id })).body.error.code).toBe("CONTACT_INVALID");
  });

  it("rejects header injection and removal of the opt-out line", async () => {
    const agent = await signIn();
    const c = await contact();
    expect((await agent.post("/api/outreach/drafts").set(CSRF).send({ ...manual, contactId: c.id, subject: "Hi\r\nBcc: all@example.com" })).status).toBe(400);
    const draft = await createDraft(agent, c.id);
    const edit = await agent
      .patch(`/api/outreach/drafts/${draft.id}`)
      .set(CSRF)
      .send({ expectedContentHash: draft.contentHash, body: "Totally new body without the footer line." });
    expect(edit.status).toBe(422);
    expect(edit.body.error.details).toEqual([{ path: "body", message: "the body must keep the opt-out line" }]);
  });
});

describe("approval and sending", () => {
  it("never sends without an approval", async () => {
    const agent = await signIn();
    const draft = await createDraft(agent, (await contact()).id);
    const res = await send(agent, draft);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NOT_APPROVED");
    expect(email.attempts).toBe(0);
  });

  it("binds approval to the exact content the reviewer saw", async () => {
    const agent = await signIn();
    const draft = await createDraft(agent, (await contact()).id);
    expect((await approve(agent, { id: draft.id, contentHash: "0".repeat(64) })).body.error.code).toBe("STALE_CONTENT");

    const approved = await approve(agent, draft);
    expect(approved.status).toBe(200);
    expect(approved.body.approval).toMatchObject({ contentHash: draft.contentHash, recipientEmail: "owner@example.com", consumedAt: null });
    expect((await approve(agent, draft)).body.error.code).toBe("ALREADY_APPROVED");
  });

  it("invalidates the approval when content changes and refuses to send the old version", async () => {
    const agent = await signIn();
    const draft = await createDraft(agent, (await contact()).id);
    await approve(agent, draft);

    const edited = await agent
      .patch(`/api/outreach/drafts/${draft.id}`)
      .set(CSRF)
      .send({ expectedContentHash: draft.contentHash, subject: "A different subject" });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ approvalInvalidated: true, draft: { status: "DRAFT" } });
    expect(await db.approval.count({ where: { draftId: draft.id, invalidatedAt: { not: null } } })).toBe(1);

    expect((await send(agent, draft)).body.error.code).toBe("NOT_APPROVED");
    expect((await send(agent, edited.body.draft as Draft)).body.error.code).toBe("NOT_APPROVED");
    expect(email.attempts).toBe(0);

    // A stale editor cannot overwrite newer content.
    const stale = await agent.patch(`/api/outreach/drafts/${draft.id}`).set(CSRF).send({ expectedContentHash: draft.contentHash, subject: "Lost update" });
    expect(stale.body.error.code).toBe("STALE_CONTENT");
  });

  it("sends exactly the approved content once and records the provider result", async () => {
    const agent = await signIn();
    const draft = await createDraft(agent, (await contact()).id);
    await approve(agent, draft);
    const res = await send(agent, draft);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "SENT", draft: { status: "SENT", sendOutcome: "SUCCESS" } });

    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0]!;
    expect(sent).toMatchObject({ to: "owner@example.com", subject: draft.subject, body: draft.body, from: { name: "Dana Smith", address: "outreach@sender.example.com" } });
    const stored = await db.outreachDraft.findUniqueOrThrow({ where: { id: draft.id }, include: { approvals: true } });
    expect(stored.rfcMessageId).toBe(sent.rfcMessageId);
    expect(stored.providerMessageId).toBe(sent.providerMessageId);
    expect(stored.approvals[0]?.consumedAt).not.toBeNull();

    expect((await send(agent, draft)).body.error.code).toBe("ALREADY_SENT");
    expect(email.attempts).toBe(1);
  });

  it("prevents duplicate sends under concurrent requests", async () => {
    const agent = await signIn();
    const user = await db.user.findFirstOrThrow();
    const draft = await createDraft(agent, (await contact()).id);
    await approve(agent, draft);
    const deps = { db, email, llm, config, logger: silentLogger };
    const actor = { type: "USER" as const, userId: user.id, role: user.role };

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => sendDraft(deps, draft.id, draft.contentHash, actor)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r).reason.code as string)).toEqual(
      Array(4).fill(expect.stringMatching(/SEND_IN_PROGRESS|ALREADY_SENT/)),
    );
    expect(email.attempts).toBe(1);
    expect(await status(draft.id)).toBe("SENT");
  });

  it("re-checks suppression immediately before sending", async () => {
    const agent = await signIn();
    const draft = await createDraft(agent, (await contact()).id);
    await approve(agent, draft);
    await db.suppressionRecord.create({ data: { scope: "EMAIL", value: "owner@example.com", reason: "opted out elsewhere", source: "manual" } });

    const res = await send(agent, draft);
    expect(res.body.error.code).toBe("SUPPRESSED");
    expect(await status(draft.id)).toBe("CANCELLED");
    expect(await db.approval.count({ where: { draftId: draft.id, invalidatedAt: { not: null } } })).toBe(1);
    expect(email.attempts).toBe(0);
  });

  it("refuses expired approvals and returns the draft for re-approval", async () => {
    const agent = await signIn();
    const draft = await createDraft(agent, (await contact()).id);
    await approve(agent, draft);
    await db.approval.updateMany({ data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect((await send(agent, draft)).body.error.code).toBe("APPROVAL_EXPIRED");
    expect(await status(draft.id)).toBe("DRAFT");
    expect(email.attempts).toBe(0);
    expect((await approve(agent, draft)).status).toBe(200);
    expect((await send(agent, draft)).body.outcome).toBe("SENT");
  });

  it("does not let service tokens draft, approve or send", async () => {
    const agent = await signIn();
    const draft = await createDraft(agent, (await contact()).id);
    const token = await createToken(db, ["research:read", "research:write", "outreach:sync"]);
    const auth = { authorization: `Bearer ${token}` };
    expect((await request(app).post("/api/outreach/drafts").set(auth).send({ ...manual, contactId: draft.id })).status).toBe(403);
    expect((await request(app).post(`/api/outreach/drafts/${draft.id}/approve`).set(auth).send({ contentHash: draft.contentHash })).status).toBe(403);
    expect((await request(app).post(`/api/outreach/drafts/${draft.id}/send`).set(auth).send({ contentHash: draft.contentHash })).status).toBe(403);
    expect((await request(app).get("/api/outreach/drafts").set(auth)).status).toBe(403);
    expect(email.attempts).toBe(0);
  });
});

describe("provider failures and uncertain outcomes", () => {
  it("marks a definite rejection FAILED without retrying, and allows a revised draft", async () => {
    const agent = await signIn();
    const draft = await createDraft(agent, (await contact()).id);
    await approve(agent, draft);
    email.behavior = "reject";
    const res = await send(agent, draft);
    expect(res.body).toMatchObject({ outcome: "FAILED", draft: { status: "FAILED", sendOutcome: "FAILURE" } });
    expect(email.attempts).toBe(1);
    expect((await send(agent, draft)).body.error.code).toBe("NOT_APPROVED");
    expect(email.attempts).toBe(1);

    const revised = await agent.post(`/api/outreach/drafts/${draft.id}/revise`).set(CSRF);
    expect(revised.status).toBe(201);
    expect(revised.body.draft).toMatchObject({ status: "DRAFT", subject: draft.subject });
  });

  it("leaves an uncertain send in SENDING, refuses to resend, and reconciles it as sent", async () => {
    const agent = await signIn();
    const draft = await createDraft(agent, (await contact()).id);
    await approve(agent, draft);
    email.behavior = "timeout-delivered";
    const res = await send(agent, draft);
    expect(res.body).toMatchObject({ outcome: "UNKNOWN", draft: { status: "SENDING", sendOutcome: "UNKNOWN" } });

    email.behavior = "deliver";
    expect((await send(agent, draft)).body.error.code).toBe("SEND_IN_PROGRESS");
    expect(email.attempts).toBe(1);

    const reconciled = await agent.post(`/api/outreach/drafts/${draft.id}/reconcile`).set(CSRF);
    expect(reconciled.body.draft).toMatchObject({ status: "SENT", sendOutcome: "SUCCESS" });
    expect(email.attempts).toBe(1);
  });

  it("only marks an unconfirmed send as failed after the grace period", async () => {
    const agent = await signIn();
    const draft = await createDraft(agent, (await contact()).id);
    await approve(agent, draft);
    email.behavior = "timeout-lost";
    await send(agent, draft);

    const early = await agent.post(`/api/outreach/drafts/${draft.id}/reconcile`).set(CSRF);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("RECONCILE_TOO_EARLY");
    expect(await status(draft.id)).toBe("SENDING");

    await db.outreachDraft.update({ where: { id: draft.id }, data: { sendAttemptedAt: new Date(Date.now() - 16 * 60_000) } });
    const late = await agent.post(`/api/outreach/drafts/${draft.id}/reconcile`).set(CSRF);
    expect(late.body.draft).toMatchObject({ status: "FAILED", sendOutcome: "FAILURE" });
    expect(email.attempts).toBe(1);
  });
});

describe("replies, follow-ups and opt-outs", () => {
  async function sentDraft(agent: TestAgent, address = "owner@example.com"): Promise<Draft> {
    const draft = await createDraft(agent, (await contact(address)).id);
    await approve(agent, draft);
    return (await send(agent, draft)).body.draft as Draft;
  }

  it("allows a follow-up until the recipient replies, then stops follow-ups", async () => {
    const agent = await signIn();
    const first = await sentDraft(agent);
    const c = await db.contact.findFirstOrThrow();
    const followUp = await createDraft(agent, c.id, { followUpOfId: first.id });
    await approve(agent, followUp);

    email.addReply(first.providerThreadId!, "Thanks, can you tell me more?");
    const token = await createToken(db, ["outreach:sync"]);
    const checked = await request(app).post("/api/outreach/check-replies").set("authorization", `Bearer ${token}`);
    expect(checked.body).toEqual({ checked: 1, replied: 1, optedOut: 0, errors: 0 });

    expect(await db.outreachDraft.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ optedOutAt: null });
    expect((await db.outreachDraft.findUniqueOrThrow({ where: { id: first.id } })).repliedAt).not.toBeNull();
    expect(await status(followUp.id)).toBe("CANCELLED");
    expect(await db.suppressionRecord.count()).toBe(0);
    expect((await send(agent, followUp)).body.error.code).toBe("NOT_APPROVED");

    const another = await agent.post("/api/outreach/drafts").set(CSRF).send({ ...manual, contactId: c.id, followUpOfId: first.id });
    expect(another.body.error.code).toBe("REPLIED");
    expect(email.attempts).toBe(1);
  });

  it("suppresses the address and cancels everything pending when a reply opts out", async () => {
    const agent = await signIn();
    const first = await sentDraft(agent);
    const c = await db.contact.findFirstOrThrow();
    const pending = await createDraft(agent, c.id, { followUpOfId: first.id });

    email.addReply(first.providerThreadId!, "Please remove me from your list.");
    const checked = await agent.post("/api/outreach/check-replies").set(CSRF);
    expect(checked.body).toMatchObject({ replied: 1, optedOut: 1 });

    expect(await db.suppressionRecord.findFirst({ where: { scope: "EMAIL", value: "owner@example.com" } })).toMatchObject({ source: "reply" });
    expect(await status(pending.id)).toBe("CANCELLED");
    expect((await agent.post("/api/outreach/drafts").set(CSRF).send({ ...manual, contactId: c.id })).body.error.code).toBe("SUPPRESSED");
  });

  it("lets a user record a reply or opt-out by hand", async () => {
    const agent = await signIn();
    const first = await sentDraft(agent);
    const res = await agent.post(`/api/outreach/drafts/${first.id}/replied`).set(CSRF).send({ optOut: true });
    expect(res.status).toBe(200);
    expect(res.body.draft.optedOutAt).not.toBeNull();
    expect(await db.suppressionRecord.count({ where: { value: "owner@example.com" } })).toBe(1);
    const audit = await db.auditEvent.findMany({ where: { entityId: first.id }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["draft.created", "draft.approved", "draft.send_started", "draft.sent", "draft.opted_out"]);
  });
});
