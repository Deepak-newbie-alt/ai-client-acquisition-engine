import { Router, type RequestHandler } from "express";
import type { AppConfig } from "../../config/env.js";
import type { Db } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";
import { parseId } from "../../lib/validation.js";
import { requireUserOrScope } from "../../middleware/auth.js";
import type { Actor } from "../audit/audit.js";
import { monthlySpendMicros, monthStartUtc } from "./budget.js";
import type { ResearchQueueLike } from "./queue.js";
import { createResearchRunSchema, listRunsQuerySchema } from "./schemas.js";
import { cancelResearchRun, createResearchRun, retryResearchRun } from "./service.js";

const SOURCE_SUMMARY = {
  id: true,
  canonicalUrl: true,
  domain: true,
  registrableDomain: true,
  title: true,
  sourceType: true,
  retrievalStatus: true,
  skipReason: true,
  httpStatus: true,
  retrievedAt: true,
  _count: { select: { evidence: true } },
} as const;

export function researchRouter(deps: {
  db: Db;
  config: AppConfig;
  queue: ResearchQueueLike;
  createLimiter: RequestHandler;
}): Router {
  const { db, config, queue } = deps;
  const createSchema = createResearchRunSchema(config.limits.maxResultsPerRun);
  const router = Router();

  router.post("/", requireUserOrScope("research:write"), deps.createLimiter, async (req, res) => {
    const filters = createSchema.parse(req.body);
    const run = await createResearchRun(db, filters, req.actor as Actor, config.limits);
    queue.enqueue(run.id);
    res.status(202).json({ run });
  });

  router.get("/", requireUserOrScope("research:read"), async (req, res) => {
    const query = listRunsQuerySchema.parse(req.query);
    const runs = await db.researchRun.findMany({
      where: query.before ? { createdAt: { lt: new Date(query.before) } } : {},
      orderBy: { createdAt: "desc" },
      take: query.limit,
      include: { _count: { select: { sources: true, evidence: true } } },
    });
    res.json({ runs });
  });

  router.get("/:id", requireUserOrScope("research:read"), async (req, res) => {
    const run = await db.researchRun.findUnique({
      where: { id: parseId(req.params) },
      include: {
        sources: { orderBy: { searchRank: "asc" }, include: { source: { select: SOURCE_SUMMARY } } },
      },
    });
    if (!run) throw notFound("Research run");
    const { sources, ...rest } = run;
    res.json({
      run: rest,
      sources: sources.map((s) => ({ searchRank: s.searchRank, searchScore: s.searchScore, ...s.source })),
    });
  });

  // Evidence from every source linked to the run, including sources first
  // processed by an earlier run.
  router.get("/:id/evidence", requireUserOrScope("research:read"), async (req, res) => {
    const runId = parseId(req.params);
    if (!(await db.researchRun.count({ where: { id: runId } }))) throw notFound("Research run");
    const evidence = await db.evidence.findMany({
      // Rejected evidence is included (and marked) so reviewers can restore it.
      where: { source: { runs: { some: { runId } } } },
      orderBy: [{ sourceId: "asc" }, { extractedAt: "asc" }],
      include: { source: { select: { id: true, canonicalUrl: true, title: true, registrableDomain: true } } },
    });
    res.json({ evidence });
  });

  router.post("/:id/cancel", requireUserOrScope("research:write"), async (req, res) => {
    const run = await cancelResearchRun(db, parseId(req.params), req.actor as Actor);
    res.json({ run });
  });

  router.post("/:id/retry", requireUserOrScope("research:write"), deps.createLimiter, async (req, res) => {
    const run = await retryResearchRun(db, parseId(req.params), req.actor as Actor, config.limits, config.limits.maxResultsPerRun);
    queue.enqueue(run.id);
    res.status(202).json({ run });
  });

  return router;
}

export function sourcesRouter(db: Db): Router {
  const router = Router();
  router.get("/:id", requireUserOrScope("research:read"), async (req, res) => {
    const source = await db.sourceDocument.findUnique({
      where: { id: parseId(req.params) },
      include: { evidence: { orderBy: { extractedAt: "asc" } } },
    });
    if (!source) throw notFound("Source");
    res.json({ source });
  });
  return router;
}

/** This month's recorded spend against the configured budgets. */
export function usageRouter(deps: { db: Db; config: AppConfig }): Router {
  const router = Router();
  router.get("/", requireUserOrScope("research:read"), async (_req, res) => {
    const now = new Date();
    const monthStart = monthStartUtc(now);
    const byKind = await deps.db.usageEvent.groupBy({
      by: ["kind"],
      where: { createdAt: { gte: monthStart } },
      _sum: { costMicros: true },
    });
    res.json({
      monthStart,
      spentMicros: await monthlySpendMicros(deps.db, now),
      monthlyBudgetMicros: deps.config.limits.monthlyBudgetMicros,
      runBudgetMicros: deps.config.limits.runBudgetMicros,
      byKind: byKind.map((k) => ({ kind: k.kind, costMicros: k._sum.costMicros ?? 0n })),
    });
  });
  return router;
}
