import type { Prisma } from "../../generated/prisma/client.js";
import type { Db } from "../../lib/db.js";

export type Actor =
  | { type: "USER"; userId: string; role: "ADMIN" | "REVIEWER" }
  | { type: "SERVICE"; tokenId: string; scopes: readonly string[] }
  | { type: "SYSTEM" };

export const SYSTEM_ACTOR: Actor = { type: "SYSTEM" };

export function actorId(actor: Actor): string | null {
  return actor.type === "USER" ? actor.userId : actor.type === "SERVICE" ? actor.tokenId : null;
}

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential/i;
const MAX_STRING = 500;
const MAX_KEYS = 30;

type Primitive = string | number | boolean | null;

/**
 * Keeps only flat primitive metadata, drops anything whose key looks like a
 * credential, and truncates long strings. Audit rows are permanent, so this
 * errs on the side of recording less.
 */
export function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, Primitive> {
  const out: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, MAX_KEYS)) {
    if (SECRET_KEY.test(key)) continue;
    if (typeof value === "string") out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
    else if (typeof value === "bigint") out[key] = value.toString();
  }
  return out;
}

export interface AuditInput {
  actor: Actor;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(db: Db | Prisma.TransactionClient, input: AuditInput): Promise<void> {
  await db.auditEvent.create({
    data: {
      actorType: input.actor.type,
      actorId: actorId(input.actor),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      ...(input.metadata ? { metadata: sanitizeAuditMetadata(input.metadata) } : {}),
    },
  });
}
