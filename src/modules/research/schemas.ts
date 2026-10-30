import { z } from "zod";
import { safeText as text } from "../../lib/validation.js";

export const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-1000", "1000+"] as const;

/** Builds the request schema with the configured per-run result cap. */
export function createResearchRunSchema(maxResultsPerRun: number) {
  return z.strictObject({
    industry: text(2, 80),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "must be an ISO 3166-1 alpha-2 code")
      .transform((c) => c.toUpperCase()),
    companySize: z.enum(COMPANY_SIZES).optional(),
    keywords: z.array(text(2, 50)).max(10).default([]),
    resultLimit: z.number().int().min(1).max(maxResultsPerRun),
  });
}

export type ResearchFilters = z.infer<ReturnType<typeof createResearchRunSchema>>;

export const listRunsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.iso.datetime().optional(),
});

/**
 * Deterministic search query from validated filters. Quotes and operators
 * are stripped so filter text cannot change the query's structure.
 */
export function buildSearchQuery(filters: Pick<ResearchFilters, "industry" | "country" | "companySize" | "keywords">): string {
  const strip = (s: string) => s.replace(/["'()[\]{}:<>|\\^~*]/g, " ").replace(/\s+/g, " ").trim();
  const parts = [
    `${strip(filters.industry)} small business`,
    filters.companySize ? `${filters.companySize} employees` : null,
    ...filters.keywords.map(strip),
    "manual process OR time-consuming OR spreadsheet OR paperwork",
    `country ${filters.country}`,
  ].filter((p): p is string => Boolean(p));
  return parts.join(" ").slice(0, 400);
}
