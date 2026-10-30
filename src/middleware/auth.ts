import { parseCookie } from "cookie";
import type { RequestHandler } from "express";
import type { UserRole } from "../generated/prisma/enums.js";
import type { Db } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import type { Actor } from "../modules/audit/audit.js";
import { resolveServiceToken, resolveSession, SESSION_COOKIE, type ServiceScope } from "../modules/auth/tokens.js";

declare module "express-serve-static-core" {
  interface Request {
    actor?: Actor;
    authMethod?: "session" | "bearer";
    sessionId?: string;
  }
}

const unauthorized = () => new AppError(401, "UNAUTHENTICATED", "Authentication required");
const forbidden = () => new AppError(403, "FORBIDDEN", "You are not allowed to perform this action");

/**
 * Identifies the caller from a bearer service token or a session cookie.
 * A present-but-invalid bearer token is rejected outright rather than
 * silently falling back to anonymous.
 */
export function authenticate(db: Db): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get("authorization");
    if (header !== undefined) {
      const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
      const record = token ? await resolveServiceToken(db, token) : null;
      if (!record) throw unauthorized();
      req.actor = { type: "SERVICE", tokenId: record.id, scopes: record.scopes };
      req.authMethod = "bearer";
      return next();
    }

    const cookieToken = parseCookie(req.get("cookie") ?? "")[SESSION_COOKIE];
    if (cookieToken) {
      const session = await resolveSession(db, cookieToken);
      if (session) {
        req.actor = { type: "USER", userId: session.userId, role: session.user.role };
        req.authMethod = "session";
        req.sessionId = session.id;
      }
    }
    next();
  };
}

/** Only signed-in users, optionally restricted to roles. Service tokens are always refused. */
export function requireUser(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor) throw unauthorized();
    if (req.actor.type !== "USER" || (roles.length > 0 && !roles.includes(req.actor.role))) throw forbidden();
    next();
  };
}

/** Any signed-in user, or a service token holding the given scope. */
export function requireUserOrScope(scope: ServiceScope): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor) throw unauthorized();
    if (req.actor.type === "USER") return next();
    if (req.actor.type === "SERVICE" && req.actor.scopes.includes(scope)) return next();
    throw forbidden();
  };
}
