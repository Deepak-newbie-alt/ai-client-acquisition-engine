import { sourceTextFromPrompt } from "../../modules/evidence/prompt.js";
import { templateDraft, type DraftFacts } from "../../modules/outreach/content.js";
import type { JsonGenerationRequest, LlmProvider } from "./types.js";

const PROBLEM_SIGNALS = /\b(spends?|by hand|re-type|spreadsheet|chasing|killing us|time-consuming|manual|weeks of setup)\b/i;

/**
 * Deterministic stand-in for evidence extraction: returns sentences from the
 * page that contain problem signals, labelled OBSERVED. Good enough to drive
 * the pipeline end to end without an API key.
 */
export function heuristicEvidence(request: JsonGenerationRequest): unknown {
  const text = sourceTextFromPrompt(request.prompt);
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim());
  const items = sentences
    .filter((s) => s.length >= 20 && PROBLEM_SIGNALS.test(s))
    .slice(0, 4)
    .map((excerpt) => ({
      excerpt,
      problemSummary: `Manual effort described: ${excerpt.slice(0, 120)}`,
      workflow: /schedul/i.test(excerpt) ? "job scheduling" : /invoic|job sheet/i.test(excerpt) ? "job paperwork" : null,
      kind: "OBSERVED",
      confidence: 0.6,
      impactNote: /\bhours?\b|afternoon|evening/i.test(excerpt) ? "Staff time stated in the excerpt." : null,
    }));
  return { items };
}

/** Deterministic outreach draft built only from the facts in the prompt. */
export function templateOutreach(request: JsonGenerationRequest): unknown {
  const json = /<facts>\n([\s\S]*)\n<\/facts>/.exec(request.prompt)?.[1];
  return templateDraft(JSON.parse(json ?? "{}") as DraftFacts);
}

export interface MockLlmOptions {
  respond?: (request: JsonGenerationRequest) => unknown;
  costMicros?: bigint;
  fail?: boolean;
}

export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock-evidence-extractor";
  readonly requests: JsonGenerationRequest[] = [];

  constructor(private readonly options: MockLlmOptions = {}) {}

  estimateCostMicros(): bigint {
    return this.options.costMicros ?? 0n;
  }

  generateJson(request: JsonGenerationRequest) {
    this.requests.push(request);
    if (this.options.fail) return Promise.reject(new Error("mock llm failure"));
    const respond = this.options.respond ?? (request.task === "outreach_draft" ? templateOutreach : heuristicEvidence);
    const data = respond(request);
    return Promise.resolve({
      data,
      usage: {
        inputTokens: Math.ceil((request.system.length + request.prompt.length) / 4),
        outputTokens: Math.ceil(JSON.stringify(data).length / 4),
        costMicros: this.options.costMicros ?? 0n,
      },
    });
  }
}
