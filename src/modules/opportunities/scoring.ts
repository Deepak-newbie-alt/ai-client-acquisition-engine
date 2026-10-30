import type { ScoreComponent } from "../../generated/prisma/enums.js";
import type { ScoringConfig } from "../../config/scoring.js";

/**
 * Transparent opportunity scoring. Every component is a 0-5 heuristic computed
 * from stored evidence by the rules below, with a rationale and the evidence
 * it relied on. A component with no supporting signal is null (unknown) and
 * contributes nothing to the total. Scores rank leads for human review; they
 * are not probabilities of commercial success.
 */

export interface ScoringEvidence {
  id: string;
  excerpt: string;
  impactNote: string | null;
  kind: "OBSERVED" | "INFERRED" | "UNKNOWN";
  confidence: number;
}

export interface Alternative {
  name: string;
  note?: string | undefined;
  fit: "good" | "partial" | "poor";
}

export interface ScoringInput {
  evidence: ScoringEvidence[];
  /** Distinct companies (or domains when no company is known) behind the evidence. */
  independentCompanies: number;
  /** Companies linked to the cluster's sources, and how many have a usable contact. */
  linkedCompanies: number;
  reachableCompanies: number;
  alternatives: Alternative[];
}

export interface ComponentScore {
  component: ScoreComponent;
  value: number | null;
  rationale: string;
  evidenceIds: string[];
}

export interface ScoreResult {
  components: ComponentScore[];
  /** Sum of weight x value over known components (0-5). */
  total: number;
  /** Sum of the weights of known components (0-1). */
  coverage: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const FREQUENCY_PATTERNS: [RegExp, number, string][] = [
  [/\b(every|each) (single )?(day|morning|afternoon|evening|night)\b|\bdaily\b|\bevery shift\b/i, 5, "daily"],
  [/\b(every|each) (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bweekly\b|\bend of (each|every|the) week\b/i, 4, "weekly"],
  [/\b(every|each) month\b|\bmonthly\b|\bmonth[- ]end\b/i, 3, "monthly"],
  [/\b(whenever|every time|each time|always|constantly|regularly|routinely)\b/i, 3, "recurring"],
];

const IMPACT_PATTERNS: [RegExp, number, string][] = [
  [/[$£€]|\b(cost|costs|revenue|lose|loses|lost|loss|money|pay|paid|fine|fines)\b/i, 5, "money"],
  [/\b(hours?|days?|minutes?|afternoons?|evenings?|mornings?|weekends?|time)\b/i, 4, "staff time"],
  [/\b(errors?|mistakes?|complain\w*|missed|late|cancel\w*|churn)\b/i, 4, "errors or customer impact"],
];

const TOOL_SHORTFALL =
  /\b(tried|looked at|tested|trialled|trialed)\b[^.]*\b(software|apps?|tools?|systems?|packages?|platforms?)\b|\b(too expensive|cost(s)? a fortune|built for (much )?larger|weeks of setup|went back to|didn'?t work|too complicated|too complex)\b/i;

function classify(text: string, patterns: [RegExp, number, string][]): { score: number; label: string } | null {
  for (const [re, score, label] of patterns) if (re.test(text)) return { score, label };
  return null;
}

const countLabels = (labels: string[]) =>
  Object.entries(labels.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l]: (acc[l] ?? 0) + 1 }), {}))
    .map(([label, n]) => `${n} ${label}`)
    .join(", ");

function frequency(evidence: ScoringEvidence[]): ComponentScore {
  const hits = evidence.flatMap((e) => {
    const c = classify(e.excerpt, FREQUENCY_PATTERNS);
    return c ? [{ id: e.id, ...c }] : [];
  });
  if (hits.length === 0) {
    return { component: "FREQUENCY", value: null, rationale: "No excerpt states how often the problem occurs.", evidenceIds: [] };
  }
  return {
    component: "FREQUENCY",
    value: round1(mean(hits.map((h) => h.score))),
    rationale: `${hits.length} of ${evidence.length} excerpts state a frequency (${countLabels(hits.map((h) => h.label))}). Daily=5, weekly=4, monthly or "whenever"=3; averaged.`,
    evidenceIds: hits.map((h) => h.id),
  };
}

