const STOPWORDS = new Set(
  (
    "the and for with that this from into onto over under have has had are was were been being their there they " +
    "them then than when what which while who whom whose why how all any each every some such our ours your yours " +
    "its it's not but nor can could should would will shall may might must does did doing done very more most " +
    "about after again against before between both during only same other also just because until upon via per " +
    "described manual effort business businesses owner owners staff team company companies"
  ).split(" "),
);

/** Crude suffix stripping so "schedules", "scheduled" and "scheduling" match. */
function stem(word: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

export function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().normalize("NFKD").split(/[^a-z]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    // "rescheduling" and "scheduling" describe the same workflow.
    tokens.add(stem(raw.startsWith("re") && raw.length > 7 ? raw.slice(2) : raw));
  }
  return tokens;
}

export function normalizeWorkflow(workflow: string | null): string | null {
  const tokens = workflow ? [...contentTokens(workflow)].sort() : [];
  return tokens.length ? tokens.join(" ") : null;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface ProblemText {
  problemSummary: string;
  workflow: string | null;
}

/** Minimum similarity for evidence to join an existing problem cluster. */
export const CLUSTER_THRESHOLD = 0.3;

/**
 * The cluster whose closest member is most similar to `item` (single
 * linkage), or null if none reaches the threshold. Ties go to the cluster
 * listed first, so results are deterministic.
 */
export function bestMatch<K>(
  item: ProblemText,
  members: readonly { key: K; text: ProblemText }[],
  threshold = CLUSTER_THRESHOLD,
): K | null {
  let best: { key: K; score: number } | null = null;
  for (const m of members) {
    const score = problemSimilarity(item, m.text);
    if (score >= threshold && (!best || score > best.score)) best = { key: m.key, score };
  }
  return best?.key ?? null;
}

/** 1 for an identical workflow label, otherwise keyword overlap of summary and workflow. */
export function problemSimilarity(a: ProblemText, b: ProblemText): number {
  const wa = normalizeWorkflow(a.workflow);
  if (wa !== null && wa === normalizeWorkflow(b.workflow)) return 1;
  return jaccard(contentTokens(`${a.problemSummary} ${a.workflow ?? ""}`), contentTokens(`${b.problemSummary} ${b.workflow ?? ""}`));
}
