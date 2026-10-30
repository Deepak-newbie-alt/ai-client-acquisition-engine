import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { AppConfig } from "../../config/env.js";
import type { Db } from "../../lib/db.js";
import { normalizeEmail } from "../../lib/email.js";
import { AppError } from "../../lib/errors.js";
import { requireUser } from "../../middleware/auth.js";
import { recordAudit } from "../audit/audit.js";
import { MAX_PASSWORD_LENGTH, verifyAgainstDummy, verifyPassword } from "./password.js";
import { createSession, revokeSession, SESSION_COOKIE } from "./tokens.js";

const loginSchema = z.strictObject({
  email: z.string().trim().max(254),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const publicUser = (u: { id: string; email: string; displayName: string; role: string }) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
});

export function authRouter(deps: { db: Db; config: AppConfig; loginLimiter: RequestHandler }): Router {
  const { db, config } = deps;
  const router = Router();
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.nodeEnv === "production",
    path: "/api",
  };

  router.post("/login", deps.loginLimiter, async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await db.user.findUnique({ where: { email: normalizeEmail(email) } });
    const valid = user && !user.disabledAt ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDummy(password);
    if (!user || !valid) {
      await recordAudit(db, {
        actor: { type: "SYSTEM" },
        action: "auth.login_failed",
        entityType: "User",
        entityId: user?.id ?? null,
      });
      throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }

    const { token, session } = await createSession(db, user.id, config.limits.sessionTtlHours);
    await recordAudit(db, {
      actor: { type: "USER", userId: user.id, role: user.role },
      action: "auth.login",
      entityType: "User",
      entityId: user.id,
    });
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, expires: session.expiresAt });
    res.json({ user: publicUser(user) });
  });

  router.post("/logout", async (req, res) => {
    if (req.sessionId) await revokeSession(db, req.sessionId);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get("/me", requireUser(), async (req, res) => {
    const actor = req.actor;
    if (actor?.type !== "USER") throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    const user = await db.user.findUniqueOrThrow({ where: { id: actor.userId } });
    res.json({ user: publicUser(user) });
  });

  return router;
}
