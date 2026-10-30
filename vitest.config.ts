import "dotenv/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          env: { NODE_ENV: "test" },
        },
      },
      {
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          environment: "node",
          env: { NODE_ENV: "test" },
          globalSetup: ["tests/db/global-setup.ts"],
          // Tests share one database and truncate it between cases.
          fileParallelism: false,
        },
      },
    ],
  },
});
