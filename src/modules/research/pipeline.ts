import type { ResearchRun, SourceDocument } from "../../generated/prisma/client.js";
import { LlmCallError, type LlmProvider } from "../../integrations/llm/types.js";
import { SearchProviderError, type SearchHit, type SearchProvider } from "../../integrations/search/types.js";
import type { PageFetcher, PageFetcherFactory } from "../../integrations/web/types.js";
import type { Db } from "../../lib/db.js";
import { textContentHash } from "../../lib/hash.js";
import type { Logger } from "../../lib/logger.js";
import { FetchError } from "../../lib/safe-fetch.js";
import { canonicalizeUrl, dedupeUrls, type CanonicalUrl } from "../../lib/url.js";
import { recordAudit, SYSTEM_ACTOR } from "../audit/audit.js";
import { buildEvidencePrompt, EVIDENCE_MAX_OUTPUT_TOKENS, EVIDENCE_PROMPT_VERSION } from "../evidence/prompt.js";
import { extractionResultSchema } from "../evidence/schema.js";
import { validateExtraction } from "../evidence/validate.js";
import { extractPageText } from "../sources/extract.js";
import { BudgetExceededError, reserveUsage, settleUsage, type BudgetLimits } from "./budget.js";

export interface PipelineDeps {
  db: Db;
  search: SearchProvider;
  llm: LlmProvider;
  pages: PageFetcherFactory;
  limits: BudgetLimits;
  logger: Logger;
}

export type RunStats = {
  searchHits: number;
  rejectedUrls: Record<string, number>;
  duplicateUrls: number;
  selected: number;
  reusedSources: number;
  fetched: number;
  skipped: Record<string, number>;
  failed: Record<string, number>;
  evidenceAccepted: number;
  evidenceRejected: Record<string, number>;
  extractionErrors: number;
  extractionErrorCodes: Record<string, number>;
};

const emptyStats = (): RunStats => ({
  searchHits: 0,
  rejectedUrls: {},
  duplicateUrls: 0,
  selected: 0,
  reusedSources: 0,
  fetched: 0,
  skipped: {},
  failed: {},
  evidenceAccepted: 0,
  evidenceRejected: {},
  extractionErrors: 0,
  extractionErrorCodes: {},
});

const increment = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Pages with less extracted text than this are not worth an LLM call. */
const MIN_TEXT_CHARS = 120;

class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class RunCancelled extends Error {}

type Outcome = { status: "SUCCEEDED" } | { status: "FAILED"; errorCode: string; errorMessage: string };

/**
 * Executes one research run: search, URL validation and dedup, retrieval,
 * text extraction, evidence extraction and storage. The run is claimed
 * atomically, so calling this twice for the same run is harmless.
 */
