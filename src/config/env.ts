import { z } from "zod";
import { ANTHROPIC_PRICING, type ModelPricing } from "../integrations/llm/pricing.js";

const optionalString = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const positiveNumber = (max: number) => z.coerce.number().positive().max(max);

/** Treats an empty assignment (`KEY=`) as unset rather than as zero. */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().trim().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    APP_ORIGIN: z.url({ protocol: /^https?$/ }),
    // Number of reverse proxies in front of the API (e.g. 1 behind Caddy or nginx).
    // Used for client IPs in rate limits; leave 0 when the API is reached directly.
    TRUST_PROXY: blankAsUnset(z.coerce.number().int().min(0).max(10).default(0)),
    // Directory of the built dashboard (web/dist). When set, the API also serves it.
    WEB_DIST_DIR: optionalString,

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    // "mock" serves built-in fixture pages; "http" retrieves real public pages.
    PAGE_FETCHER: z.enum(["mock", "http"]).default("mock"),

    SEARCH_PROVIDER: z.enum(["mock", "tavily"]).default("mock"),
    TAVILY_API_KEY: optionalString,
    TAVILY_SEARCH_DEPTH: blankAsUnset(z.enum(["basic", "advanced"]).default("basic")),
    // Pay-as-you-go list price; set to your plan's effective price.
    TAVILY_USD_PER_CREDIT: blankAsUnset(positiveNumber(1).default(0.008)),

    LLM_PROVIDER: z.enum(["mock", "anthropic"]).default("mock"),
    ANTHROPIC_API_KEY: optionalString,
    ANTHROPIC_MODEL: blankAsUnset(z.string().trim().min(1).default("claude-opus-5-5")),
    ANTHROPIC_EFFORT: blankAsUnset(z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium")),
    // Required only for models missing from src/integrations/llm/pricing.ts.
    ANTHROPIC_INPUT_USD_PER_MTOK: blankAsUnset(positiveNumber(1000).optional()),
    ANTHROPIC_OUTPUT_USD_PER_MTOK: blankAsUnset(positiveNumber(1000).optional()),

    EMAIL_PROVIDER: z.enum(["mock", "gmail"]).default("mock"),
    GMAIL_CLIENT_ID: optionalString,
    GMAIL_CLIENT_SECRET: optionalString,
    GMAIL_REFRESH_TOKEN: optionalString,
    GMAIL_SENDER_ADDRESS: optionalString.pipe(z.email().optional()),
    // Comma-separated emails or domains. When set, sends to anyone else are refused.
    // Required with EMAIL_PROVIDER=gmail outside production.
    EMAIL_RECIPIENT_ALLOWLIST: optionalString,

    // Shown in every email footer (with the opt-out line). A postal address is
    // required by some anti-spam laws (e.g. CAN-SPAM) for commercial email.
    OUTREACH_SENDER_NAME: optionalString,
    OUTREACH_POSTAL_ADDRESS: optionalString,
    // How long an unconfirmed send stays "uncertain" before reconciliation may mark it failed.
    SEND_RECONCILE_GRACE_MINUTES: blankAsUnset(z.coerce.number().int().min(1).max(24 * 60).default(15)),

    RESEARCH_MAX_RESULTS_PER_RUN: z.coerce.number().int().min(1).max(100).default(20),
    RESEARCH_RUN_BUDGET_USD: positiveNumber(100).default(1),
    MONTHLY_BUDGET_USD: positiveNumber(1000).default(10),
    APPROVAL_TTL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(60),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 7).default(12),
  })
  .superRefine((env, ctx) => {
    const require = (key: keyof typeof env, when: string) => {
      if (!env[key]) {
        ctx.addIssue({ code: "custom", path: [key], message: `required when ${when}` });
      }
    };

    if (env.SEARCH_PROVIDER === "tavily") {
      require("TAVILY_API_KEY", "SEARCH_PROVIDER=tavily");
      // Fixture pages only cover the mock search results.
      if (env.PAGE_FETCHER !== "http") {
        ctx.addIssue({ code: "custom", path: ["PAGE_FETCHER"], message: "must be http when SEARCH_PROVIDER=tavily" });
      }
    }
    if (env.LLM_PROVIDER === "anthropic") {
      require("ANTHROPIC_API_KEY", "LLM_PROVIDER=anthropic");
      if (!ANTHROPIC_PRICING[env.ANTHROPIC_MODEL]) {
        require("ANTHROPIC_INPUT_USD_PER_MTOK", "ANTHROPIC_MODEL has no built-in price");
        require("ANTHROPIC_OUTPUT_USD_PER_MTOK", "ANTHROPIC_MODEL has no built-in price");
      }
    }
    if (env.EMAIL_PROVIDER === "gmail") {
      for (const key of [
        "GMAIL_CLIENT_ID",
        "GMAIL_CLIENT_SECRET",
        "GMAIL_REFRESH_TOKEN",
        "GMAIL_SENDER_ADDRESS",
      ] as const) {
        require(key, "EMAIL_PROVIDER=gmail");
      }
    }

    if (env.NODE_ENV === "production" && !env.APP_ORIGIN.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "must use https in production" });
    }
    if (env.NODE_ENV === "test" && env.EMAIL_PROVIDER !== "mock") {
      ctx.addIssue({ code: "custom", path: ["EMAIL_PROVIDER"], message: "must be mock in tests" });
    }
    if (env.EMAIL_PROVIDER === "gmail" && env.NODE_ENV !== "production" && !env.EMAIL_RECIPIENT_ALLOWLIST) {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_RECIPIENT_ALLOWLIST"],
        message: "required with EMAIL_PROVIDER=gmail outside production (protects real recipients during development)",
      });
    }
    if (env.RESEARCH_RUN_BUDGET_USD > env.MONTHLY_BUDGET_USD) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEARCH_RUN_BUDGET_USD"],
        message: "must not exceed MONTHLY_BUDGET_USD",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  nodeEnv: Env["NODE_ENV"];
  host: string;
  port: number;
  logLevel: Env["LOG_LEVEL"];
  appOrigin: string;
  trustProxy: number;
  webDistDir: string | null;
  databaseUrl: string;
  pageFetcher: Env["PAGE_FETCHER"];
  search:
    | { provider: "mock" }
    | { provider: "tavily"; apiKey: string; depth: Env["TAVILY_SEARCH_DEPTH"]; usdPerCredit: number };
  llm:
    | { provider: "mock" }
    | { provider: "anthropic"; apiKey: string; model: string; effort: Env["ANTHROPIC_EFFORT"]; pricing: ModelPricing };
  email:
    | { provider: "mock" }
    | {
        provider: "gmail";
        clientId: string;
        clientSecret: string;
        refreshToken: string;
        senderAddress: string;
      };
  outreach: {
    senderName: string | null;
    postalAddress: string | null;
    /** Lowercased emails and domains; null means no restriction. */
    recipientAllowlist: string[] | null;
    reconcileGraceMinutes: number;
  };
  limits: {
    maxResultsPerRun: number;
    runBudgetMicros: bigint;
    monthlyBudgetMicros: bigint;
    approvalTtlMinutes: number;
    sessionTtlHours: number;
  };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    // Only key names and rule messages are included; values may be secrets.
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const usdToMicros = (usd: number) => BigInt(Math.round(usd * 1_000_000));

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  const env = parsed.data;

  // The non-null assertions below are guaranteed by superRefine.
  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    appOrigin: env.APP_ORIGIN,
    trustProxy: env.TRUST_PROXY,
    webDistDir: env.WEB_DIST_DIR ?? null,
    databaseUrl: env.DATABASE_URL,
    pageFetcher: env.PAGE_FETCHER,
    search:
      env.SEARCH_PROVIDER === "tavily"
        ? {
            provider: "tavily",
            apiKey: env.TAVILY_API_KEY!,
            depth: env.TAVILY_SEARCH_DEPTH,
            usdPerCredit: env.TAVILY_USD_PER_CREDIT,
          }
        : { provider: "mock" },
    llm:
      env.LLM_PROVIDER === "anthropic"
        ? {
            provider: "anthropic",
            apiKey: env.ANTHROPIC_API_KEY!,
            model: env.ANTHROPIC_MODEL,
            effort: env.ANTHROPIC_EFFORT,
            // Explicit prices override the built-in table.
            pricing:
              env.ANTHROPIC_INPUT_USD_PER_MTOK && env.ANTHROPIC_OUTPUT_USD_PER_MTOK
                ? { inputUsdPerMTok: env.ANTHROPIC_INPUT_USD_PER_MTOK, outputUsdPerMTok: env.ANTHROPIC_OUTPUT_USD_PER_MTOK }
                : ANTHROPIC_PRICING[env.ANTHROPIC_MODEL]!,
          }
        : { provider: "mock" },
    email:
      env.EMAIL_PROVIDER === "gmail"
        ? {
            provider: "gmail",
            clientId: env.GMAIL_CLIENT_ID!,
            clientSecret: env.GMAIL_CLIENT_SECRET!,
            refreshToken: env.GMAIL_REFRESH_TOKEN!,
            senderAddress: env.GMAIL_SENDER_ADDRESS!,
          }
        : { provider: "mock" },
    outreach: {
      senderName: env.OUTREACH_SENDER_NAME ?? null,
      postalAddress: env.OUTREACH_POSTAL_ADDRESS ?? null,
      recipientAllowlist: env.EMAIL_RECIPIENT_ALLOWLIST
        ? env.EMAIL_RECIPIENT_ALLOWLIST.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean)
        : null,
      reconcileGraceMinutes: env.SEND_RECONCILE_GRACE_MINUTES,
    },
    limits: {
      maxResultsPerRun: env.RESEARCH_MAX_RESULTS_PER_RUN,
      runBudgetMicros: usdToMicros(env.RESEARCH_RUN_BUDGET_USD),
      monthlyBudgetMicros: usdToMicros(env.MONTHLY_BUDGET_USD),
      approvalTtlMinutes: env.APPROVAL_TTL_MINUTES,
      sessionTtlHours: env.SESSION_TTL_HOURS,
    },
  } satisfies AppConfig);
}
