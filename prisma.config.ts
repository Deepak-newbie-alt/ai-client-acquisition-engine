import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // `prisma generate` does not need a database, so a missing URL is only
    // an error for commands that connect (migrate, studio).
    url: process.env.DATABASE_URL ?? "",
  },
});
