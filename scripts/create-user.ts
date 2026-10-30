/**
 * Creates a dashboard user. The password is read from standard input so it
 * never appears in shell history or process listings:
 *
 *   npm run user:create -- --email you@example.com --name "You" --role ADMIN
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../src/config/env.js";
import { createPrismaClient } from "../src/lib/db.js";
import { normalizeEmail } from "../src/lib/email.js";
import { recordAudit } from "../src/modules/audit/audit.js";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../src/modules/auth/password.js";

const { values } = parseArgs({
  options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string", default: "REVIEWER" } },
});

const args = z
  .object({ email: z.email(), name: z.string().trim().min(1).max(100), role: z.enum(["ADMIN", "REVIEWER"]) })
  .parse({ email: values.email && normalizeEmail(values.email), name: values.name, role: values.role });

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
process.stdout.write(`Password (min ${MIN_PASSWORD_LENGTH} characters), then Enter: `);
const password = (await rl.question("")).trim();
rl.close();

const db = createPrismaClient(loadConfig().databaseUrl);
try {
  const user = await db.user.create({
    data: { email: args.email, displayName: args.name, role: args.role, passwordHash: await hashPassword(password) },
  });
  await recordAudit(db, { actor: { type: "SYSTEM" }, action: "user.created", entityType: "User", entityId: user.id });
  console.log(`\nCreated ${user.role} user ${user.email}`);
} finally {
  await db.$disconnect();
}
