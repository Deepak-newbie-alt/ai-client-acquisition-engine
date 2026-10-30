/**
 * Lists or revokes service tokens. Revocation takes effect on the next request.
 * Names stay reserved after revocation, so rotate by creating a token with a
 * new name (e.g. n8n-2026-11), updating n8n, then revoking the old one.
 *
 *   npm run token:list
 *   npm run token:revoke -- --name n8n
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config/env.js";
import { createPrismaClient } from "../src/lib/db.js";
import { recordAudit } from "../src/modules/audit/audit.js";

const { values } = parseArgs({ options: { revoke: { type: "boolean", default: false }, name: { type: "string" } } });

const db = createPrismaClient(loadConfig().databaseUrl);
try {
  if (!values.revoke) {
    const tokens = await db.serviceToken.findMany({ orderBy: { createdAt: "asc" } });
    if (tokens.length === 0) console.log("No service tokens.");
    for (const t of tokens) {
      const state = t.revokedAt ? `revoked ${t.revokedAt.toISOString()}` : "active";
      console.log(`${t.name}\t${t.scopes.join(",")}\t${state}\tlast used ${t.lastUsedAt?.toISOString() ?? "never"}`);
    }
  } else {
    if (!values.name) throw new Error("--name is required");
    const token = await db.serviceToken.findUnique({ where: { name: values.name } });
    if (!token) throw new Error(`No service token named "${values.name}"`);
    if (token.revokedAt) {
      console.log(`"${token.name}" was already revoked.`);
    } else {
      await db.serviceToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
      await recordAudit(db, {
        actor: { type: "SYSTEM" },
        action: "service_token.revoked",
        entityType: "ServiceToken",
        entityId: token.id,
        metadata: { name: token.name },
      });
      console.log(`Revoked "${token.name}".`);
    }
  }
} finally {
  await db.$disconnect();
}
