import type { UsageKind } from "../../generated/prisma/enums.js";
import type { Db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";

export interface BudgetLimits {
  runBudgetMicros: bigint;
  monthlyBudgetMicros: bigint;
}

export class BudgetExceededError extends AppError {
  constructor(readonly scope: "RUN" | "MONTH") {
    super(
      429,
      "BUDGET_EXCEEDED",
      scope === "RUN" ? "The per-run usage budget has been reached" : "The monthly usage budget has been reached",
    );
  }
}

// Arbitrary constant key for pg_advisory_xact_lock; serializes budget checks.
const BUDGET_LOCK_KEY = 4_216_001;

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function monthlySpendMicros(db: Db, now: Date): Promise<bigint> {
  const agg = await db.usageEvent.aggregate({
    _sum: { costMicros: true },
    where: { createdAt: { gte: monthStartUtc(now) } },
  });
  return agg._sum.costMicros ?? 0n;
}

export async function assertMonthlyBudgetAvailable(db: Db, limits: BudgetLimits, now = new Date()): Promise<void> {
  if ((await monthlySpendMicros(db, now)) >= limits.monthlyBudgetMicros) throw new BudgetExceededError("MONTH");
}

export interface UsageReservation {
  id: string;
  estimateMicros: bigint;
}

/**
 * Records a usage event for the estimated worst-case cost before a paid call.
 * The check and insert happen under an advisory lock, so concurrent runs
 * cannot both pass the check and overspend together. A crash after the call
 * leaves the (conservative) estimate in the ledger.
 */
export async function reserveUsage(
  db: Db,
  // runId is null for usage outside research runs (e.g. drafting outreach); only the monthly budget applies.
  input: { runId: string | null; kind: UsageKind; provider: string; operation: string; estimateMicros: bigint },
  limits: BudgetLimits,
  now = new Date(),
): Promise<UsageReservation> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`;

    const [month, run] = await Promise.all([
      tx.usageEvent.aggregate({ _sum: { costMicros: true }, where: { createdAt: { gte: monthStartUtc(now) } } }),
      input.runId
        ? tx.usageEvent.aggregate({ _sum: { costMicros: true }, where: { runId: input.runId } })
        : Promise.resolve({ _sum: { costMicros: 0n } }),
    ]);
    const monthSpent = month._sum.costMicros ?? 0n;
    const runSpent = run._sum.costMicros ?? 0n;

    if (monthSpent + input.estimateMicros > limits.monthlyBudgetMicros || monthSpent >= limits.monthlyBudgetMicros) {
      throw new BudgetExceededError("MONTH");
    }
    if (input.runId && (runSpent + input.estimateMicros > limits.runBudgetMicros || runSpent >= limits.runBudgetMicros)) {
      throw new BudgetExceededError("RUN");
    }

    const event = await tx.usageEvent.create({
      data: {
        runId: input.runId,
        kind: input.kind,
        provider: input.provider,
        operation: input.operation,
        costMicros: input.estimateMicros,
      },
    });
    return { id: event.id, estimateMicros: input.estimateMicros };
  });
}

/**
 * Replaces the reservation with the actual cost and updates run counters.
 * Pass `actual = null` when the call failed without reporting usage; the
 * estimate is then kept as the recorded cost.
 */
export async function settleUsage(
  db: Db,
  reservation: UsageReservation,
  runId: string | null,
  kind: UsageKind,
  actual: { costMicros: bigint; inputTokens?: number; outputTokens?: number } | null,
): Promise<void> {
  const cost = actual?.costMicros ?? reservation.estimateMicros;
  const event = db.usageEvent.update({
    where: { id: reservation.id },
    data: {
      costMicros: cost,
      inputTokens: actual?.inputTokens ?? null,
      outputTokens: actual?.outputTokens ?? null,
    },
  });
  if (!runId) {
    await event;
    return;
  }
  await db.$transaction([
    event,
    db.researchRun.update({
      where: { id: runId },
      data: {
        costMicros: { increment: cost },
        ...(kind === "SEARCH"
          ? { searchCalls: { increment: 1 } }
          : {
              llmCalls: { increment: 1 },
              llmInputTokens: { increment: actual?.inputTokens ?? 0 },
              llmOutputTokens: { increment: actual?.outputTokens ?? 0 },
            }),
      },
    }),
  ]);
}
