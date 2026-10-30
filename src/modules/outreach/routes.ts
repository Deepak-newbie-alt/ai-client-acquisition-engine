import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { notFound } from "../../lib/errors.js";
import { parseId, safeMultilineText } from "../../lib/validation.js";
import { requireUser, requireUserOrScope } from "../../middleware/auth.js";
import type { Actor } from "../audit/audit.js";
import { suppressionMatcher } from "../contacts/suppression.js";
import { subjectSchema } from "./content.js";
import {
  approveDraft,
  checkReplies,
  closeDraft,
  createDraft,
  markReplied,
  reconcileDraft,
  reviseDraft,
  sendDraft,
  updateDraft,
  type OutreachDeps,
} from "./service.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/, "must be a content hash");

const createSchema = z
  .strictObject({
    contactId: z.uuid(),
    opportunityId: z.uuid().optional(),
    followUpOfId: z.uuid().optional(),
    mode: z.enum(["generate", "manual"]),
    subject: subjectSchema.optional(),
    body: safeMultilineText(20, 4_000).optional(),
  })
  .refine((v) => v.mode === "generate" || (v.subject && v.body), "subject and body are required for manual drafts");

const updateSchema = z.strictObject({
  expectedContentHash: hash,
  subject: z.string().max(200).optional(),
  body: z.string().max(6_000).optional(),
  contactId: z.uuid().optional(),
});

const hashBody = z.strictObject({ contentHash: hash });
const repliedSchema = z.strictObject({ optOut: z.boolean() });
const listQuery = z.strictObject({
  status: z.enum(["DRAFT", "APPROVED", "SENDING", "SENT", "REJECTED", "CANCELLED", "FAILED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const DRAFT_SUMMARY = {
  contact: { select: { id: true, email: true, name: true, role: true } },
  company: { select: { id: true, name: true, domain: true } },
  opportunity: { select: { id: true, title: true } },
} as const;

/**
 * Outreach is user-only: every action that can lead to an email requires a
 * signed-in person. The one exception is the reply check, which only reads
 * mail and can stop outreach, so automation may run it on a schedule.
 */
export function outreachRouter(deps: OutreachDeps & { sendLimiter: RequestHandler; generateLimiter: RequestHandler }): Router {
  const { db } = deps;
  const router = Router();
  const user = (actor: Actor | undefined) => actor as Extract<Actor, { type: "USER" }>;

  router.post("/check-replies", requireUserOrScope("outreach:sync"), async (req, res) => {
    res.json(await checkReplies(deps, req.actor as Actor));
  });

  router.use(requireUser());

  router.get("/drafts", async (req, res) => {
    const q = listQuery.parse(req.query);
    const drafts = await db.outreachDraft.findMany({
      where: q.status ? { status: q.status } : {},
      orderBy: { updatedAt: "desc" },
      take: q.limit,
      include: DRAFT_SUMMARY,
    });
    res.json({ drafts });
  });

  router.post("/drafts", deps.generateLimiter, async (req, res) => {
    const input = createSchema.parse(req.body);
    res.status(201).json({ draft: await createDraft(deps, input, user(req.actor)) });
  });

  router.get("/drafts/:id", async (req, res) => {
    const id = parseId(req.params);
    const draft = await db.outreachDraft.findUnique({
      where: { id },
      include: {
        ...DRAFT_SUMMARY,
        contact: { select: { id: true, email: true, emailNormalized: true, name: true, role: true, verificationStatus: true, sourceUrl: true } },
        approvals: { orderBy: { approvedAt: "desc" }, take: 10, include: { approvedBy: { select: { displayName: true, email: true } } } },
        followUpOf: { select: { id: true, subject: true, sentAt: true, repliedAt: true } },
        followUps: { select: { id: true, status: true, subject: true } },
      },
    });
    if (!draft) throw notFound("Draft");
    const suppressed = suppressionMatcher(await db.suppressionRecord.findMany({ select: { scope: true, value: true } }));
    const otherContacts = await db.contact.findMany({
      where: { companyId: draft.companyId },
      select: { id: true, email: true, name: true, verificationStatus: true },
    });
    res.json({ draft, recipientSuppressed: suppressed(draft.recipientEmail), companyContacts: otherContacts, provider: deps.email.name });
  });

  router.patch("/drafts/:id", async (req, res) => {
    const input = updateSchema.parse(req.body);
    res.json(await updateDraft(deps, parseId(req.params), input, user(req.actor)));
  });

  router.post("/drafts/:id/approve", async (req, res) => {
    const { contentHash } = hashBody.parse(req.body);
    res.json(await approveDraft(deps, parseId(req.params), contentHash, user(req.actor)));
  });

  router.post("/drafts/:id/send", deps.sendLimiter, async (req, res) => {
    const { contentHash } = hashBody.parse(req.body);
    res.json(await sendDraft(deps, parseId(req.params), contentHash, user(req.actor)));
  });

  router.post("/drafts/:id/reject", async (req, res) => {
    res.json({ draft: await closeDraft(deps, parseId(req.params), "REJECTED", user(req.actor)) });
  });

  router.post("/drafts/:id/cancel", async (req, res) => {
    res.json({ draft: await closeDraft(deps, parseId(req.params), "CANCELLED", user(req.actor)) });
  });

  router.post("/drafts/:id/reconcile", async (req, res) => {
    res.json({ draft: await reconcileDraft(deps, parseId(req.params), user(req.actor)) });
  });

  router.post("/drafts/:id/revise", async (req, res) => {
    res.status(201).json({ draft: await reviseDraft(deps, parseId(req.params), user(req.actor)) });
  });

  router.post("/drafts/:id/replied", async (req, res) => {
    const { optOut } = repliedSchema.parse(req.body);
    res.json({ draft: await markReplied(deps, parseId(req.params), optOut, user(req.actor)) });
  });

  return router;
}
