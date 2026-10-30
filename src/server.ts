import "dotenv/config";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config/env.js";
import { loadScoringConfig } from "./config/scoring.js";
import { createEmailProvider } from "./integrations/email/index.js";
import { createIntegrations } from "./integrations/index.js";
import { createPrismaClient } from "./lib/db.js";
import { createLogger } from "./lib/logger.js";
import { refreshOpportunities } from "./modules/opportunities/service.js";
import { runResearch } from "./modules/research/pipeline.js";
import { recoverResearchRuns, ResearchQueue } from "./modules/research/queue.js";

async function main(): Promise<void> {
  let config;
  let scoring;
  try {
    config = loadConfig();
    scoring = loadScoringConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  const db = createPrismaClient(config.databaseUrl);
  const integrations = createIntegrations(config);
  logger.info(
    { search: integrations.search.name, llm: integrations.llm.name, pageFetcher: config.pageFetcher, email: config.email.provider },
    "providers configured",
  );

  const queue = new ResearchQueue(async (runId) => {
    await runResearch(runId, { db, ...integrations, limits: config.limits, logger });
    // Partial results of failed runs are still clustered and scored.
    await refreshOpportunities(db, scoring).catch((err: unknown) => logger.error({ err, runId }, "opportunity refresh failed"));
  }, logger);
  await recoverResearchRuns(db, queue);

  const email = createEmailProvider(config);
  const app = createApp({ config, db, logger, researchQueue: queue, scoring, pages: integrations.pages, email, llm: integrations.llm });
  const server = app.listen(config.port, config.host, () => {
    logger.info(`API listening on http://${config.host}:${config.port}`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void db.$disconnect().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
