import { createPrismaClient, type Db } from "../../src/lib/db.js";

/** Returns TEST_DATABASE_URL, refusing anything that is not a *_test database. */
export function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  const name = new URL(raw).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run DB tests against "${name}": name must end in _test`);
  }
  return raw;
}

export function createTestDb(): Db {
  return createPrismaClient(testDatabaseUrl());
}

/** Empties every application table. TRUNCATE bypasses the audit append-only trigger. */
export async function resetDb(db: Db): Promise<void> {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}
