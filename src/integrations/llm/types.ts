import type { z } from "zod";

export interface JsonGenerationRequest {
  /** What the call is for; used for logging and by the mock provider. */
  task: "evidence_extraction" | "outreach_draft";
  system: string;
  prompt: string;
  /** Shape the output must follow. Providers may use it to constrain generation. */
  schema: z.ZodType;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costMicros: bigint;
}

export interface JsonGenerationResult {
  /** Parsed but unvalidated output; callers must validate it with Zod. */
  data: unknown;
  usage: LlmUsage;
}

export type LlmErrorCode =
  | "AUTH" // invalid key or no permission: configuration problem
  | "BAD_REQUEST" // rejected request or unknown model: configuration problem
  | "RATE_LIMITED"
  | "UNAVAILABLE" // 5xx or overloaded after retries
  | "CONNECTION"
  | "TIMEOUT"
  | "REFUSAL"
  | "TRUNCATED"
  | "INVALID_OUTPUT";

/**
 * A failed call. `fatal` means every further call would fail the same way, so
 * a pipeline should stop instead of trying the next source. `usage` is set
 * when the provider reported (billable) usage before the failure.
 */
export class LlmCallError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly usage?: LlmUsage,
  ) {
    super(message);
    this.name = "LlmCallError";
  }

  get fatal(): boolean {
    return this.code === "AUTH" || this.code === "BAD_REQUEST";
  }
}

/**
 * Bounded, tool-less text-to-JSON calls. Providers get no access to tools,
 * the network (beyond their own API), the filesystem or the database.
 */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Upper-bound cost for a call, used to reserve budget before calling. */
  estimateCostMicros(request: { inputChars: number; maxOutputTokens: number }): bigint;
  /** Throws LlmCallError on failure. */
  generateJson(request: JsonGenerationRequest): Promise<JsonGenerationResult>;
}
