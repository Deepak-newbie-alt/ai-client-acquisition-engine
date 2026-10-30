import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLlmProvider } from "../../src/integrations/llm/anthropic.js";
import { costMicros } from "../../src/integrations/llm/pricing.js";
import { LlmCallError } from "../../src/integrations/llm/types.js";
import { extractionResultSchema } from "../../src/modules/evidence/schema.js";

const OPUS = { inputUsdPerMTok: 4, outputUsdPerMTok: 20 };
const API_KEY = "sk-ant-test-key-should-never-leak";

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

/** A fake HTTP layer for the SDK: returns the queued replies in order. */
function fakeApi(...replies: Reply[]) {
  const calls: Captured[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...reply.headers },
      }),
    );
  };
  return { calls, fetch: fetchImpl };
}

const message = (text: string, overrides: Record<string, unknown> = {}) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 1_000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...overrides,
});

const apiError = (status: number, type: string) => ({
  status,
  body: { type: "error", error: { type, message: `upstream says ${API_KEY.slice(0, 3)}…` } },
  headers: { "retry-after-ms": "1" },
});

const provider = (fetchImpl: typeof fetch, maxRetries = 2) =>
  new AnthropicLlmProvider({ apiKey: API_KEY, model: "claude-opus-5-5", effort: "medium", pricing: OPUS, maxRetries, fetch: fetchImpl });

const request = { task: "evidence_extraction" as const, system: "system prompt", prompt: "page text", schema: extractionResultSchema, maxOutputTokens: 8_000 };

const failure = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LlmCallError);
  return err as LlmCallError;
};

describe("AnthropicLlmProvider", () => {
  it("sends a tool-less structured-output request and returns parsed JSON with cost", async () => {
    const api = fakeApi({ body: message('{"items":[]}') });
    const result = await provider(api.fetch).generateJson(request);

    expect(result).toEqual({ data: { items: [] }, usage: { inputTokens: 1_000, outputTokens: 500, costMicros: 14_000n } });

    const [call] = api.calls;
    expect(call?.url).toContain("/v1/messages");
    // SDK 1.x sends API keys as a bearer token.
    expect(call?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(call?.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 8_000,
      system: "system prompt",
      messages: [{ role: "user", content: "page text" }],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    // No tools, no thinking override (Opus 5.5 always uses adaptive thinking).
    expect(call?.body).not.toHaveProperty("tools");
    expect(call?.body).not.toHaveProperty("thinking");
    expect(call?.body).not.toHaveProperty("betas");
  });

  it("sends a schema the API accepts: closed objects, constraints moved into descriptions", async () => {
    const api = fakeApi({ body: message('{"items":[]}') });
    await provider(api.fetch).generateJson(request);
    const schema = JSON.stringify((api.calls[0]?.body.output_config as { format: { schema: unknown } }).format.schema);
    expect(schema).toContain('"additionalProperties":false');
    expect(schema).not.toMatch(/"(minLength|maxLength|minimum|maximum|maxItems)":/);
    expect(schema).toContain("minLength: 20");
    expect(schema).toContain("OBSERVED");
  });

  it("returns unvalidated data; validation is the caller's job", async () => {
    const api = fakeApi({ body: message('{"items":[{"excerpt":"short"}]}') });
    const result = await provider(api.fetch).generateJson({ ...request, schema: z.object({ items: z.array(z.object({ excerpt: z.string() })) }) });
    expect(result.data).toEqual({ items: [{ excerpt: "short" }] });
  });

  it("estimates the worst case from input size and max_tokens", () => {
    // 3,000 chars ≈ 1,000 tokens at the conservative 3 chars/token, plus the full 8,000-token output.
    expect(provider(fakeApi().fetch).estimateCostMicros({ inputChars: 3_000, maxOutputTokens: 8_000 })).toBe(
      costMicros(OPUS, 1_000, 8_000),
    );
  });

  it("prices fallback-served responses at the higher of the two models", async () => {
    const api = fakeApi({ body: message('{"items":[]}', { model: "claude-fable-5-1" }) });
    const result = await provider(api.fetch).generateJson(request);
    expect(result.usage.costMicros).toBe(costMicros({ inputUsdPerMTok: 10, outputUsdPerMTok: 50 }, 1_000, 500));
  });

  it("reports refusals with their usage so spend is still recorded", async () => {
    const api = fakeApi({
      body: message("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }),
    });
    const err = await failure(provider(api.fetch).generateJson(request));
    expect(err).toMatchObject({ code: "REFUSAL", fatal: false, usage: { inputTokens: 1_000, outputTokens: 500 } });
    expect(err.message).toContain("cyber");
  });

  it("reports truncated output", async () => {
    const api = fakeApi({ body: message('{"items":[', { stop_reason: "max_tokens" }) });
    expect((await failure(provider(api.fetch).generateJson(request))).code).toBe("TRUNCATED");
  });

  it("reports non-JSON output", async () => {
    const api = fakeApi({ body: message("Sure! Here is the evidence you asked for.") });
    const err = await failure(provider(api.fetch).generateJson(request));
    expect(err).toMatchObject({ code: "INVALID_OUTPUT", usage: { outputTokens: 500 } });
  });

  it("does not retry authentication errors and marks them fatal without leaking the key", async () => {
    const api = fakeApi(apiError(401, "authentication_error"));
    const err = await failure(provider(api.fetch).generateJson(request));
    expect(err).toMatchObject({ code: "AUTH", fatal: true });
    expect(err.message).not.toContain(API_KEY);
    expect(api.calls).toHaveLength(1);
  });

  it("treats invalid requests and unknown models as fatal", async () => {
    expect(await failure(provider(fakeApi(apiError(400, "invalid_request_error")).fetch).generateJson(request))).toMatchObject({
      code: "BAD_REQUEST",
      fatal: true,
    });
    expect((await failure(provider(fakeApi(apiError(404, "not_found_error")).fetch).generateJson(request))).code).toBe(
      "BAD_REQUEST",
    );
  });

  it("retries rate limits and overload with the SDK's backoff, then succeeds", async () => {
    const api = fakeApi(apiError(429, "rate_limit_error"), apiError(529, "overloaded_error"), { body: message('{"items":[]}') });
    await expect(provider(api.fetch).generateJson(request)).resolves.toMatchObject({ data: { items: [] } });
    expect(api.calls).toHaveLength(3);
  });

  it("gives up after the retry limit with a non-fatal error", async () => {
    const api = fakeApi(apiError(529, "overloaded_error"));
    const err = await failure(provider(api.fetch, 1).generateJson(request));
    expect(err).toMatchObject({ code: "UNAVAILABLE", fatal: false });
    expect(api.calls).toHaveLength(2);
  });

  it("maps connection failures", async () => {
    const failing = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    expect((await failure(provider(failing, 0).generateJson(request))).code).toBe("CONNECTION");
  });
});
