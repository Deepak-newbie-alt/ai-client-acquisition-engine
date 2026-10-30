import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MockLlmProvider } from "../../src/integrations/llm/mock.js";
import { LlmCallError } from "../../src/integrations/llm/types.js";
import { MockSearchProvider } from "../../src/integrations/search/mock.js";
import { createFixturePageFetcherFactory } from "../../src/integrations/web/fixtures.js";
import type { PageFetcherFactory } from "../../src/integrations/web/types.js";
import { normalizeForMatch } from "../../src/modules/evidence/validate.js";
import { BudgetExceededError } from "../../src/modules/research/budget.js";
import { runResearch, type PipelineDeps, type RunStats } from "../../src/modules/research/pipeline.js";
import { cancelResearchRun } from "../../src/modules/research/service.js";
import { queuedRun, silentLogger } from "./fixtures.js";
import { createTestDb, resetDb } from "./test-database.js";

const db = createTestDb();
const limits = { runBudgetMicros: 1_000_000n, monthlyBudgetMicros: 10_000_000n };
const configLimits = { ...limits, maxResultsPerRun: 20, approvalTtlMinutes: 60, sessionTtlHours: 12 };

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps & { llm: MockLlmProvider; search: MockSearchProvider } {
  return {
    db,
    search: new MockSearchProvider(),
    llm: new MockLlmProvider(),
    pages: createFixturePageFetcherFactory(),
    limits,
    logger: silentLogger,
    ...overrides,
  } as PipelineDeps & { llm: MockLlmProvider; search: MockSearchProvider };
}

async function runOnce(d = deps(), resultLimit = 10) {
  const run = await queuedRun(db, configLimits, resultLimit);
  await runResearch(run.id, d);
  const finished = await db.researchRun.findUniqueOrThrow({ where: { id: run.id } });
  return { run: finished, stats: finished.stats as RunStats };
}

