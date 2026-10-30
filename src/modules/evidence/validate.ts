import { sha256Hex } from "../../lib/hash.js";
import { extractionResultSchema, type ExtractedEvidence } from "./schema.js";

export interface ValidatedEvidence extends ExtractedEvidence {
  excerptHash: string;
  validationNote: string | null;
}

export type EvidenceRejectReason = "EXCERPT_NOT_IN_SOURCE" | "DUPLICATE_EXCERPT";

export type ExtractionValidation =
  | { ok: true; accepted: ValidatedEvidence[]; rejected: { index: number; reason: EvidenceRejectReason }[] }
  | { ok: false; error: string };

/** Normalization used only to compare an excerpt with its source. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const FIGURE = /\d[\d,.]*/g;

/**
 * Validates model output against the schema and against the source text.
 * Excerpts that do not appear in the source are rejected (fabricated or
 * paraphrased quotes). Figures in impactNote that are not in the excerpt are
 * treated as invented, and the impact is reset to unknown.
 */
export function validateExtraction(raw: unknown, sourceText: string): ExtractionValidation {
  const parsed = extractionResultSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].slice(0, 5);
    return { ok: false, error: `Model output failed schema validation at: ${paths.join(", ")}` };
  }

  const source = normalizeForMatch(sourceText);
  const seen = new Set<string>();
  const accepted: ValidatedEvidence[] = [];
  const rejected: { index: number; reason: EvidenceRejectReason }[] = [];

  parsed.data.items.forEach((item, index) => {
    const excerpt = normalizeForMatch(item.excerpt);
    if (!source.includes(excerpt)) {
      rejected.push({ index, reason: "EXCERPT_NOT_IN_SOURCE" });
      return;
    }
    const excerptHash = sha256Hex(excerpt);
    if (seen.has(excerptHash)) {
      rejected.push({ index, reason: "DUPLICATE_EXCERPT" });
      return;
    }
    seen.add(excerptHash);

    let impactNote = item.impactNote;
    let validationNote: string | null = null;
    if (impactNote) {
      const figures = impactNote.match(FIGURE) ?? [];
      if (figures.some((f) => !excerpt.includes(f.replace(/[.,]+$/, "")))) {
        impactNote = null;
        validationNote = "Impact removed: figures not present in the excerpt.";
      }
    }

    accepted.push({ ...item, excerpt, excerptHash, impactNote, validationNote });
  });

  return { ok: true, accepted, rejected };
}
