/**
 * Live check of the real providers: one Tavily search, then one Claude
 * evidence extraction on the first retrievable result. Spends real money
 * (1-2 Tavily credits and one Claude call), so it prints the worst-case cost
 * and does nothing unless --yes is passed. Nothing is written to the database.
 *
 *   npm run providers:smoke -- --query "plumbing scheduling spreadsheet" --country GB --yes
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config/env.js";
import { createIntegrations } from "../src/integrations/index.js";
import { buildEvidencePrompt, EVIDENCE_MAX_OUTPUT_TOKENS } from "../src/modules/evidence/prompt.js";
import { extractionResultSchema } from "../src/modules/evidence/schema.js";
import { validateExtraction } from "../src/modules/evidence/validate.js";
import { FetchError } from "../src/lib/safe-fetch.js";
import { dedupeUrls } from "../src/lib/url.js";
import { extractPageText } from "../src/modules/sources/extract.js";

const { values } = parseArgs({
  options: {
    query: { type: "string", default: "small HVAC business scheduling spreadsheet manual process" },
    country: { type: "string", default: "GB" },
    yes: { type: "boolean", default: false },
  },
});

const config = loadConfig();
if (config.search.provider !== "tavily" || config.llm.provider !== "anthropic" || config.pageFetcher !== "http") {
  console.error("Set SEARCH_PROVIDER=tavily, LLM_PROVIDER=anthropic and PAGE_FETCHER=http (with keys) in .env first.");
  process.exit(1);
}

const { search, llm, pages } = createIntegrations(config);
const searchRequest = { query: values.query, maxResults: 5, country: values.country };
const usd = (micros: bigint) => `$${(Number(micros) / 1e6).toFixed(4)}`;
const worstCase =
  search.estimateCostMicros(searchRequest) +
  llm.estimateCostMicros({ inputChars: 25_000, maxOutputTokens: EVIDENCE_MAX_OUTPUT_TOKENS });

console.log(`Search: tavily (${config.search.depth}); LLM: ${llm.model} (effort ${config.llm.effort})`);
console.log(`Worst-case cost of this check: ${usd(worstCase)}`);
if (!values.yes) {
  console.log("Re-run with --yes to spend it.");
  process.exit(0);
}

const results = await search.search(searchRequest);
console.log(`\nSearch returned ${results.hits.length} hits (cost ${usd(results.costMicros)}):`);
results.hits.forEach((h, i) => console.log(`  ${i + 1}. ${h.url}`));

const fetcher = pages();
const { fresh, rejected } = dedupeUrls(results.hits.map((h) => h.url));
rejected.forEach((r) => console.log(`  rejected ${r.input}: ${r.reason}`));

for (const candidate of fresh) {
  const url = candidate.canonicalUrl;
  if (!(await fetcher.isAllowedByRobots(url))) {
    console.log(`  skipped ${url}: robots.txt`);
    continue;
  }
  let html: string;
  try {
    html = (await fetcher.fetchHtml(url)).html;
  } catch (err) {
    console.log(`  skipped ${url}: ${err instanceof FetchError ? err.code : "error"}`);
    continue;
  }
  const page = extractPageText(html);
  if (page.noAi || page.text.length < 120) {
    console.log(`  skipped ${url}: ${page.noAi ? "noai" : "too little text"}`);
    continue;
  }

  console.log(`\nExtracting evidence from ${url} (${page.text.length} chars)...`);
  const { system, prompt } = buildEvidencePrompt({ url, title: page.title, text: page.text, industry: values.query, keywords: [] });
  const result = await llm.generateJson({ task: "evidence_extraction", system, prompt, schema: extractionResultSchema, maxOutputTokens: EVIDENCE_MAX_OUTPUT_TOKENS });
  console.log(`LLM usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out, cost ${usd(result.usage.costMicros)}`);

  const validation = validateExtraction(result.data, page.text);
  if (!validation.ok) {
    console.log(`Output rejected: ${validation.error}`);
  } else {
    console.log(`Accepted ${validation.accepted.length}, rejected ${validation.rejected.length}:`);
    for (const e of validation.accepted) console.log(`  [${e.kind} ${e.confidence}] ${e.problemSummary}\n      "${e.excerpt}"`);
    for (const r of validation.rejected) console.log(`  rejected item ${r.index}: ${r.reason}`);
  }
  console.log(`\nTotal spent: ${usd(results.costMicros + result.usage.costMicros)}`);
  process.exit(0);
}
console.log("\nNo retrievable page among the results; no LLM call was made.");