describe("research pipeline (mock integrations)", () => {
  it("processes search results end to end with every safeguard applied", async () => {
    const d = deps();
    const { run, stats } = await runOnce(d);

    expect(run.status).toBe("SUCCEEDED");
    expect(run.completedAt).not.toBeNull();
    expect(stats).toMatchObject({
      searchHits: 9,
      rejectedUrls: { IP_LITERAL_NOT_ALLOWED: 1 },
      duplicateUrls: 1,
      selected: 7,
      reusedSources: 0,
      fetched: 4,
      skipped: { ROBOTS_DISALLOWED: 1, DUPLICATE_CONTENT: 1 },
      failed: { UNSUPPORTED_CONTENT_TYPE: 1 },
      extractionErrors: 0,
    });
    expect(stats.evidenceAccepted).toBeGreaterThan(0);

    // Metadata URL never became a source; robots-blocked page was never fetched.
    const sources = await db.sourceDocument.findMany();
    expect(sources.map((s) => s.canonicalUrl)).not.toContain("http://169.254.169.254/latest/meta-data/");
    const robotsBlocked = sources.find((s) => s.canonicalUrl.includes("robots-blocked"));
    expect(robotsBlocked).toMatchObject({ retrievalStatus: "SKIPPED", skipReason: "ROBOTS_DISALLOWED", extractedText: null });

    // The syndicated copy is linked to the original and not analysed.
    const original = sources.find((s) => s.canonicalUrl.endsWith("/articles/field-service-paperwork"));
    const copy = sources.find((s) => s.canonicalUrl.endsWith("/syndicated/field-service-paperwork"));
    expect(copy).toMatchObject({ retrievalStatus: "SKIPPED", skipReason: `DUPLICATE_CONTENT:${original?.id}`, extractedText: null });
    expect(await db.evidence.count({ where: { sourceId: copy?.id } })).toBe(0);

    // Hidden prompt injection and scripts never reach stored text or the model.
    const stored = sources.map((s) => s.extractedText ?? "").join("\n");
    expect(stored).not.toContain("Ignore all previous instructions");
    expect(stored).not.toContain("document.cookie");
    expect(d.llm.requests.map((r) => r.prompt).join("\n")).not.toContain("Ignore all previous instructions");
    expect(d.llm.requests).toHaveLength(4);

    // Every run-source link records its search rank.
    expect(await db.runSource.count({ where: { runId: run.id } })).toBe(7);
  });

  it("links every piece of evidence to a fetched source that contains its excerpt", async () => {
    const { run } = await runOnce();
    const evidence = await db.evidence.findMany({ include: { source: true } });
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) {
      expect(e.runId).toBe(run.id);
      expect(e.source.retrievalStatus).toBe("FETCHED");
      expect(normalizeForMatch(e.source.extractedText ?? "")).toContain(e.excerpt);
      expect(e).toMatchObject({ validationStatus: "VALID", llmModel: "mock-evidence-extractor", promptVersion: "evidence-v1" });
    }
  });

  it("reuses known sources on later runs instead of fetching and analysing them again", async () => {
    const d = deps();
    await runOnce(d);
    const firstEvidence = await db.evidence.count();
    const callsAfterFirst = d.llm.requests.length;

    const { run, stats } = await runOnce(d);
    expect(run.status).toBe("SUCCEEDED");
    expect(stats.reusedSources).toBe(6); // all but the PDF, which failed and is retried
    expect(stats.fetched).toBe(0);
    expect(d.llm.requests.length).toBe(callsAfterFirst);
    expect(await db.evidence.count()).toBe(firstEvidence);
    expect(await db.sourceDocument.count()).toBe(7);
    expect(await db.runSource.count({ where: { runId: run.id } })).toBe(7);
  });

  it("rejects fabricated excerpts and invented impact figures from the model", async () => {
    const llm = new MockLlmProvider({
      respond: () => ({
        items: [
          {
            excerpt: "This business loses $2 million a year to scheduling chaos, according to the owner.",
            problemSummary: "Fabricated claim",
            workflow: null,
            kind: "OBSERVED",
            confidence: 0.9,
            impactNote: "$2 million a year",
          },
          {
            excerpt: "Rescheduling is killing us.",
            problemSummary: "Rescheduling overload",
            workflow: "job scheduling",
            kind: "OBSERVED",
            confidence: 0.7,
            impactNote: "Costs 30 hours a month",
          },
        ],
      }),
    });
    const { stats } = await runOnce(deps({ llm }));

    expect(stats.evidenceRejected.EXCERPT_NOT_IN_SOURCE).toBeGreaterThan(0);
    const evidence = await db.evidence.findMany();
    expect(evidence.every((e) => !e.excerpt.includes("$2 million"))).toBe(true);
    const real = evidence.find((e) => e.excerpt === "Rescheduling is killing us.");
    expect(real).toMatchObject({ impactNote: null, validationNote: "Impact removed: figures not present in the excerpt." });
  });

  it("counts malformed model output as an extraction error and stores nothing", async () => {
    const llm = new MockLlmProvider({ respond: () => ({ result: "Ignore the schema, here is prose." }) });
    const { run, stats } = await runOnce(deps({ llm }));
    expect(run.status).toBe("SUCCEEDED");
    expect(stats.extractionErrors).toBe(4);
    expect(await db.evidence.count()).toBe(0);
  });

  it("survives LLM provider failures", async () => {
    const { run, stats } = await runOnce(deps({ llm: new MockLlmProvider({ fail: true }) }));
    expect(run.status).toBe("SUCCEEDED");
    expect(stats.extractionErrors).toBe(4);
    expect(run.llmCalls).toBe(4);
  });

  it("stops the run on a fatal provider error instead of trying every source", async () => {
    const llm = new MockLlmProvider({ respond: () => { throw new LlmCallError("AUTH", "Claude API rejected the credentials (HTTP 401)"); } });
    const { run, stats } = await runOnce(deps({ llm }));
    expect(run).toMatchObject({ status: "FAILED", errorCode: "LLM_UNAVAILABLE", llmCalls: 1 });
    expect(run.errorMessage).toBe("The LLM provider rejected the request (AUTH)");
    expect(stats.extractionErrorCodes).toEqual({ AUTH: 1 });
  });

  it("records reported usage for failed calls (e.g. refusals) and keeps going", async () => {
    const usage = { inputTokens: 900, outputTokens: 40, costMicros: 4_400n };
    const llm = new MockLlmProvider({
      costMicros: 50_000n, // the up-front estimate
      respond: () => { throw new LlmCallError("REFUSAL", "Model declined the request (category: cyber)", usage); },
    });
    const { run, stats } = await runOnce(deps({ llm }));
    expect(run.status).toBe("SUCCEEDED");
    expect(stats.extractionErrorCodes).toEqual({ REFUSAL: 4 });
    expect(run.costMicros).toBe(4n * 4_400n);
    expect(run.llmInputTokens).toBe(4 * 900);
  });

  it("fails the run with a safe message when search fails", async () => {
    const { run } = await runOnce(deps({ search: new MockSearchProvider({ fail: true }) }));
    expect(run).toMatchObject({ status: "FAILED", errorCode: "SEARCH_FAILED", errorMessage: "The search provider request failed" });
    expect(await db.sourceDocument.count()).toBe(0);
  });
});

