import { Router } from "express";
import { z } from "zod";
import type { Db } from "../../lib/db.js";
import { safeText } from "../../lib/validation.js";
import { requireUser } from "../../middleware/auth.js";

const listQuery = z.strictObject({
  entityType: safeText(1, 64).optional(),
  entityId: safeText(1, 64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime().optional(),
});

export function auditRouter(db: Db): Router {
  const router = Router();
  router.use(requireUser());

  router.get("/", async (req, res) => {
    const q = listQuery.parse(req.query);
    const events = await db.auditEvent.findMany({
      where: {
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.entityId ? { entityId: q.entityId } : {}),
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: q.limit,
    });
    res.json({ events });
  });

  return router;
}
