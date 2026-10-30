import { z } from "zod";
import type { ScoringConfig } from "../../config/scoring.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Db } from "../../lib/db.js";
import { suppressionMatcher } from "../contacts/suppression.js";
import { scoreOpportunity } from "./scoring.js";
import { bestMatch, type ProblemText } from "./similarity.js";

export const alternativeSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional(),
  fit: z.enum(["good", "partial", "poor"]),
});

const storedAlternatives = z.array(alternativeSchema);

// Arbitrary constant key; serializes clustering so concurrent refreshes cannot
// create competing clusters for the same evidence.
const OPPORTUNITY_LOCK_KEY = 4_216_002;

type Tx = Prisma.TransactionClient;

export interface RefreshResult {
  assigned: number;
  created: number;
  scored: number;
}

/**
 * Brings problem clusters up to date: drops rejected evidence, assigns new
 * valid evidence to the most similar cluster (or starts a new one), removes
 * empty clusters, then recomputes independence counts and scores for all
 * clusters. Safe to call after every research run and on demand.
 */
export async function refreshOpportunities(db: Db, config: ScoringConfig, now = new Date()): Promise<RefreshResult> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OPPORTUNITY_LOCK_KEY})`;
      await tx.clusterEvidence.deleteMany({ where: { evidence: { validationStatus: { not: "VALID" } } } });
      const { assigned, created } = await assignEvidence(tx);
      await tx.problemCluster.deleteMany({ where: { evidence: { none: {} } } });
      const scored = await scoreAll(tx, config, now);
      return { assigned, created, scored };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

async function assignEvidence(tx: Tx): Promise<{ assigned: number; created: number }> {
  const links = await tx.clusterEvidence.findMany({
    orderBy: [{ cluster: { createdAt: "asc" } }, { createdAt: "asc" }],
    select: { clusterId: true, evidence: { select: { problemSummary: true, workflow: true } } },
  });
  const members: { key: string; text: ProblemText }[] = links.map((l) => ({ key: l.clusterId, text: l.evidence }));

  const pending = await tx.evidence.findMany({
    where: { validationStatus: "VALID", clusters: { none: {} } },
    orderBy: [{ extractedAt: "asc" }, { id: "asc" }],
    select: { id: true, problemSummary: true, workflow: true, run: { select: { industry: true } } },
  });

  let assigned = 0;
  let created = 0;
  for (const e of pending) {
    const text = { problemSummary: e.problemSummary, workflow: e.workflow };
    let clusterId = bestMatch(text, members);
    if (clusterId) {
      await tx.clusterEvidence.create({ data: { clusterId, evidenceId: e.id } });
      assigned++;
    } else {
      const summary = e.problemSummary.replace(/\s+/g, " ").trim();
      const cluster = await tx.problemCluster.create({
        data: {
          normalizedKey: `seed:${e.id}`,
          title: summary.length > 120 ? `${summary.slice(0, 117)}...` : summary,
          description: summary,
          segment: e.run?.industry ?? "Unspecified",
          buyer: "Not yet identified",
          evidence: { create: { evidenceId: e.id } },
        },
      });
      clusterId = cluster.id;
      created++;
    }
    members.push({ key: clusterId, text });
  }
  return { assigned, created };
}

async function scoreAll(tx: Tx, config: ScoringConfig, now: Date): Promise<number> {
  const clusters = await tx.problemCluster.findMany({
    include: {
      evidence: {
        include: {
          evidence: {
            select: {
              id: true,
              excerpt: true,
              excerptHash: true,
              impactNote: true,
              kind: true,
              confidence: true,
              source: { select: { id: true, registrableDomain: true, companyId: true } },
            },
          },
        },
      },
    },
  });

  const companyIds = [...new Set(clusters.flatMap((c) => c.evidence.flatMap((l) => l.evidence.source.companyId ?? [])))];
  const [companies, suppressions] = await Promise.all([
    tx.company.findMany({
      where: { id: { in: companyIds } },
      select: { id: true, contacts: { select: { emailNormalized: true, verificationStatus: true } } },
    }),
    tx.suppressionRecord.findMany({ select: { scope: true, value: true } }),
  ]);
  const suppressed = suppressionMatcher(suppressions);
  const reachable = new Set(
    companies
      .filter((c) => c.contacts.some((k) => k.verificationStatus !== "INVALID" && !suppressed(k.emailNormalized)))
      .map((c) => c.id),
  );

  for (const cluster of clusters) {
    const evidence = cluster.evidence.map((l) => l.evidence);
    const independence = independenceOf(evidence);
    const linked = [...new Set(evidence.flatMap((e) => e.source.companyId ?? []))];
    const parsedAlternatives = storedAlternatives.safeParse(cluster.alternatives);

    const result = scoreOpportunity(
      {
        evidence,
        independentCompanies: independence.companies,
        linkedCompanies: linked.length,
        reachableCompanies: linked.filter((id) => reachable.has(id)).length,
        alternatives: parsedAlternatives.success ? parsedAlternatives.data : [],
      },
      config,
    );

    await tx.clusterScore.deleteMany({ where: { clusterId: cluster.id } });
    for (const c of result.components) {
      await tx.clusterScore.create({
        data: {
          clusterId: cluster.id,
          component: c.component,
          value: c.value,
          weight: config.weights[c.component],
          rationale: c.rationale,
          weightsVersion: config.version,
          computedAt: now,
          evidence: { create: c.evidenceIds.map((evidenceId) => ({ evidenceId })) },
        },
      });
    }
    await tx.problemCluster.update({
      where: { id: cluster.id },
      data: {
        independentCompanyCount: independence.companies,
        independentSourceCount: independence.sources,
        totalScore: result.total,
        scoreCoverage: result.coverage,
        weightsVersion: config.version,
        scoredAt: now,
      },
    });
  }
  return clusters.length;
}

/**
 * Counts independent businesses: a known company, otherwise the source's
 * registrable domain (so several pages of one site count once). The same
 * excerpt quoted on several sites counts only for the first.
 */
export function independenceOf(
  evidence: readonly { excerptHash: string; source: { id: string; registrableDomain: string; companyId: string | null } }[],
): { companies: number; sources: number } {
  const companies = new Set<string>();
  const sources = new Set<string>();
  const seenExcerpts = new Set<string>();
  for (const e of evidence) {
    sources.add(e.source.id);
    if (seenExcerpts.has(e.excerptHash)) continue;
    seenExcerpts.add(e.excerptHash);
    companies.add(e.source.companyId ? `company:${e.source.companyId}` : `domain:${e.source.registrableDomain}`);
  }
  return { companies: companies.size, sources: sources.size };
}
