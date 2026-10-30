import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import express, { type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type { AppConfig } from "./config/env.js";
import type { ScoringConfig } from "./config/scoring.js";
import type { EmailProvider } from "./integrations/email/types.js";
import type { LlmProvider } from "./integrations/llm/types.js";
import type { PageFetcherFactory } from "./integrations/web/types.js";
import type { Db } from "./lib/db.js";
import { AppError } from "./lib/errors.js";
import type { Logger } from "./lib/logger.js";
import { authenticate } from "./middleware/auth.js";
import { csrfProtection } from "./middleware/csrf.js";
import { errorHandler } from "./middleware/errors.js";
import { auditRouter } from "./modules/audit/routes.js";
import { authRouter } from "./modules/auth/routes.js";
import { companiesRouter, contactsRouter } from "./modules/companies/routes.js";
import { suppressionsRouter } from "./modules/contacts/suppression-routes.js";
import { evidenceRouter, opportunitiesRouter } from "./modules/opportunities/routes.js";
import { outreachRouter } from "./modules/outreach/routes.js";
import type { ResearchQueueLike } from "./modules/research/queue.js";
import { researchRouter, sourcesRouter, usageRouter } from "./modules/research/routes.js";

export interface AppDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
  researchQueue: ResearchQueueLike;
  scoring: ScoringConfig;
  /** Used to re-check contact source pages. */
  pages: PageFetcherFactory;
  email: EmailProvider;
  /** Used to draft outreach. */
  llm: LlmProvider;
  /** Requests per window; tests lower or raise these. */
  rateLimits?: { loginPer15Min?: number; researchCreatePerHour?: number; sendsPerHour?: number; draftsPerHour?: number };
}

function limiter(windowMs: number, limit: number): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, "RATE_LIMITED", "Too many requests, try again later")),
  });
}

export function createApp(deps: AppDeps): express.Express {
  const { config, db, logger } = deps;
  const app = express();

  app.disable("x-powered-by");
  // Behind a reverse proxy, req.ip (used by the rate limits) comes from X-Forwarded-For.
  app.set("trust proxy", config.trustProxy);
  // Prisma returns BigInt for money counters; JSON has no BigInt.
  app.set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value));

  const production = config.nodeEnv === "production";
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          frameAncestors: ["'none'"],
          // Only meaningful over HTTPS; on plain-http localhost it would break asset loads.
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      strictTransportSecurity: production,
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use("/api", express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api", authenticate(db), csrfProtection(config.appOrigin));

  app.use(
    "/api/auth",
    authRouter({ db, config, loginLimiter: limiter(15 * 60_000, deps.rateLimits?.loginPer15Min ?? 10) }),
  );
  app.use(
    "/api/research-runs",
    researchRouter({
      db,
      config,
      queue: deps.researchQueue,
      createLimiter: limiter(60 * 60_000, deps.rateLimits?.researchCreatePerHour ?? 20),
    }),
  );
  app.use("/api/sources", sourcesRouter(db));
  app.use("/api/usage", usageRouter({ db, config }));
  app.use("/api/opportunities", opportunitiesRouter({ db, scoring: deps.scoring }));
  app.use("/api/evidence", evidenceRouter({ db, scoring: deps.scoring }));
  app.use("/api/companies", companiesRouter({ db, scoring: deps.scoring }));
  app.use("/api/contacts", contactsRouter({ db, scoring: deps.scoring, pages: deps.pages }));
  app.use("/api/suppressions", suppressionsRouter(db));
  app.use("/api/audit-events", auditRouter(db));
  app.use(
    "/api/outreach",
    outreachRouter({
      db,
      email: deps.email,
      llm: deps.llm,
      config,
      logger,
      sendLimiter: limiter(60 * 60_000, deps.rateLimits?.sendsPerHour ?? 30),
      generateLimiter: limiter(60 * 60_000, deps.rateLimits?.draftsPerHour ?? 60),
    }),
  );

  app.use("/api", () => {
    throw new AppError(404, "NOT_FOUND", "Not found");
  });
  if (config.webDistDir) app.use(dashboard(config.webDistDir));
  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });
  app.use(errorHandler(logger));

  return app;
}

/**
 * Serves the built dashboard. Only files inside the directory are served
 * (express.static rejects traversal), dotfiles are hidden, and hashed assets
 * are cached long-term while index.html is always revalidated.
 */
function dashboard(dir: string): express.Router {
  const root = resolve(dir);
  const index = join(root, "index.html");
  if (!existsSync(index)) throw new Error(`WEB_DIST_DIR has no index.html: ${root} (run npm run web:build)`);

  const router = express.Router();
  router.use(
    "/assets",
    express.static(join(root, "assets"), { dotfiles: "ignore", immutable: true, maxAge: "365d", index: false }),
  );
  router.use(express.static(root, { dotfiles: "ignore", index: false }));
  // The dashboard uses hash routing, so "/" is the only page.
  router.get("/", (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(index);
  });
  return router;
}
