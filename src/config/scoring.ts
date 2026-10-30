import { readFileSync } from "node:fs";
import { z } from "zod";
import { ScoreComponent } from "../generated/prisma/enums.js";

const weight = z.number().min(0).max(1);

const scoringConfigSchema = z
  .object({
    version: z.string().trim().min(1).max(64),
    description: z.string().optional(),
    weights: z.strictObject({
      [ScoreComponent.FREQUENCY]: weight,
      [ScoreComponent.BUSINESS_IMPACT]: weight,
      [ScoreComponent.EVIDENCE_QUALITY]: weight,
      [ScoreComponent.RECURRENCE]: weight,
      [ScoreComponent.BUYER_ACCESSIBILITY]: weight,
      [ScoreComponent.DIFFERENTIATION]: weight,
    }),
  })
  .refine((c) => Math.abs(Object.values(c.weights).reduce((a, b) => a + b, 0) - 1) < 1e-6, {
    message: "weights must sum to 1",
    path: ["weights"],
  });

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

export function parseScoringConfig(raw: unknown): ScoringConfig {
  return scoringConfigSchema.parse(raw);
}

export function loadScoringConfig(
  path: string | URL = new URL("../../config/scoring.json", import.meta.url),
): ScoringConfig {
  return parseScoringConfig(JSON.parse(readFileSync(path, "utf8")));
}
