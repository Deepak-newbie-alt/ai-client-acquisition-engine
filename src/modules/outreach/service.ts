import { randomUUID } from "node:crypto";
import type { AppConfig } from "../../config/env.js";
import { Prisma, type Contact, type OutreachDraft } from "../../generated/prisma/client.js";
import { EmailSendError, type EmailProvider } from "../../integrations/email/types.js";
import { LlmCallError, type LlmProvider } from "../../integrations/llm/types.js";
import type { Db } from "../../lib/db.js";
import { emailDomain, normalizeEmail } from "../../lib/email.js";
import { AppError, notFound } from "../../lib/errors.js";
import { outreachContentHash } from "../../lib/hash.js";
import type { Logger } from "../../lib/logger.js";
import { recordAudit, type Actor } from "../audit/audit.js";
import { isSuppressed } from "../contacts/suppression.js";
import { reserveUsage, settleUsage } from "../research/budget.js";
import {
  bodySchema,
  buildDraftPrompt,
  checkGeneratedDraft,
  DRAFT_MAX_OUTPUT_TOKENS,
  DRAFT_SYSTEM_PROMPT,
  generatedDraftSchema,
  isOptOut,
  subjectSchema,
  withFooter,
  type DraftFacts,
} from "./content.js";

export interface OutreachDeps {
  db: Db;
  email: EmailProvider;
  llm: LlmProvider;
  config: AppConfig;
  logger: Logger;
}

type Tx = Prisma.TransactionClient;
type UserActor = Extract<Actor, { type: "USER" }>;
type DraftWithContact = OutreachDraft & { contact: Contact };

const EDITABLE = ["DRAFT", "APPROVED"] as const;
const conflict = (code: string, message: string) => new AppError(409, code, message);
const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

const contentOf = (d: Pick<OutreachDraft, "recipientEmail" | "subject" | "body">) => ({
  recipientEmail: d.recipientEmail,
  subject: d.subject,
  body: d.body,
});

/** Row lock: concurrent edits, approvals and sends of one draft are serialized. */
async function lockDraft(tx: Tx, id: string): Promise<DraftWithContact> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "OutreachDraft" WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw notFound("Draft");
  return tx.outreachDraft.findUniqueOrThrow({ where: { id }, include: { contact: true } });
}

async function invalidateApprovals(tx: Tx, draftId: string, reason: string, now: Date): Promise<number> {
  const result = await tx.approval.updateMany({
    where: { draftId, invalidatedAt: null, consumedAt: null },
    data: { invalidatedAt: now, invalidationReason: reason },
  });
  return result.count;
}

/** Reasons a draft must not be approved or sent to this contact right now, or null. */
async function recipientBlock(
  tx: Pick<Db, "suppressionRecord" | "outreachDraft">,
  contact: Contact,
  followUpOfId: string | null,
): Promise<{ code: string; message: string } | null> {
  if (contact.verificationStatus === "INVALID") {
    return { code: "CONTACT_INVALID", message: "This address was not found on its source page" };
  }
  if (await isSuppressed(tx, contact.emailNormalized)) {
    return { code: "SUPPRESSED", message: "This recipient is on the suppression list" };
  }
  if (followUpOfId) {
    const original = await tx.outreachDraft.findUnique({ where: { id: followUpOfId } });
    if (!original || original.status !== "SENT" || original.contactId !== contact.id) {
      return { code: "INVALID_FOLLOW_UP", message: "A follow-up must refer to an email already sent to this contact" };
    }
    if (original.repliedAt || original.optedOutAt) {
      return { code: "REPLIED", message: "The recipient has replied; follow-ups stop after a reply" };
    }
  }
  return null;
}

async function assertRecipientAllowed(tx: Pick<Db, "suppressionRecord" | "outreachDraft">, contact: Contact, followUpOfId: string | null) {
  const block = await recipientBlock(tx, contact, followUpOfId);
  if (block) throw conflict(block.code, block.message);
}

