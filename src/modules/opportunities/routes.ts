import { Router } from "express";
import { z } from "zod";
import type { ScoringConfig } from "../../config/scoring.js";
import type { Db } from "../../lib/db.js";
import { AppError, notFound } from "../../lib/errors.js";
import { parseId, safeMultilineText, safeText } from "../../lib/validation.js";
import { requireUser } from "../../middleware/auth.js";
import { recordAudit, type Actor } from "../audit/audit.js";
import { alternativeSchema, refreshOpportunities } from "./service.js";

const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  minCompanies: z.coerce.number().int().min(1).max(100).optional(),
});

const updateSchema = z
  .strictObject({
    title: safeText(3, 200),
    description: safeMultilineText(3, 4_000),
    segment: safeText(2, 120),
    buyer: safeText(2, 120),
    alternatives: z.array(alternativeSchema).max(20),
    validationQuestions: z.array(safeText(3, 300)).max(20),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "at least one field is required");

const mergeSchema = z.strictObject({ intoId: z.uuid() });
const evidenceUpdateSchema = z.strictObject({
  validationStatus: z.enum(["VALID", "REJECTED"]),
  validationNote: safeText(1, 500).nullable().optional(),
});

const SCORE_FIELDS = { component: true, value: true, weight: true, rationale: true, weightsVersion: true } as const;

export function opportunitiesRouter({ db, scoring }: { db: Db; scoring: ScoringConfig }): Router {
  const router = Router();
  router.use(requireUser());

  const refresh = () => refreshOpportunities(db, scoring);

  router.get("/", async (req, res) => {
    const query = listQuery.parse(req.query);
    const opportunities = await db.problemCluster.findMany({
      where: query.minCompanies ? { independentCompanyCount: { gte: query.minCompanies } } : {},
      orderBy: [{ totalScore: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: query.limit,
      include: { scores: { select: SCORE_FIELDS }, _count: { select: { evidence: true } } },
    });
    res.json({ opportunities });
  });

  router.get("/scoring", (_req, res) => {
    res.json({
      scoring,
      disclaimer: "Scores are heuristics for prioritizing review, not probabilities of commercial success.",
    });
  });

  router.post("/recompute", async (req, res) => {
    const result = await refresh();
    await recordAudit(db, { actor: req.actor as Actor, action: "opportunities.recomputed", entityType: "ProblemCluster", metadata: { ...result } });
    res.json(result);
  });

  router.get("/:id", async (req, res) => {
    const opportunity = await db.problemCluster.findUnique({
      where: { id: parseId(req.params) },
      include: {
        scores: { select: { ...SCORE_FIELDS, computedAt: true, evidence: { select: { evidenceId: true } } } },
        evidence: {
          orderBy: { createdAt: "asc" },
          include: {
            evidence: {
              include: {
                source: { select: { id: true, canonicalUrl: true, title: true, registrableDomain: true, companyId: true } },
              },
            },
          },
        },
      },
    });
    if (!opportunity) throw notFound("Opportunity");
    const { evidence, scores, ...rest } = opportunity;
    res.json({
      opportunity: rest,
      scores: scores.map(({ evidence: links, ...s }) => ({ ...s, evidenceIds: links.map((l) => l.evidenceId) })),
      evidence: evidence.map((l) => l.evidence),
    });
  });

  router.patch("/:id", async (req, res) => {
    const id = parseId(req.params);
    const data = updateSchema.parse(req.body);
    const updated = await db.problemCluster.updateMany({ where: { id }, data });
    if (updated.count === 0) throw notFound("Opportunity");
    await recordAudit(db, {
      actor: req.actor as Actor,
      action: "opportunity.updated",
      entityType: "ProblemCluster",
      entityId: id,
      metadata: { fields: Object.keys(data).join(",") },
    });
    await refresh();
    res.json({ opportunity: await db.problemCluster.findUniqueOrThrow({ where: { id } }) });
  });

  // Merges a duplicate cluster into another: its evidence moves, it is deleted.
  router.post("/:id/merge", async (req, res) => {
    const id = parseId(req.params);
    const { intoId } = mergeSchema.parse(req.body);
    if (id === intoId) throw new AppError(400, "INVALID_MERGE", "Cannot merge an opportunity into itself");
    await db.$transaction(async (tx) => {
      const found = await tx.problemCluster.count({ where: { id: { in: [id, intoId] } } });
      if (found !== 2) throw notFound("Opportunity");
      await tx.clusterEvidence.updateMany({ where: { clusterId: id }, data: { clusterId: intoId } });
      await tx.problemCluster.delete({ where: { id } });
      await recordAudit(tx, {
        actor: req.actor as Actor,
        action: "opportunity.merged",
        entityType: "ProblemCluster",
        entityId: intoId,
        metadata: { mergedFrom: id },
      });
    });
    await refresh();
    res.json({ opportunity: await db.problemCluster.findUniqueOrThrow({ where: { id: intoId } }) });
  });

  return router;
}

/** Reviewers can reject evidence (e.g. misread pages); it then drops out of clusters and scores. */
export function evidenceRouter({ db, scoring }: { db: Db; scoring: ScoringConfig }): Router {
  const router = Router();
  router.use(requireUser());

  router.patch("/:id", async (req, res) => {
    const id = parseId(req.params);
    const { validationStatus, validationNote } = evidenceUpdateSchema.parse(req.body);
    const updated = await db.evidence.updateMany({
      where: { id },
      data: { validationStatus, ...(validationNote !== undefined ? { validationNote } : {}) },
    });
    if (updated.count === 0) throw notFound("Evidence");
    await recordAudit(db, {
      actor: req.actor as Actor,
      action: `evidence.${validationStatus === "VALID" ? "restored" : "rejected"}`,
      entityType: "Evidence",
      entityId: id,
    });
    await refreshOpportunities(db, scoring);
    res.json({ evidence: await db.evidence.findUniqueOrThrow({ where: { id } }) });
  });

  return router;
}
