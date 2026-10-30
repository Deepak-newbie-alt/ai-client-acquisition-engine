import type { Db } from "../../lib/db.js";
import { AppError, notFound } from "../../lib/errors.js";
import { actorId, recordAudit, type Actor } from "../audit/audit.js";
import { assertMonthlyBudgetAvailable, type BudgetLimits } from "./budget.js";
import { buildSearchQuery, type ResearchFilters } from "./schemas.js";

export async function createResearchRun(db: Db, filters: ResearchFilters, actor: Actor, limits: BudgetLimits) {
  await assertMonthlyBudgetAvailable(db, limits);
  const run = await db.researchRun.create({
    data: {
      query: buildSearchQuery(filters),
      industry: filters.industry,
      country: filters.country,
      companySize: filters.companySize ?? null,
      keywords: filters.keywords,
      resultLimit: filters.resultLimit,
      requestedByType: actor.type,
      requestedById: actorId(actor),
    },
  });
  await recordAudit(db, {
    actor,
    action: "research_run.created",
    entityType: "ResearchRun",
    entityId: run.id,
    metadata: { industry: run.industry, country: run.country, resultLimit: run.resultLimit },
  });
  return run;
}

export async function cancelResearchRun(db: Db, runId: string, actor: Actor) {
  const result = await db.researchRun.updateMany({
    where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELLED" },
  });
  if (result.count === 0) {
    const exists = await db.researchRun.count({ where: { id: runId } });
    if (!exists) throw notFound("Research run");
    throw new AppError(409, "INVALID_STATE", "Only queued or running research runs can be cancelled");
  }
  await recordAudit(db, { actor, action: "research_run.cancel_requested", entityType: "ResearchRun", entityId: runId });
  return db.researchRun.findUniqueOrThrow({ where: { id: runId } });
}

/** Creates a new run with the same filters as a finished one. */
export async function retryResearchRun(db: Db, runId: string, actor: Actor, limits: BudgetLimits, maxResults: number) {
  const run = await db.researchRun.findUnique({ where: { id: runId } });
  if (!run) throw notFound("Research run");
  if (run.status === "QUEUED" || run.status === "RUNNING") {
    throw new AppError(409, "INVALID_STATE", "This research run has not finished yet");
  }
  return createResearchRun(
    db,
    {
      industry: run.industry,
      country: run.country,
      ...(run.companySize ? { companySize: run.companySize as ResearchFilters["companySize"] } : {}),
      keywords: run.keywords,
      resultLimit: Math.min(run.resultLimit, maxResults),
    },
    actor,
    limits,
  );
}
