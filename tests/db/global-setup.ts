import { execFileSync } from "node:child_process";
import { testDatabaseUrl } from "./test-database.js";

export default function setup(): void {
  // Apply committed migrations to the test database (never `migrate dev`).
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: "pipe",
  });
}