// --- Creating drafts ---------------------------------------------------------

export interface CreateDraftInput {
  contactId: string;
  opportunityId?: string | undefined;
  followUpOfId?: string | undefined;
  mode: "generate" | "manual";
  subject?: string | undefined;
  /** Manual mode: the message text; the footer is appended by the server. */
  body?: string | undefined;
}

/** Creates a DRAFT. Generating a draft never sends anything. */
export async function createDraft(deps: OutreachDeps, input: CreateDraftInput, actor: UserActor): Promise<OutreachDraft> {
  const { db } = deps;
  const contact = await db.contact.findUnique({ where: { id: input.contactId }, include: { company: true } });
  if (!contact) throw notFound("Contact");
  await assertRecipientAllowed(db, contact, input.followUpOfId ?? null);

  let subject: string;
  let text: string;
  let generatedByModel: string | null = null;
  if (input.mode === "manual") {
    if (!input.subject || !input.body) throw new AppError(400, "VALIDATION_ERROR", "subject and body are required for manual drafts");
    subject = input.subject;
    text = input.body;
  } else {
    const facts = await draftFacts(db, contact, input.opportunityId ?? null, Boolean(input.followUpOfId), deps.config);
    ({ subject, body: text } = await generateDraftText(deps, facts));
    generatedByModel = deps.llm.model;
  }

  return insertDraft(db, {
    contact,
    opportunityId: input.opportunityId ?? null,
    followUpOfId: input.followUpOfId ?? null,
    subject,
    body: withFooter(text, deps.config.outreach),
    generatedByModel,
    actor,
    action: input.mode === "manual" ? "draft.created" : "draft.generated",
  });
}

async function insertDraft(
  db: Db,
  args: {
    contact: Contact;
    opportunityId: string | null;
    followUpOfId: string | null;
    subject: string;
    body: string;
    generatedByModel: string | null;
    actor: UserActor;
    action: string;
  },
): Promise<OutreachDraft> {
  const valid = validateContent(args.subject, args.body);
  if (args.opportunityId && !(await db.problemCluster.count({ where: { id: args.opportunityId } }))) throw notFound("Opportunity");

  const content = { recipientEmail: args.contact.emailNormalized, ...valid };
  const draft = await db.outreachDraft
    .create({
      data: {
        companyId: args.contact.companyId,
        contactId: args.contact.id,
        opportunityId: args.opportunityId,
        followUpOfId: args.followUpOfId,
        ...content,
        contentHash: outreachContentHash(content),
        createdByType: "USER",
        createdById: args.actor.userId,
        generatedByModel: args.generatedByModel,
      },
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) throw conflict("ACTIVE_DRAFT_EXISTS", "This contact already has an outreach draft in progress");
      throw err;
    });
  await recordAudit(db, {
    actor: args.actor,
    action: args.action,
    entityType: "OutreachDraft",
    entityId: draft.id,
    metadata: { contactId: args.contact.id, generatedByModel: args.generatedByModel },
  });
  return draft;
}

async function draftFacts(
  db: Db,
  contact: Contact & { company: { name: string; domain: string } },
  opportunityId: string | null,
  isFollowUp: boolean,
  config: AppConfig,
): Promise<DraftFacts> {
  let problem: DraftFacts["problem"] = null;
  let evidence: DraftFacts["evidence"] = [];
  if (opportunityId) {
    const cluster = await db.problemCluster.findUnique({
      where: { id: opportunityId },
      include: { evidence: { include: { evidence: { include: { source: { select: { canonicalUrl: true, companyId: true } } } } } } },
    });
    if (!cluster) throw notFound("Opportunity");
    problem = { title: cluster.title, description: cluster.description };
    const items = cluster.evidence.map(({ evidence: e }) => ({
      excerpt: e.excerpt,
      sourceUrl: e.source.canonicalUrl,
      fromThisCompany: e.source.companyId === contact.companyId,
    }));
    // Prefer what the recipient's own business published; cap what the model sees.
    evidence = [...items.filter((e) => e.fromThisCompany).slice(0, 2), ...items.filter((e) => !e.fromThisCompany).slice(0, 1)];
  }
  return {
    senderName: config.outreach.senderName,
    company: { name: contact.company.name, domain: contact.company.domain },
    contact: { name: contact.name, role: contact.role },
    problem,
    evidence,
    isFollowUp,
  };
}

