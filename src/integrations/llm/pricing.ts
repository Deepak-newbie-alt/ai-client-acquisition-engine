export interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/**
 * Anthropic first-party list prices (USD per million tokens), as published
 * on 2026-10-06. Used only to estimate and record spend for budget limits;
 * check https://platform.claude.com/docs/en/about-claude/pricing for current
 * prices. Models not listed here need explicit prices in configuration.
 */
export const ANTHROPIC_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-fable-5-1": { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  "claude-fable-5": { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  "claude-opus-5-5": { inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
  "claude-opus-5": { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  "claude-sonnet-5-5": { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  "claude-sonnet-5": { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  "claude-haiku-5-5": { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
};

/** The most expensive listed model; used when a response was served by an unlisted model. */
export const MAX_LISTED_PRICING: ModelPricing = Object.values(ANTHROPIC_PRICING).reduce((max, p) =>
  p.outputUsdPerMTok > max.outputUsdPerMTok ? p : max,
);

/** USD per MTok times tokens is exactly micro-USD; rounded up to stay conservative. */
export function costMicros(pricing: ModelPricing, inputTokens: number, outputTokens: number): bigint {
  return BigInt(Math.ceil(inputTokens * pricing.inputUsdPerMTok + outputTokens * pricing.outputUsdPerMTok));
}

/** Higher of two price points, per direction. */
export function maxPricing(a: ModelPricing, b: ModelPricing): ModelPricing {
  return {
    inputUsdPerMTok: Math.max(a.inputUsdPerMTok, b.inputUsdPerMTok),
    outputUsdPerMTok: Math.max(a.outputUsdPerMTok, b.outputUsdPerMTok),
  };
}
