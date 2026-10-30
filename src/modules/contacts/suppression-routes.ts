import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import type { Db } from "../../lib/db.js";
import { isValidEmail, normalizeEmail } from "../../lib/email.js";
import { AppError, notFound } from "../../lib/errors.js";
import { parseId, safeText } from "../../lib/validation.js";
import { requireUser } from "../../middleware/auth.js";
import { actorId, recordAudit, type Actor } from "../audit/audit.js";

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const createSuppressionSchema = z
  .strictObject({
    scope: z.enum(["EMAIL", "DOMAIN"]),
    value: z.string().max(254).transform((v) => normalizeEmail(v)),
    reason: safeText(2, 300),
  })
  .superRefine((v, ctx) => {
    const ok = v.scope === "EMAIL" ? isValidEmail(v.value) : DOMAIN.test(v.value);
    if (!ok) ctx.addIssue({ code: "custom", path: ["value"], message: `must be a valid ${v.scope === "EMAIL" ? "email address" : "domain"}` });
  });

const listQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(500).default(100) });

/** Opt-out list. Anyone signed in can add entries; only admins can remove them. */
export function suppressionsRouter(db: Db): Router {
  const router = Router();
  router.use(requireUser());

  router.get("/", async (req, res) => {
    const { limit } = listQuery.parse(req.query);
    res.json({ suppressions: await db.suppressionRecord.findMany({ orderBy: { createdAt: "desc" }, take: limit }) });
  });

  router.post("/", async (req, res) => {
    const input = createSuppressionSchema.parse(req.body);
    const actor = req.actor as Actor;
    const record = await db.suppressionRecord
      .create({ data: { ...input, source: "manual", createdById: actorId(actor) } })
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new AppError(409, "DUPLICATE", "This value is already suppressed");
        }
        throw err;
      });
    await recordAudit(db, { actor, action: "suppression.created", entityType: "SuppressionRecord", entityId: record.id, metadata: { scope: record.scope } });
    res.status(201).json({ suppression: record });
  });

  router.delete("/:id", requireUser("ADMIN"), async (req, res) => {
    const id = parseId(req.params);
    const deleted = await db.suppressionRecord.deleteMany({ where: { id } });
    if (deleted.count === 0) throw notFound("Suppression");
    await recordAudit(db, { actor: req.actor as Actor, action: "suppression.deleted", entityType: "SuppressionRecord", entityId: id });
    res.status(204).end();
  });

  return router;
}
