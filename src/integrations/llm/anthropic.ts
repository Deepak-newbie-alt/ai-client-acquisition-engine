import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ANTHROPIC_PRICING, costMicros, MAX_LISTED_PRICING, maxPricing, type ModelPricing } from "./pricing.js";
import {
  LlmCallError,
  type JsonGenerationRequest,
  type JsonGenerationResult,
  type LlmProvider,
  type LlmUsage,
} from "./types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  pricing: ModelPricing;
  timeoutMs?: number;
  maxRetries?: number;
  /** Test hook: replaces the HTTP layer underneath the SDK. */
  fetch?: typeof fetch;
}

/** Conservative token estimate for budgeting (real tokenizers average ~4 chars/token for English). */
const estimateTokens = (chars: number) => Math.ceil(chars / 3);

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Evidence extraction through the Claude API with structured JSON output.
 * The SDK retries 408/409/429/5xx and connection errors with backoff
 * (`maxRetries`); this class maps what remains to LlmCallError and records
 * the reported token usage for budgeting. No tools are offered to the model.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.model = options.model;
    this.client = new Anthropic({
      // Passed explicitly so a missing key fails loudly instead of falling back
      // to ambient credentials (e.g. a developer's CLI login).
      apiKey: options.apiKey,
      timeout: options.timeoutMs ?? 120_000,
      maxRetries: options.maxRetries ?? 2,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  estimateCostMicros(request: { inputChars: number; maxOutputTokens: number }): bigint {
    // max_tokens bounds thinking plus visible output, so it is the output ceiling.
    return costMicros(this.options.pricing, estimateTokens(request.inputChars), request.maxOutputTokens);
  }

  async generateJson(request: JsonGenerationRequest): Promise<JsonGenerationResult> {
    // The SDK helper converts the Zod schema and strips constraints the API
    // does not enforce (lengths, ranges); callers re-validate with Zod.
    const { type, schema } = betaZodOutputFormat(request.schema);

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
          output_config: { effort: this.options.effort, format: { type, schema } },
          // On a policy decline, retry server-side on the model's default fallback.
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        },
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (err) {
      throw toLlmCallError(err);
    }

    const usage = this.usageOf(response);
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unspecified";
      throw new LlmCallError("REFUSAL", `Model declined the request (category: ${category})`, usage);
    }
    if (response.stop_reason === "max_tokens") {
      throw new LlmCallError("TRUNCATED", "Model output hit max_tokens before completing", usage);
    }

    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    try {
      return { data: JSON.parse(text) as unknown, usage };
    } catch {
      throw new LlmCallError("INVALID_OUTPUT", "Model output was not valid JSON", usage);
    }
  }

  private usageOf(response: Anthropic.Beta.BetaMessage): LlmUsage {
    const u = response.usage;
    const inputTokens =
      u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    // A fallback may serve the request on another model. Price at the higher
    // of the configured and serving model so recorded spend is never too low.
    const served = ANTHROPIC_PRICING[response.model] ?? (response.model === this.model ? this.options.pricing : MAX_LISTED_PRICING);
    const pricing = maxPricing(this.options.pricing, served);
    return { inputTokens, outputTokens: u.output_tokens, costMicros: costMicros(pricing, inputTokens, u.output_tokens) };
  }
}

/** Maps SDK errors (most specific first) without copying response bodies into messages. */
function toLlmCallError(err: unknown): LlmCallError {
  if (err instanceof LlmCallError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmCallError("TIMEOUT", "Claude API request timed out");
  if (err instanceof Anthropic.APIConnectionError) return new LlmCallError("CONNECTION", "Could not reach the Claude API");
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmCallError("AUTH", `Claude API rejected the credentials (HTTP ${err.status})`);
  }
  if (err instanceof Anthropic.RateLimitError) return new LlmCallError("RATE_LIMITED", "Claude API rate limit reached");
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.UnprocessableEntityError) {
    return new LlmCallError("BAD_REQUEST", `Claude API rejected the request (HTTP ${err.status}, ${err.type ?? "unknown"})`);
  }
  if (err instanceof Anthropic.APIError) {
    // 402 billing errors are a configuration problem, like auth.
    if (err.status === 402) return new LlmCallError("AUTH", "Claude API billing error (HTTP 402)");
    return new LlmCallError("UNAVAILABLE", `Claude API error (HTTP ${err.status ?? "unknown"})`);
  }
  return new LlmCallError("UNAVAILABLE", "Unexpected error calling the Claude API");
}