async function generateDraftText(deps: OutreachDeps, facts: DraftFacts): Promise<{ subject: string; body: string }> {
  const { db, llm, config } = deps;
  const prompt = buildDraftPrompt(facts);
  const reservation = await reserveUsage(
    db,
    {
      runId: null,
      kind: "LLM",
      provider: llm.name,
      operation: "draft_outreach",
      estimateMicros: llm.estimateCostMicros({ inputChars: DRAFT_SYSTEM_PROMPT.length + prompt.length, maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS }),
    },
    config.limits,
  );

  let result;
  try {
    result = await llm.generateJson({
      task: "outreach_draft",
      system: DRAFT_SYSTEM_PROMPT,
      prompt,
      schema: generatedDraftSchema,
      maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    await settleUsage(db, reservation, null, "LLM", err instanceof LlmCallError ? (err.usage ?? null) : null);
    deps.logger.warn({ err }, "draft generation failed");
    throw new AppError(502, "GENERATION_FAILED", "The draft could not be generated; write it manually or try again");
  }
  await settleUsage(db, reservation, null, "LLM", result.usage);

  const checked = checkGeneratedDraft(result.data);
  if (!checked.ok) throw new AppError(422, "GENERATION_REJECTED", `${checked.reason}; write it manually or try again`);
  return checked;
}

/** Starts a fresh DRAFT from a failed, rejected or cancelled one. It needs a new approval. */
export async function reviseDraft(deps: OutreachDeps, id: string, actor: UserActor): Promise<OutreachDraft> {
  const source = await deps.db.outreachDraft.findUnique({ where: { id }, include: { contact: true } });
  if (!source) throw notFound("Draft");
  if (!["FAILED", "REJECTED", "CANCELLED"].includes(source.status)) {
    throw conflict("INVALID_STATE", "Only failed, rejected or cancelled drafts can be revised");
  }
  await assertRecipientAllowed(deps.db, source.contact, source.followUpOfId);
  return insertDraft(deps.db, {
    contact: source.contact,
    opportunityId: source.opportunityId,
    followUpOfId: source.followUpOfId,
    subject: source.subject,
    body: source.body,
    generatedByModel: source.generatedByModel,
    actor,
    action: "draft.revised",
  });
}

// --- Editing, approving, rejecting ---------------------------------------------

export interface UpdateDraftInput {
  /** The hash of the version the editor started from (optimistic concurrency). */
  expectedContentHash: string;
  subject?: string | undefined;
  body?: string | undefined;
  contactId?: string | undefined;
}

function validateContent(subject: string, body: string): { subject: string; body: string } {
  const s = subjectSchema.safeParse(subject);
  const b = bodySchema.safeParse(body);
  if (!s.success || !b.success) {
    throw new AppError(422, "INVALID_CONTENT", "Subject or body is not acceptable", [
      ...(s.error?.issues ?? []).map((i) => ({ path: "subject", message: i.message })),
      ...(b.error?.issues ?? []).map((i) => ({ path: "body", message: i.message })),
    ]);
  }
  return { subject: s.data, body: b.data };
}

/**
 * Edits subject, body or recipient. Any change to the approved content or
 * recipient invalidates the approval and returns the draft to DRAFT.
 */
export async function updateDraft(deps: OutreachDeps, id: string, input: UpdateDraftInput, actor: UserActor) {
  const now = new Date();
  return deps.db
    .$transaction(async (tx) => {
      const draft = await lockDraft(tx, id);
      if (!(EDITABLE as readonly string[]).includes(draft.status)) throw conflict("NOT_EDITABLE", `A ${draft.status} draft cannot be edited`);
      if (input.expectedContentHash !== draft.contentHash) throw conflict("STALE_CONTENT", "The draft changed since you loaded it; reload and try again");

      let contact = draft.contact;
      if (input.contactId && input.contactId !== draft.contactId) {
        const next = await tx.contact.findUnique({ where: { id: input.contactId } });
        if (!next || next.companyId !== draft.companyId) throw new AppError(400, "INVALID_CONTACT", "The recipient must be a contact of the same company");
        await assertRecipientAllowed(tx, next, draft.followUpOfId);
        contact = next;
      }

      const content = {
        recipientEmail: contact.emailNormalized,
        ...validateContent(input.subject ?? draft.subject, input.body ?? draft.body),
      };
      const contentHash = outreachContentHash(content);
      if (contentHash === draft.contentHash) return { draft, approvalInvalidated: false };

      const invalidated = await invalidateApprovals(tx, id, "Content or recipient changed after approval", now);
      const updated = await tx.outreachDraft.update({
        where: { id },
        data: { contactId: contact.id, ...content, contentHash, status: "DRAFT" },
      });
      await recordAudit(tx, {
        actor,
        action: "draft.updated",
        entityType: "OutreachDraft",
        entityId: id,
        metadata: { approvalInvalidated: invalidated > 0, recipientChanged: contact.id !== draft.contactId },
      });
      return { draft: updated, approvalInvalidated: invalidated > 0 };
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) throw conflict("ACTIVE_DRAFT_EXISTS", "That contact already has an outreach draft in progress");
      throw err;
    });
}

/** Approves exactly the content identified by `contentHash`, which the reviewer was shown. */
export async function approveDraft(deps: OutreachDeps, id: string, contentHash: string, actor: UserActor) {
  const now = new Date();
  return deps.db.$transaction(async (tx) => {
    const draft = await lockDraft(tx, id);
    if (draft.status === "APPROVED") throw conflict("ALREADY_APPROVED", "This draft is already approved");
    if (draft.status !== "DRAFT") throw conflict("INVALID_STATE", `A ${draft.status} draft cannot be approved`);
    if (outreachContentHash(contentOf(draft)) !== draft.contentHash) throw conflict("INTEGRITY", "Stored content does not match its hash");
    if (contentHash !== draft.contentHash) throw conflict("STALE_CONTENT", "The draft changed since you reviewed it; review it again");
    await assertRecipientAllowed(tx, draft.contact, draft.followUpOfId);

    const approval = await tx.approval.create({
      data: {
        draftId: id,
        recipientEmail: normalizeEmail(draft.recipientEmail),
        contentHash: draft.contentHash,
        approvedById: actor.userId,
        expiresAt: new Date(now.getTime() + deps.config.limits.approvalTtlMinutes * 60_000),
      },
    });
    const updated = await tx.outreachDraft.update({ where: { id }, data: { status: "APPROVED" } });
    await recordAudit(tx, {
      actor,
      action: "draft.approved",
      entityType: "OutreachDraft",
      entityId: id,
      metadata: { approvalId: approval.id, contentHash: draft.contentHash, expiresAt: approval.expiresAt.toISOString() },
    });
    return { draft: updated, approval };
  });
}

export async function closeDraft(deps: OutreachDeps, id: string, status: "REJECTED" | "CANCELLED", actor: UserActor) {
  const now = new Date();
  return deps.db.$transaction(async (tx) => {
    const draft = await lockDraft(tx, id);
    if (!(EDITABLE as readonly string[]).includes(draft.status)) {
      throw conflict("INVALID_STATE", `A ${draft.status} draft cannot be ${status.toLowerCase()}`);
    }
    await invalidateApprovals(tx, id, status === "REJECTED" ? "Draft rejected" : "Draft cancelled", now);
    const updated = await tx.outreachDraft.update({ where: { id }, data: { status } });
    await recordAudit(tx, { actor, action: `draft.${status.toLowerCase()}`, entityType: "OutreachDraft", entityId: id });
    return updated;
  });
}

// --- Sending ------------------------------------------------------------------

export type SendResult = { outcome: "SENT" | "FAILED" | "UNKNOWN"; draft: OutreachDraft };

/**
 * Sends an approved draft. Everything is re-validated under a row lock
 * immediately before sending; the approval is consumed and the draft moves
 * to SENDING in the same transaction, so a concurrent or repeated request
 * finds SENDING and is refused. The provider is called once, after commit.
 * An uncertain outcome leaves the draft in SENDING for reconciliation; it is
 * never resent automatically.
 */
export async function sendDraft(deps: OutreachDeps, id: string, contentHash: string, actor: UserActor): Promise<SendResult> {
  const { db, email, config } = deps;
  const now = new Date();

  const prepared = await db.$transaction(async (tx) => {
    const draft = await lockDraft(tx, id);
    if (draft.status === "SENDING") {
      throw conflict("SEND_IN_PROGRESS", "This draft is already being sent or its outcome is uncertain; reconcile it instead");
    }
    if (draft.status === "SENT") throw conflict("ALREADY_SENT", "This draft has already been sent");
    if (draft.status !== "APPROVED") throw conflict("NOT_APPROVED", "Only approved drafts can be sent");

    if (outreachContentHash(contentOf(draft)) !== draft.contentHash || contentHash !== draft.contentHash) {
      throw conflict("STALE_CONTENT", "The content differs from what was approved; review it again");
    }
    const approval = await tx.approval.findFirst({ where: { draftId: id, invalidatedAt: null, consumedAt: null } });
    if (!approval || approval.contentHash !== draft.contentHash || approval.recipientEmail !== normalizeEmail(draft.recipientEmail)) {
      throw conflict("NOT_APPROVED", "There is no valid approval for this exact content and recipient");
    }

    // Problems found now are recorded (so they are not committed as half-done)
    // and reported after the transaction.
    if (approval.expiresAt <= now) {
      await invalidateApprovals(tx, id, "Approval expired", now);
      await tx.outreachDraft.update({ where: { id }, data: { status: "DRAFT" } });
      await recordAudit(tx, { actor, action: "draft.approval_expired", entityType: "OutreachDraft", entityId: id });
      return { kind: "blocked", code: "APPROVAL_EXPIRED", message: "The approval expired; review and approve the draft again" } as const;
    }
    const block = await recipientBlock(tx, draft.contact, draft.followUpOfId);
    if (block) {
      await invalidateApprovals(tx, id, `Send blocked: ${block.code}`, now);
      await tx.outreachDraft.update({ where: { id }, data: { status: "CANCELLED", failureReason: block.message } });
      await recordAudit(tx, { actor, action: "draft.send_blocked", entityType: "OutreachDraft", entityId: id, metadata: { reason: block.code } });
      return { kind: "blocked", ...block } as const;
    }

    await tx.approval.update({ where: { id: approval.id }, data: { consumedAt: now } });
    const rfcMessageId = `<${randomUUID()}@${emailDomain(email.senderAddress)}>`;
    const sending = await tx.outreachDraft.update({
      where: { id },
      data: { status: "SENDING", rfcMessageId, sendAttemptedAt: now, sendOutcome: null, failureReason: null },
    });
    await recordAudit(tx, {
      actor,
      action: "draft.send_started",
      entityType: "OutreachDraft",
      entityId: id,
      metadata: { approvalId: approval.id, provider: email.name },
    });
    return { kind: "ready", draft: sending } as const;
  });

  if (prepared.kind === "blocked") throw conflict(prepared.code, prepared.message);
  const draft = prepared.draft;

  try {
    const sent = await email.send({
      from: { name: config.outreach.senderName, address: email.senderAddress },
      to: draft.recipientEmail,
      subject: draft.subject,
      body: draft.body,
      rfcMessageId: draft.rfcMessageId!,
      listUnsubscribe: `<mailto:${email.senderAddress}?subject=unsubscribe>`,
    });
    const updated = await markSent(db, id, sent, new Date());
    await recordAudit(db, { actor, action: "draft.sent", entityType: "OutreachDraft", entityId: id, metadata: { provider: email.name } });
    return { outcome: "SENT", draft: updated };
  } catch (err) {
    const sendError =
      err instanceof EmailSendError ? err : new EmailSendError("UNKNOWN", "UNEXPECTED", "Unexpected error while sending; outcome unknown");
    if (sendError.outcome === "FAILURE") {
      const updated = await db.outreachDraft.update({
        where: { id },
        data: { status: "FAILED", sendOutcome: "FAILURE", failureReason: sendError.message, providerResult: { code: sendError.code } },
      });
      await recordAudit(db, { actor, action: "draft.send_failed", entityType: "OutreachDraft", entityId: id, metadata: { code: sendError.code } });
      return { outcome: "FAILED", draft: updated };
    }
    deps.logger.warn({ err, draftId: id }, "send outcome unknown");
    const updated = await db.outreachDraft.update({
      where: { id },
      data: { sendOutcome: "UNKNOWN", failureReason: sendError.message, providerResult: { code: sendError.code } },
    });
    await recordAudit(db, { actor, action: "draft.send_uncertain", entityType: "OutreachDraft", entityId: id, metadata: { code: sendError.code } });
    return { outcome: "UNKNOWN", draft: updated };
  }
}

async function markSent(db: Db, id: string, sent: { providerMessageId: string; threadId: string | null }, at: Date) {
  return db.outreachDraft.update({
    where: { id },
    data: {
      status: "SENT",
      sendOutcome: "SUCCESS",
      sentAt: at,
      providerMessageId: sent.providerMessageId,
      providerThreadId: sent.threadId,
      failureReason: null,
      providerResult: { providerMessageId: sent.providerMessageId },
    },
  });
}

/**
 * Resolves a SENDING draft by looking its Message-ID up in the provider's sent
 * mail. Found: SENT. Not found after the grace period: FAILED (treated as not
 * sent; it can be revised and re-approved). Never resends.
 */
export async function reconcileDraft(deps: OutreachDeps, id: string, actor: UserActor) {
  const { db, email, config } = deps;
  const draft = await db.outreachDraft.findUnique({ where: { id } });
  if (!draft) throw notFound("Draft");
  if (draft.status !== "SENDING" || !draft.rfcMessageId || !draft.sendAttemptedAt) {
    throw conflict("INVALID_STATE", "Only drafts with an unconfirmed send can be reconciled");
  }

  let found;
  try {
    found = await email.findSent(draft.rfcMessageId);
  } catch (err) {
    deps.logger.warn({ err, draftId: id }, "reconcile lookup failed");
    throw new AppError(502, "RECONCILE_FAILED", "Could not search sent mail; try again later");
  }

  if (found) {
    const updated = await markSent(db, id, found, new Date());
    await recordAudit(db, { actor, action: "draft.reconciled_sent", entityType: "OutreachDraft", entityId: id });
    return updated;
  }

  const graceMs = config.outreach.reconcileGraceMinutes * 60_000;
  const waited = Date.now() - draft.sendAttemptedAt.getTime();
  if (waited < graceMs) {
    throw conflict(
      "RECONCILE_TOO_EARLY",
      `Not found in sent mail yet (search can lag). Try again in ${Math.ceil((graceMs - waited) / 60_000)} minute(s).`,
    );
  }
  const updated = await db.outreachDraft.update({
    where: { id },
    data: {
      status: "FAILED",
      sendOutcome: "FAILURE",
      failureReason: `Not found in sent mail ${config.outreach.reconcileGraceMinutes}+ minutes after the attempt; treated as not sent`,
    },
  });
  await recordAudit(db, { actor, action: "draft.reconciled_not_sent", entityType: "OutreachDraft", entityId: id });
  return updated;
}

// --- Replies and opt-outs -------------------------------------------------------

/**
 * Records a reply: stops follow-ups to this contact and, for an opt-out, adds
 * the address to the suppression list and cancels every pending draft.
 */
async function recordReply(db: Db, draft: OutreachDraft, optOut: boolean, at: Date, actor: Actor): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.outreachDraft.update({
      where: { id: draft.id },
      data: { repliedAt: draft.repliedAt ?? at, ...(optOut ? { optedOutAt: draft.optedOutAt ?? at } : {}) },
    });
    if (optOut) {
      await tx.suppressionRecord.upsert({
        where: { scope_value: { scope: "EMAIL", value: normalizeEmail(draft.recipientEmail) } },
        create: { scope: "EMAIL", value: normalizeEmail(draft.recipientEmail), reason: "Recipient opted out by reply", source: "reply" },
        update: {},
      });
    }
    const pending = await tx.outreachDraft.findMany({
      where: { contactId: draft.contactId, status: { in: ["DRAFT", "APPROVED"] }, ...(optOut ? {} : { followUpOfId: { not: null } }) },
      select: { id: true },
    });
    for (const p of pending) {
      await invalidateApprovals(tx, p.id, "Recipient replied", at);
      await tx.outreachDraft.update({ where: { id: p.id }, data: { status: "CANCELLED", failureReason: "Recipient replied" } });
    }
    await recordAudit(tx, {
      actor,
      action: optOut ? "draft.opted_out" : "draft.replied",
      entityType: "OutreachDraft",
      entityId: draft.id,
      metadata: { cancelledDrafts: pending.length },
    });
  });
}

