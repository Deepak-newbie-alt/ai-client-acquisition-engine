import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { emailDomain, normalizeEmail } from "../../src/lib/email.js";
import { outreachContentHash, sha256Hex } from "../../src/lib/hash.js";
import { createTestDb, resetDb } from "./test-database.js";

const db = createTestDb();

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

async function createSource(canonicalUrl = "https://example.com/post") {
  return db.sourceDocument.create({
    data: { canonicalUrl, domain: "example.com", registrableDomain: "example.com" },
  });
}

async function createEvidence(sourceId: string, excerpt = "We spend hours on manual scheduling.", confidence = 0.8) {
  return db.evidence.create({
    data: {
      sourceId,
      excerpt,
      excerptHash: sha256Hex(excerpt),
      problemSummary: "Manual technician scheduling",
      kind: "OBSERVED",
      confidence,
    },
  });
}

async function createContact(email = "Owner@Example.com") {
  const company = await db.company.create({ data: { name: "Example Ltd", domain: emailDomain(email) } });
  const contact = await db.contact.create({
    data: {
      companyId: company.id,
      email,
      emailNormalized: normalizeEmail(email),
      sourceUrl: "https://example.com/contact",
      retrievedAt: new Date(),
    },
  });
  return { company, contact };
}

async function createDraft(companyId: string, contactId: string, recipientEmail: string) {
  const content = { recipientEmail, subject: "Scheduling question", body: "Hello" };
  return db.outreachDraft.create({
    data: { companyId, contactId, ...content, contentHash: outreachContentHash(content), createdByType: "SYSTEM" },
  });
}

async function createUser() {
  return db.user.create({
    data: { email: "reviewer@example.com", displayName: "Reviewer", passwordHash: "x" },
  });
}

describe("sources and evidence", () => {
  it("rejects duplicate canonical URLs", async () => {
    await createSource();
    await expect(createSource()).rejects.toMatchObject({ code: "P2002" });
  });

  it("links one source to several runs without duplicating it", async () => {
    const source = await createSource();
    const runData = {
      query: "q",
      industry: "HVAC",
      country: "GB",
      resultLimit: 10,
      requestedByType: "USER" as const,
    };
    const [a, b] = await Promise.all([db.researchRun.create({ data: runData }), db.researchRun.create({ data: runData })]);
    await db.runSource.createMany({ data: [a, b].map((run) => ({ runId: run.id, sourceId: source.id })) });
    await expect(db.runSource.create({ data: { runId: a.id, sourceId: source.id } })).rejects.toMatchObject({
      code: "P2002",
    });
    expect(await db.sourceDocument.count()).toBe(1);
  });

  it("requires evidence to reference an existing source", async () => {
    await expect(createEvidence("00000000-0000-4000-8000-000000000000")).rejects.toThrow();
  });

  it("deletes evidence together with its source", async () => {
    const source = await createSource();
    await createEvidence(source.id);
    await db.sourceDocument.delete({ where: { id: source.id } });
    expect(await db.evidence.count()).toBe(0);
  });

  it("rejects the same excerpt twice for one source", async () => {
    const source = await createSource();
    await createEvidence(source.id);
    await expect(createEvidence(source.id)).rejects.toMatchObject({ code: "P2002" });
  });

  it.each([-0.1, 1.1])("rejects confidence %s outside [0, 1]", async (confidence) => {
    const source = await createSource();
    await expect(createEvidence(source.id, "excerpt", confidence)).rejects.toThrow(/Evidence_confidence_range/);
  });
});

describe("problem clusters and scores", () => {
  it("rejects duplicate cluster keys and out-of-range scores", async () => {
    const data = { normalizedKey: "hvac:scheduling", title: "t", description: "d", segment: "s", buyer: "b" };
    const cluster = await db.problemCluster.create({ data });
    await expect(db.problemCluster.create({ data })).rejects.toMatchObject({ code: "P2002" });

    const score = { clusterId: cluster.id, weight: 0.2, rationale: "r", weightsVersion: "v1" };
    await db.clusterScore.create({ data: { ...score, component: "FREQUENCY", value: null } });
    await expect(
      db.clusterScore.create({ data: { ...score, component: "RECURRENCE", value: 6 } }),
    ).rejects.toThrow(/ClusterScore_value_range/);
  });
});

