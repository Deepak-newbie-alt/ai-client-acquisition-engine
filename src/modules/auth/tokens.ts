import { randomBytes } from "node:crypto";
import type { Db } from "../../lib/db.js";
import { sha256Hex } from "../../lib/hash.js";

export const SESSION_COOKIE = "ace_session";
export const SERVICE_TOKEN_PREFIX = "ace_st_";

/**
 * Scopes a service token (e.g. n8n) may hold. There is deliberately no scope
 * for drafting, approving or sending outreach: those require a signed-in user.
 * "outreach:sync" only checks sent threads for replies and opt-outs.
 */
export const SERVICE_SCOPES = ["research:read", "research:write", "outreach:sync"] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;

export const newOpaqueToken = (prefix = "") => `${prefix}${randomBytes(32).toString("base64url")}`;
export const hashToken = (token: string) => sha256Hex(token);

export async function createSession(db: Db, userId: string, ttlHours: number, now = new Date()) {
  const token = newOpaqueToken();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  const session = await db.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
  return { token, session };
}

/** Returns the session and user only if the session is live and the user enabled. */
export async function resolveSession(db: Db, token: string, now = new Date()) {
  if (token.length > 100) return null;
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt <= now || session.user.disabledAt) return null;
  if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  }
  return session;
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function createServiceToken(db: Db, name: string, scopes: readonly ServiceScope[]) {
  const token = newOpaqueToken(SERVICE_TOKEN_PREFIX);
  const record = await db.serviceToken.create({ data: { name, tokenHash: hashToken(token), scopes: [...scopes] } });
  return { token, record };
}

export async function resolveServiceToken(db: Db, token: string) {
  if (!token.startsWith(SERVICE_TOKEN_PREFIX) || token.length > 100) return null;
  const record = await db.serviceToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.revokedAt) return null;
  await db.serviceToken.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } });
  return record;
}
