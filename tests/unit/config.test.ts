import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/env.js";
import { loadScoringConfig, parseScoringConfig } from "../../src/config/scoring.js";

const baseEnv = {
  NODE_ENV: "development",
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/ace_dev",
};

const configError = (env: Record<string, string>): ConfigError => {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected loadConfig to throw");
};

describe("loadConfig", () => {
  it("trusts no proxy and serves no dashboard unless configured", () => {
    expect(loadConfig(baseEnv)).toMatchObject({ trustProxy: 0, webDistDir: null });
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "1", WEB_DIST_DIR: "web/dist" })).toMatchObject({ trustProxy: 1, webDistDir: "web/dist" });
    expect(configError({ ...baseEnv, TRUST_PROXY: "true" }).issues[0]).toMatch(/^TRUST_PROXY/);
  });

  it("defaults every provider to mock and applies conservative limits", () => {
    const config = loadConfig(baseEnv);
    expect(config.search).toEqual({ provider: "mock" });
    expect(config.llm).toEqual({ provider: "mock" });
    expect(config.email).toEqual({ provider: "mock" });
    expect(config.limits).toMatchObject({
      maxResultsPerRun: 20,
      runBudgetMicros: 1_000_000n,
      monthlyBudgetMicros: 10_000_000n,
      approvalTtlMinutes: 60,
    });
  });

  it("treats empty optional values as unset", () => {
    expect(loadConfig({ ...baseEnv, TAVILY_API_KEY: "", ANTHROPIC_MODEL: "  " }).search.provider).toBe("mock");
  });

  it("requires credentials for each real provider", () => {
    const err = configError({ ...baseEnv, SEARCH_PROVIDER: "tavily", LLM_PROVIDER: "anthropic", EMAIL_PROVIDER: "gmail" });
    expect(err.issues).toEqual(
      expect.arrayContaining([
        "TAVILY_API_KEY: required when SEARCH_PROVIDER=tavily",
        "ANTHROPIC_API_KEY: required when LLM_PROVIDER=anthropic",
        "GMAIL_REFRESH_TOKEN: required when EMAIL_PROVIDER=gmail",
      ]),
    );
  });

  it("configures Anthropic with claude-opus-5-5, explicit effort and built-in pricing by default", () => {
    const config = loadConfig({ ...baseEnv, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "", ANTHROPIC_EFFORT: "" });
    expect(config.llm).toEqual({
      provider: "anthropic",
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "medium",
      pricing: { inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
    });
  });

  it("requires explicit prices for models without a built-in price", () => {
    const env = { ...baseEnv, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-future-9" };
    expect(configError(env).issues).toContain(
      "ANTHROPIC_INPUT_USD_PER_MTOK: required when ANTHROPIC_MODEL has no built-in price",
    );
    const config = loadConfig({ ...env, ANTHROPIC_INPUT_USD_PER_MTOK: "3", ANTHROPIC_OUTPUT_USD_PER_MTOK: "15" });
    expect(config.llm).toMatchObject({ model: "claude-future-9", pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });
  });

  it("configures Tavily and requires the real page fetcher with it", () => {
    const env = { ...baseEnv, SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "tvly-x" };
    expect(configError(env).issues).toContain("PAGE_FETCHER: must be http when SEARCH_PROVIDER=tavily");
    expect(loadConfig({ ...env, PAGE_FETCHER: "http", TAVILY_SEARCH_DEPTH: "" }).search).toEqual({
      provider: "tavily",
      apiKey: "tvly-x",
      depth: "basic",
      usdPerCredit: 0.008,
    });
  });

  it("never includes secret values in error messages", () => {
    const secret = "sk-test-SUPER-SECRET-123";
    const err = configError({
      ...baseEnv,
      DATABASE_URL: `mysql://user:${secret}@db/x`,
      TAVILY_API_KEY: secret,
      EMAIL_PROVIDER: "gmail",
      GMAIL_CLIENT_SECRET: secret,
    });
    expect(err.message).not.toContain(secret);
    expect(err.issues.join("\n")).not.toContain(secret);
    expect(err.message).toContain("DATABASE_URL");
  });

  it("requires https for APP_ORIGIN in production", () => {
    expect(configError({ ...baseEnv, NODE_ENV: "production" }).issues).toContain(
      "APP_ORIGIN: must use https in production",
    );
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: "production", APP_ORIGIN: "https://ace.example.com" })).not.toThrow();
  });

  it("forbids a real email provider in the test environment", () => {
    const err = configError({
      ...baseEnv,
      NODE_ENV: "test",
      EMAIL_PROVIDER: "gmail",
      GMAIL_CLIENT_ID: "id",
      GMAIL_CLIENT_SECRET: "secret",
      GMAIL_REFRESH_TOKEN: "token",
      GMAIL_SENDER_ADDRESS: "me@example.com",
    });
    expect(err.issues).toContain("EMAIL_PROVIDER: must be mock in tests");
  });

  it("bounds research limits and budgets", () => {
    expect(configError({ ...baseEnv, RESEARCH_MAX_RESULTS_PER_RUN: "500" }).issues[0]).toMatch(
      /^RESEARCH_MAX_RESULTS_PER_RUN:/,
    );
    expect(configError({ ...baseEnv, RESEARCH_RUN_BUDGET_USD: "20", MONTHLY_BUDGET_USD: "10" }).issues).toContain(
      "RESEARCH_RUN_BUDGET_USD: must not exceed MONTHLY_BUDGET_USD",
    );
    expect(configError({ ...baseEnv, MONTHLY_BUDGET_USD: "-1" }).issues[0]).toMatch(/^MONTHLY_BUDGET_USD:/);
  });
});

describe("scoring config", () => {
  const weights = {
    FREQUENCY: 0.2,
    BUSINESS_IMPACT: 0.2,
    EVIDENCE_QUALITY: 0.2,
    RECURRENCE: 0.2,
    BUYER_ACCESSIBILITY: 0.1,
    DIFFERENTIATION: 0.1,
  };

  it("loads the committed config/scoring.json", () => {
    const config = loadScoringConfig();
    expect(config.version).toBeTruthy();
    expect(Object.keys(config.weights).sort()).toEqual(Object.keys(weights).sort());
  });

  it("rejects weights that do not sum to 1", () => {
    expect(() => parseScoringConfig({ version: "v", weights: { ...weights, FREQUENCY: 0.5 } })).toThrow(
      "weights must sum to 1",
    );
  });

  it("rejects missing or unknown components", () => {
    const { DIFFERENTIATION: _omitted, ...missing } = weights;
    expect(() => parseScoringConfig({ version: "v", weights: missing })).toThrow();
    expect(() => parseScoringConfig({ version: "v", weights: { ...weights, HYPE: 0 } })).toThrow();
  });
});