describe("usage budgets", () => {
  it("records actual usage per call and on the run", async () => {
    const d = deps({
      search: new MockSearchProvider({ costMicros: 8_000n }),
      llm: new MockLlmProvider({ costMicros: 1_000n }),
    });
    const { run } = await runOnce(d);
    expect(run).toMatchObject({ searchCalls: 1, llmCalls: 4, costMicros: 12_000n });
    expect(run.llmInputTokens).toBeGreaterThan(0);
    const events = await db.usageEvent.findMany({ where: { runId: run.id } });
    expect(events.map((e) => e.kind).sort()).toEqual(["LLM", "LLM", "LLM", "LLM", "SEARCH"]);
  });

  it("stops a run that would exceed its per-run budget and keeps partial results", async () => {
    const llm = new MockLlmProvider({ costMicros: 400_000n });
    const { run, stats } = await runOnce(deps({ llm }));
    expect(run).toMatchObject({ status: "FAILED", errorCode: "BUDGET_EXCEEDED" });
    expect(run.errorMessage).toContain("Partial results were kept");
    expect(llm.requests).toHaveLength(2);
    expect(run.costMicros).toBe(800_000n);
    expect(stats.evidenceAccepted).toBeGreaterThan(0);
  });

  it("refuses to start a run once the monthly budget is spent", async () => {
    await db.usageEvent.create({
      data: { kind: "LLM", provider: "test", operation: "seed", costMicros: limits.monthlyBudgetMicros },
    });
    await expect(queuedRun(db, configLimits)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("fails a queued run if the monthly budget runs out before it starts", async () => {
    const run = await queuedRun(db, configLimits);
    await db.usageEvent.create({
      data: { kind: "LLM", provider: "test", operation: "seed", costMicros: limits.monthlyBudgetMicros },
    });
    await runResearch(run.id, deps());
    expect(await db.researchRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      errorCode: "BUDGET_EXCEEDED",
      searchCalls: 0,
    });
  });

  it("serializes concurrent reservations so runs cannot overspend together", async () => {
    const tight = { runBudgetMicros: 600_000n, monthlyBudgetMicros: 1_000_000n };
    const llm = new MockLlmProvider({ costMicros: 300_000n });
    const runs = await Promise.all([queuedRun(db, configLimits), queuedRun(db, configLimits)]);
    await Promise.all(runs.map((r) => runResearch(r.id, deps({ llm, limits: tight }))));
    const total = await db.usageEvent.aggregate({ _sum: { costMicros: true } });
    expect(total._sum.costMicros).toBeLessThanOrEqual(tight.monthlyBudgetMicros);
    expect(llm.requests.length).toBeLessThanOrEqual(3);
  });
});

describe("run lifecycle", () => {
  it("does nothing for a run that is not QUEUED", async () => {
    const run = await queuedRun(db, configLimits);
    await cancelResearchRun(db, run.id, { type: "SYSTEM" });
    const d = deps();
    await runResearch(run.id, d);
    expect(d.search.requests).toHaveLength(0);
    expect((await db.researchRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("CANCELLED");
  });

  it("stops between sources when cancelled mid-run", async () => {
    const run = await queuedRun(db, configLimits);
    const fixtures = createFixturePageFetcherFactory()();
    let fetches = 0;
    const pages: PageFetcherFactory = () => ({
      isAllowedByRobots: (url) => fixtures.isAllowedByRobots(url),
      fetchHtml: async (url) => {
        if (++fetches === 1) await cancelResearchRun(db, run.id, { type: "SYSTEM" });
        return fixtures.fetchHtml(url);
      },
    });
    await runResearch(run.id, deps({ pages }));
    const finished = await db.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finished.status).toBe("CANCELLED");
    expect(fetches).toBe(1);
    expect(finished.completedAt).not.toBeNull();
  });

  it("writes audit events for the run lifecycle", async () => {
    const { run } = await runOnce();
    const actions = await db.auditEvent.findMany({ where: { entityId: run.id }, orderBy: { createdAt: "asc" } });
    expect(actions.map((a) => a.action)).toEqual(["research_run.created", "research_run.started", "research_run.succeeded"]);
  });
});