export async function markReplied(deps: OutreachDeps, id: string, optOut: boolean, actor: UserActor) {
  const draft = await deps.db.outreachDraft.findUnique({ where: { id } });
  if (!draft) throw notFound("Draft");
  if (draft.status !== "SENT") throw conflict("INVALID_STATE", "Only sent emails can receive replies");
  await recordReply(deps.db, draft, optOut, new Date(), actor);
  return deps.db.outreachDraft.findUniqueOrThrow({ where: { id } });
}

const REPLY_WINDOW_DAYS = 90;

/** Checks recent sent threads for replies (safe for automation: reads mail, never sends). */
export async function checkReplies(deps: OutreachDeps, actor: Actor) {
  const since = new Date(Date.now() - REPLY_WINDOW_DAYS * 86_400_000);
  const drafts = await deps.db.outreachDraft.findMany({
    where: { status: "SENT", repliedAt: null, providerThreadId: { not: null }, sentAt: { gte: since } },
    orderBy: { sentAt: "asc" },
    take: 200,
  });
  const result = { checked: drafts.length, replied: 0, optedOut: 0, errors: 0 };
  for (const draft of drafts) {
    try {
      const replies = await deps.email.repliesInThread(draft.providerThreadId!, draft.sentAt!);
      if (replies.length === 0) continue;
      const optOut = replies.some((r) => isOptOut(r.text));
      const firstAt = replies.reduce((min, r) => (r.receivedAt < min ? r.receivedAt : min), replies[0]!.receivedAt);
      await recordReply(deps.db, draft, optOut, firstAt, actor);
      result.replied++;
      if (optOut) result.optedOut++;
    } catch (err) {
      result.errors++;
      deps.logger.warn({ err, draftId: draft.id }, "reply check failed");
    }
  }
  return result;
}
