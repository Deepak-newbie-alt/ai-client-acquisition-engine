import { pino } from "pino";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import type { Db } from "../../src/lib/db.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { createServiceToken, type ServiceScope } from "../../src/modules/auth/tokens.js";
import { createResearchRun } from "../../src/modules/research/service.js";

export const silentLogger = pino({ level: "silent" });

// Low-cost scrypt parameters keep tests fast; verification reads them from the hash.
const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 };
export const TEST_PASSWORD = "correct horse battery staple";

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: "http://localhost:5173",
    DATABASE_URL: "postgresql://unused@127.0.0.1:5433/ace_test",
    ...overrides,
  });
}

export async function createUser(
  db: Db,
  { email = "admin@example.com", role = "ADMIN", disabled = false }: { email?: string; role?: "ADMIN" | "REVIEWER"; disabled?: boolean } = {},
) {
  return db.user.create({
    data: {
      email,
      displayName: email.split("@")[0] ?? email,
      role,
      passwordHash: await hashPassword(TEST_PASSWORD, FAST_SCRYPT),
      disabledAt: disabled ? new Date() : null,
    },
  });
}

export async function createToken(db: Db, scopes: ServiceScope[], name = `token-${scopes.join("-")}`) {
  return (await createServiceToken(db, name, scopes)).token;
}

export async function queuedRun(db: Db, limits: AppConfig["limits"], resultLimit = 10) {
  return createResearchRun(
    db,
    { industry: "HVAC", country: "GB", keywords: ["scheduling"], resultLimit },
    { type: "SYSTEM" },
    limits,
  );
}
