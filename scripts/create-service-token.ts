/**
 * Creates a service token for automation such as n8n. The token is printed
 * once and only its hash is stored.
 *
 *   npm run token:create -- --name n8n --scopes research:read,research:write
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../src/config/env.js";
import { createPrismaClient } from "../src/lib/db.js";
import { recordAudit } from "../src/modules/audit/audit.js";
import { createServiceToken, SERVICE_SCOPES } from "../src/modules/auth/tokens.js";

const { values } = parseArgs({ options: { name: { type: "string" }, scopes: { type: "string" } } });

const args = z
  .object({
    name: z.string().trim().min(1).max(64),
    scopes: z.array(z.enum(SERVICE_SCOPES)).min(1),
  })
  .parse({ name: values.name, scopes: values.scopes?.split(",").map((s) => s.trim()) });

const db = createPrismaClient(loadConfig().databaseUrl);
try {
  const { token, record } = await createServiceToken(db, args.name, args.scopes);
  await recordAudit(db, {
    actor: { type: "SYSTEM" },
    action: "service_token.created",
    entityType: "ServiceToken",
    entityId: record.id,
    metadata: { name: record.name, scopes: record.scopes.join(",") },
  });
  console.log(`Service token for "${record.name}" (${record.scopes.join(", ")}). Store it now; it is not shown again:\n`);
  console.log(token);
} finally {
  await db.$disconnect();
}