function businessImpact(evidence: ScoringEvidence[]): ComponentScore {
  const hits = evidence.flatMap((e) => {
    if (!e.impactNote) return [];
    const c = classify(e.impactNote, IMPACT_PATTERNS) ?? { score: 3, label: "other stated impact" };
    return [{ id: e.id, ...c }];
  });
  if (hits.length === 0) {
    return { component: "BUSINESS_IMPACT", value: null, rationale: "No excerpt states an impact; impact remains unknown.", evidenceIds: [] };
  }
  return {
    component: "BUSINESS_IMPACT",
    value: round1(mean(hits.map((h) => h.score))),
    rationale: `${hits.length} of ${evidence.length} excerpts state an impact (${countLabels(hits.map((h) => h.label))}). Money=5, staff time or errors=4, other=3; averaged. No monetary value is inferred.`,
    evidenceIds: hits.map((h) => h.id),
  };
}

const KIND_WEIGHT = { OBSERVED: 1, INFERRED: 0.5, UNKNOWN: 0 } as const;

function evidenceQuality(evidence: ScoringEvidence[]): ComponentScore {
  const directness = mean(evidence.map((e) => KIND_WEIGHT[e.kind]));
  const confidence = mean(evidence.map((e) => e.confidence));
  const observed = evidence.filter((e) => e.kind === "OBSERVED").length;
  return {
    component: "EVIDENCE_QUALITY",
    value: round1(5 * (0.5 * directness + 0.5 * confidence)),
    rationale: `${observed} of ${evidence.length} excerpts are direct observations (observed=1, inferred=0.5, unknown=0; mean ${directness.toFixed(2)}); mean extraction confidence ${confidence.toFixed(2)}. Score = 5 x average of the two.`,
    evidenceIds: evidence.map((e) => e.id),
  };
}

function recurrence(input: ScoringInput): ComponentScore {
  const n = input.independentCompanies;
  const value = n >= 6 ? 5 : n >= 4 ? 4 : Math.max(1, Math.min(n, 3));
  return {
    component: "RECURRENCE",
    value,
    rationale: `Reported by ${n} independent ${n === 1 ? "business or site" : "businesses or sites"} (pages from one domain or company count once; syndicated copies are excluded). 1->1, 2->2, 3->3, 4-5->4, 6+->5.`,
    evidenceIds: input.evidence.map((e) => e.id),
  };
}

function buyerAccessibility(input: ScoringInput): ComponentScore {
  if (input.linkedCompanies === 0) {
    return {
      component: "BUYER_ACCESSIBILITY",
      value: null,
      rationale: "No companies are linked to this problem's sources yet.",
      evidenceIds: [],
    };
  }
  return {
    component: "BUYER_ACCESSIBILITY",
    value: round1((5 * input.reachableCompanies) / input.linkedCompanies),
    rationale: `${input.reachableCompanies} of ${input.linkedCompanies} linked companies have a public business contact that is not invalid or suppressed. Score = 5 x share.`,
    evidenceIds: [],
  };
}

const FIT_SCORE = { good: 1, partial: 3, poor: 5 } as const;

function differentiation(input: ScoringInput): ComponentScore {
  if (input.alternatives.length > 0) {
    const best = input.alternatives.reduce((a, b) => (FIT_SCORE[a.fit] <= FIT_SCORE[b.fit] ? a : b));
    return {
      component: "DIFFERENTIATION",
      value: FIT_SCORE[best.fit],
      rationale: `Best reviewed alternative "${best.name}" is rated a ${best.fit} fit (good=1, partial=3, poor=5) across ${input.alternatives.length} reviewed alternative(s).`,
      evidenceIds: [],
    };
  }
  const shortfalls = input.evidence.filter((e) => TOOL_SHORTFALL.test(e.excerpt));
  if (shortfalls.length > 0) {
    return {
      component: "DIFFERENTIATION",
      value: 4,
      rationale: `${shortfalls.length} excerpt(s) say existing tools fall short (tried, too expensive, too complex, or abandoned). No alternatives have been reviewed yet.`,
      evidenceIds: shortfalls.map((e) => e.id),
    };
  }
  return {
    component: "DIFFERENTIATION",
    value: null,
    rationale: "No alternatives reviewed and no excerpt discusses existing tools.",
    evidenceIds: [],
  };
}

export function scoreOpportunity(input: ScoringInput, config: ScoringConfig): ScoreResult {
  if (input.evidence.length === 0) throw new Error("Cannot score a problem without evidence");
  const components = [
    frequency(input.evidence),
    businessImpact(input.evidence),
    evidenceQuality(input.evidence),
    recurrence(input),
    buyerAccessibility(input),
    differentiation(input),
  ];
  let total = 0;
  let coverage = 0;
  for (const c of components) {
    if (c.value === null) continue;
    total += config.weights[c.component] * c.value;
    coverage += config.weights[c.component];
  }
  return { components, total: Math.round(total * 100) / 100, coverage: Math.round(coverage * 100) / 100 };
}
