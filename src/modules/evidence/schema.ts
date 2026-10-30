import { z } from "zod";

export const MAX_EVIDENCE_ITEMS = 8;

export const extractedEvidenceSchema = z.strictObject({
  excerpt: z
    .string()
    .min(20)
    .max(600)
    .describe("Verbatim quotation copied exactly from the source document."),
  problemSummary: z.string().min(10).max(300).describe("One sentence naming the operational problem."),
  workflow: z.string().min(2).max(120).nullable().describe("The business workflow affected, e.g. 'job scheduling'."),
  kind: z
    .enum(["OBSERVED", "INFERRED", "UNKNOWN"])
    .describe(
      "OBSERVED: the excerpt directly states the problem. INFERRED: the problem is a reasonable reading of the excerpt but not stated. UNKNOWN: unclear.",
    ),
  confidence: z.number().min(0).max(1).describe("How strongly the excerpt supports the problem summary."),
  impactNote: z
    .string()
    .min(3)
    .max(300)
    .nullable()
    .describe("Impact stated in the excerpt (time, cost, errors). Null if the source does not state it."),
});

export const extractionResultSchema = z.strictObject({
  items: z.array(extractedEvidenceSchema).max(MAX_EVIDENCE_ITEMS),
});

export type ExtractedEvidence = z.infer<typeof extractedEvidenceSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