describe("contacts and suppression", () => {
  it("rejects duplicate normalized emails within a company", async () => {
    const { company } = await createContact("Owner@Example.com");
    await expect(
      db.contact.create({
        data: {
          companyId: company.id,
          email: "owner@example.com",
          emailNormalized: "owner@example.com",
          sourceUrl: "https://example.com/team",
          retrievedAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects non-normalized emails and duplicate suppressions", async () => {
    const { company } = await createContact();
    await expect(
      db.contact.create({
        data: {
          companyId: company.id,
          email: "X@Example.com",
          emailNormalized: "X@Example.com",
          sourceUrl: "https://example.com/team",
          retrievedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/Contact_emailNormalized_lowercase/);

    const record = { scope: "EMAIL" as const, value: "owner@example.com", reason: "opt-out", source: "reply" };
    await db.suppressionRecord.create({ data: record });
    await expect(db.suppressionRecord.create({ data: record })).rejects.toMatchObject({ code: "P2002" });
    await expect(db.suppressionRecord.create({ data: { ...record, value: "Owner@Example.com" } })).rejects.toThrow(
      /SuppressionRecord_value_lowercase/,
    );
  });
});

describe("outreach drafts", () => {
  it("allows only one in-flight draft per contact", async () => {
    const { company, contact } = await createContact();
    await createDraft(company.id, contact.id, contact.email);
    await expect(createDraft(company.id, contact.id, contact.email)).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows a new draft once the previous one is finished", async () => {
    const { company, contact } = await createContact();
    const first = await createDraft(company.id, contact.id, contact.email);
    await db.outreachDraft.update({
      where: { id: first.id },
      data: {
        status: "SENT",
        rfcMessageId: "<a@ace.local>",
        sendAttemptedAt: new Date(),
        sentAt: new Date(),
        sendOutcome: "SUCCESS",
      },
    });
    await expect(createDraft(company.id, contact.id, contact.email)).resolves.toBeTruthy();
  });

  it("refuses SENDING without a pre-generated Message-ID", async () => {
    const { company, contact } = await createContact();
    const draft = await createDraft(company.id, contact.id, contact.email);
    await expect(db.outreachDraft.update({ where: { id: draft.id }, data: { status: "SENDING" } })).rejects.toThrow(
      /OutreachDraft_attempt_recorded/,
    );
  });

  it("refuses SENT without a recorded successful outcome", async () => {
    const { company, contact } = await createContact();
    const draft = await createDraft(company.id, contact.id, contact.email);
    await expect(
      db.outreachDraft.update({
        where: { id: draft.id },
        data: { status: "SENT", rfcMessageId: "<b@ace.local>", sendAttemptedAt: new Date(), sendOutcome: "UNKNOWN" },
      }),
    ).rejects.toThrow(/OutreachDraft_sent_has_success/);
  });

  it("rejects reusing a Message-ID across drafts", async () => {
    const { company, contact } = await createContact();
    const other = await createContact("someone@other.example");
    const a = await createDraft(company.id, contact.id, contact.email);
    const b = await createDraft(other.company.id, other.contact.id, other.contact.email);
    await db.outreachDraft.update({ where: { id: a.id }, data: { rfcMessageId: "<same@ace.local>" } });
    await expect(
      db.outreachDraft.update({ where: { id: b.id }, data: { rfcMessageId: "<same@ace.local>" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("prevents deleting a company that has outreach history", async () => {
    const { company, contact } = await createContact();
    await createDraft(company.id, contact.id, contact.email);
    await expect(db.company.delete({ where: { id: company.id } })).rejects.toThrow();
  });
});

describe("approvals", () => {
  it("allows only one live approval per draft", async () => {
    const { company, contact } = await createContact();
    const draft = await createDraft(company.id, contact.id, contact.email);
    const user = await createUser();
    const approval = {
      draftId: draft.id,
      recipientEmail: draft.recipientEmail,
      contentHash: draft.contentHash,
      approvedById: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    };

    const first = await db.approval.create({ data: approval });
    await expect(db.approval.create({ data: approval })).rejects.toMatchObject({ code: "P2002" });

    await db.approval.update({
      where: { id: first.id },
      data: { invalidatedAt: new Date(), invalidationReason: "content changed" },
    });
    await expect(db.approval.create({ data: approval })).resolves.toBeTruthy();
  });
});

describe("audit events", () => {
  it("are append-only", async () => {
    const event = await db.auditEvent.create({
      data: { actorType: "SYSTEM", action: "test.event", entityType: "Test" },
    });
    await expect(db.auditEvent.update({ where: { id: event.id }, data: { action: "tampered" } })).rejects.toThrow(
      /append-only/,
    );
    await expect(db.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
  });
});