export async function runResearch(runId: string, deps: PipelineDeps): Promise<void> {
  const { db, logger } = deps;
  const claimed = await db.researchRun.updateMany({
    where: { id: runId, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const run = await db.researchRun.findUniqueOrThrow({ where: { id: runId } });
  await recordAudit(db, { actor: SYSTEM_ACTOR, action: "research_run.started", entityType: "ResearchRun", entityId: runId });

  const stats = emptyStats();
  let outcome: Outcome | "CANCELLED";
  try {
    await execute(run, stats, deps);
    outcome = { status: "SUCCEEDED" };
  } catch (err) {
    if (err instanceof RunCancelled) {
      outcome = "CANCELLED";
    } else if (err instanceof BudgetExceededError) {
      outcome = { status: "FAILED", errorCode: err.code, errorMessage: `${err.message}. Partial results were kept.` };
    } else if (err instanceof PipelineError) {
      outcome = { status: "FAILED", errorCode: err.code, errorMessage: err.message };
    } else {
      logger.error({ err, runId }, "research run failed");
      outcome = { status: "FAILED", errorCode: "INTERNAL_ERROR", errorMessage: "Unexpected error during research" };
    }
  }

  const completedAt = new Date();
  // Only a still-RUNNING run is finalized, so a concurrent cancellation wins.
  const finalized =
    outcome === "CANCELLED"
      ? { count: 0 }
      : await db.researchRun.updateMany({ where: { id: runId, status: "RUNNING" }, data: { ...outcome, completedAt, stats } });
  if (finalized.count === 0) {
    await db.researchRun.update({ where: { id: runId }, data: { completedAt, stats } });
  }

  const finalStatus = finalized.count === 0 ? "CANCELLED" : (outcome as Outcome).status;
  await recordAudit(db, {
    actor: SYSTEM_ACTOR,
    action: `research_run.${finalStatus.toLowerCase()}`,
    entityType: "ResearchRun",
    entityId: runId,
    metadata: {
      fetched: stats.fetched,
      evidenceAccepted: stats.evidenceAccepted,
      errorCode: typeof outcome === "object" && outcome.status === "FAILED" ? outcome.errorCode : null,
    },
  });
}

async function execute(run: ResearchRun, stats: RunStats, deps: PipelineDeps): Promise<void> {
  const hits = await search(run, deps);
  stats.searchHits = hits.length;

  const selected = await selectSources(run, hits, stats, deps.db);
  stats.selected = selected.length;

  const pages = deps.pages();
  for (const { url, hit, rank } of selected) {
    await assertNotCancelled(deps.db, run.id);

    const source = await deps.db.sourceDocument.upsert({
      where: { canonicalUrl: url.canonicalUrl },
      create: {
        canonicalUrl: url.canonicalUrl,
        domain: url.hostname,
        registrableDomain: url.registrableDomain,
        title: hit.title?.slice(0, 300) ?? null,
      },
      update: {},
    });
    await deps.db.runSource.createMany({
      data: [{ runId: run.id, sourceId: source.id, searchRank: rank, searchScore: hit.score }],
      skipDuplicates: true,
    });

    // Sources already processed by an earlier run are linked, not re-fetched.
    if (source.retrievalStatus === "FETCHED" || source.retrievalStatus === "SKIPPED") {
      stats.reusedSources++;
      continue;
    }
    await processSource(run, source, pages, stats, deps);
  }
}

async function search(run: ResearchRun, { db, search, limits, logger }: PipelineDeps): Promise<SearchHit[]> {
  const request = { query: run.query, maxResults: Math.min(run.resultLimit * 2, 50), country: run.country };
  const reservation = await reserveUsage(
    db,
    { runId: run.id, kind: "SEARCH", provider: search.name, operation: "search", estimateMicros: search.estimateCostMicros(request) },
    limits,
  );
  try {
    const response = await search.search(request);
    await settleUsage(db, reservation, run.id, "SEARCH", { costMicros: response.costMicros });
    return response.hits;
  } catch (err) {
    await settleUsage(db, reservation, run.id, "SEARCH", null);
    logger.warn({ err, runId: run.id, provider: search.name }, "search failed");
    const detail = err instanceof SearchProviderError ? ` (${err.code})` : "";
    throw new PipelineError("SEARCH_FAILED", `The search provider request failed${detail}`);
  }
}

interface SelectedSource {
  url: CanonicalUrl;
  hit: SearchHit;
  rank: number;
}

async function selectSources(run: ResearchRun, hits: SearchHit[], stats: RunStats, db: Db): Promise<SelectedSource[]> {
  const inputs = hits.map((h) => h.url);
  const candidates = inputs.flatMap((u) => {
    const c = canonicalizeUrl(u);
    return c.ok ? [c.value.canonicalUrl] : [];
  });
  const known = await db.sourceDocument.findMany({
    where: { canonicalUrl: { in: candidates } },
    select: { canonicalUrl: true },
  });

  const deduped = dedupeUrls(inputs, new Set(known.map((k) => k.canonicalUrl)));
  deduped.rejected.forEach((r) => increment(stats.rejectedUrls, r.reason));
  stats.duplicateUrls = deduped.duplicates.length;

  // Re-walk the hits so fresh and known sources keep their search rank order.
  const accepted = new Map([...deduped.fresh, ...deduped.known].map((u) => [u.canonicalUrl, u]));
  const selected: SelectedSource[] = [];
  hits.forEach((hit, rank) => {
    const c = canonicalizeUrl(hit.url);
    const url = c.ok ? accepted.get(c.value.canonicalUrl) : undefined;
    if (url) {
      accepted.delete(url.canonicalUrl);
      selected.push({ url, hit, rank });
    }
  });
  return selected.slice(0, run.resultLimit);
}

async function processSource(
  run: ResearchRun,
  source: SourceDocument,
  pages: PageFetcher,
  stats: RunStats,
  deps: PipelineDeps,
): Promise<void> {
  const { db } = deps;
  const update = (data: Parameters<Db["sourceDocument"]["update"]>[0]["data"]) =>
    db.sourceDocument.update({ where: { id: source.id }, data });
  const skip = async (reason: string, data: Parameters<typeof update>[0] = {}) => {
    await update({ ...data, retrievalStatus: "SKIPPED", skipReason: reason });
    increment(stats.skipped, reason.split(":")[0] ?? reason);
  };

  if (!(await pages.isAllowedByRobots(source.canonicalUrl))) return skip("ROBOTS_DISALLOWED");

  let page;
  try {
    page = await pages.fetchHtml(source.canonicalUrl);
  } catch (err) {
    if (!(err instanceof FetchError)) throw err;
    await update({ retrievalStatus: "FAILED", skipReason: err.code, httpStatus: err.status ?? null });
    increment(stats.failed, err.code);
    return;
  }

  const final = canonicalizeUrl(page.finalUrl);
  if (!final.ok || final.value.registrableDomain !== source.registrableDomain) return skip("CROSS_DOMAIN_REDIRECT");

  const extracted = extractPageText(page.html);
  const retrieval = {
    httpStatus: page.status,
    contentType: page.contentType,
    retrievedAt: new Date(),
    title: extracted.title ?? source.title,
  };
  if (extracted.noAi) return skip("NOAI_META", retrieval);
  if (extracted.text.length < MIN_TEXT_CHARS) return skip("INSUFFICIENT_TEXT", retrieval);

  // Syndicated or mirrored copies are recorded but not analysed again, so they
  // can never count as independent evidence.
  const contentHash = textContentHash(extracted.text);
  const original = await db.sourceDocument.findFirst({
    where: { contentHash, id: { not: source.id }, retrievalStatus: "FETCHED" },
    select: { id: true },
  });
  if (original) return skip(`DUPLICATE_CONTENT:${original.id}`, { ...retrieval, contentHash });

  await update({ ...retrieval, retrievalStatus: "FETCHED", contentHash, extractedText: extracted.text, skipReason: null });
  stats.fetched++;

  await extractEvidence(run, { id: source.id, url: source.canonicalUrl, title: retrieval.title, text: extracted.text }, stats, deps);
}

async function extractEvidence(
  run: ResearchRun,
  source: { id: string; url: string; title: string | null; text: string },
  stats: RunStats,
  { db, llm, limits, logger }: PipelineDeps,
): Promise<void> {
  const { system, prompt } = buildEvidencePrompt({ ...source, industry: run.industry, keywords: run.keywords });
  const reservation = await reserveUsage(
    db,
    {
      runId: run.id,
      kind: "LLM",
      provider: llm.name,
      operation: "extract_evidence",
      estimateMicros: llm.estimateCostMicros({
        inputChars: system.length + prompt.length,
        maxOutputTokens: EVIDENCE_MAX_OUTPUT_TOKENS,
      }),
    },
    limits,
  );

  let result;
  try {
    result = await llm.generateJson({
      system,
      prompt,
      task: "evidence_extraction",
      schema: extractionResultSchema,
      maxOutputTokens: EVIDENCE_MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    const llmError = err instanceof LlmCallError ? err : null;
    await settleUsage(db, reservation, run.id, "LLM", llmError?.usage ?? null);
    stats.extractionErrors++;
    increment(stats.extractionErrorCodes, llmError?.code ?? "UNKNOWN");
    logger.warn({ err, runId: run.id, sourceId: source.id }, "evidence extraction call failed");
    // Bad credentials or an invalid request would fail identically for every
    // remaining source, so stop instead of spending time and budget on them.
    if (llmError?.fatal) {
      throw new PipelineError("LLM_UNAVAILABLE", `The LLM provider rejected the request (${llmError.code})`);
    }
    return;
  }
  await settleUsage(db, reservation, run.id, "LLM", result.usage);

  const validation = validateExtraction(result.data, source.text);
  if (!validation.ok) {
    stats.extractionErrors++;
    increment(stats.extractionErrorCodes, "SCHEMA_MISMATCH");
    logger.warn({ runId: run.id, sourceId: source.id, error: validation.error }, "evidence output rejected");
    return;
  }
  validation.rejected.forEach((r) => increment(stats.evidenceRejected, r.reason));
  if (validation.accepted.length === 0) return;

  const created = await db.evidence.createMany({
    data: validation.accepted.map((e) => ({
      sourceId: source.id,
      runId: run.id,
      excerpt: e.excerpt,
      excerptHash: e.excerptHash,
      problemSummary: e.problemSummary,
      workflow: e.workflow,
      kind: e.kind,
      confidence: e.confidence,
      impactNote: e.impactNote,
      validationStatus: "VALID" as const,
      validationNote: e.validationNote,
      llmModel: llm.model,
      promptVersion: EVIDENCE_PROMPT_VERSION,
    })),
    skipDuplicates: true,
  });
  stats.evidenceAccepted += created.count;
}

async function assertNotCancelled(db: Db, runId: string): Promise<void> {
  const run = await db.researchRun.findUnique({ where: { id: runId }, select: { status: true } });
  if (run?.status === "CANCELLED") throw new RunCancelled();
}
