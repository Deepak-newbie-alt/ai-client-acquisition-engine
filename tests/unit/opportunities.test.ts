import { describe, expect, it } from "vitest";
import { parseScoringConfig } from "../../src/config/scoring.js";
import { scoreOpportunity, type ScoringEvidence, type ScoringInput } from "../../src/modules/opportunities/scoring.js";
import { independenceOf } from "../../src/modules/opportunities/service.js";
import { bestMatch, contentTokens, problemSimilarity } from "../../src/modules/opportunities/similarity.js";

const config = parseScoringConfig({
  version: "test-1",
  weights: {
    FREQUENCY: 0.2,
    BUSINESS_IMPACT: 0.2,
    EVIDENCE_QUALITY: 0.2,
    RECURRENCE: 0.2,
    BUYER_ACCESSIBILITY: 0.1,
    DIFFERENTIATION: 0.1,
  },
});

const ev = (id: string, excerpt: string, overrides: Partial<ScoringEvidence> = {}): ScoringEvidence => ({
  id,
  excerpt,
  impactNote: null,
  kind: "OBSERVED",
  confidence: 0.8,
  ...overrides,
});

const input = (overrides: Partial<ScoringInput> = {}): ScoringInput => ({
  evidence: [ev("e1", "We fix the schedule by hand.")],
  independentCompanies: 1,
  linkedCompanies: 0,
  reachableCompanies: 0,
  alternatives: [],
  ...overrides,
});

const component = (result: ReturnType<typeof scoreOpportunity>, name: string) =>
  result.components.find((c) => c.component === name)!;

describe("problem similarity", () => {
  it("stems words and treats re-scheduling as scheduling", () => {
    expect(contentTokens("Rescheduling jobs; scheduled visits")).toEqual(new Set(["schedul", "job", "visit"]));
  });

  it("matches identical workflow labels regardless of wording order", () => {
    expect(problemSimilarity({ problemSummary: "a", workflow: "Job scheduling" }, { problemSummary: "b", workflow: "scheduling jobs" })).toBe(1);
  });

  it("scores unrelated problems low", () => {
    expect(
      problemSimilarity(
        { problemSummary: "Paper job sheets re-typed into invoicing", workflow: null },
        { problemSummary: "Customers rescheduling appointments by phone", workflow: null },
      ),
    ).toBeLessThan(0.3);
  });

  it("picks the most similar cluster deterministically, or none", () => {
    const members = [
      { key: "invoicing", text: { problemSummary: "Invoices typed manually from paper job sheets", workflow: "invoicing" } },
      { key: "scheduling", text: { problemSummary: "Dispatcher rebuilds the schedule in a spreadsheet", workflow: "job scheduling" } },
    ];
    expect(bestMatch({ problemSummary: "Rescheduling jobs takes the office all morning", workflow: "job scheduling" }, members)).toBe("scheduling");
    expect(bestMatch({ problemSummary: "Payroll overtime calculations", workflow: "payroll" }, members)).toBeNull();
  });
});

describe("independenceOf", () => {
  const src = (id: string, registrableDomain: string, companyId: string | null = null) => ({ id, registrableDomain, companyId });

  it("counts pages of one domain or company once, and repeated quotes once", () => {
    expect(
      independenceOf([
        { excerptHash: "a", source: src("s1", "example.com") },
        { excerptHash: "b", source: src("s2", "example.com") }, // same business, other page
        { excerptHash: "c", source: src("s3", "example.net") },
        { excerptHash: "c", source: src("s4", "example.org") }, // same quote republished
        { excerptHash: "d", source: src("s5", "shop.example.co.uk", "company-1") },
        { excerptHash: "e", source: src("s6", "example.co.uk", "company-1") }, // same company, other domain
      ]),
    ).toEqual({ companies: 3, sources: 6 });
  });
});

describe("scoreOpportunity", () => {
  it("leaves components unknown without supporting evidence, and reports coverage", () => {
    const result = scoreOpportunity(input(), config);
    expect(component(result, "FREQUENCY").value).toBeNull();
    expect(component(result, "BUSINESS_IMPACT")).toMatchObject({ value: null, rationale: expect.stringContaining("unknown") });
    expect(component(result, "BUYER_ACCESSIBILITY").value).toBeNull();
    expect(component(result, "DIFFERENTIATION").value).toBeNull();
    // Only evidence quality (0.2) and recurrence (0.2) are known.
    expect(result.coverage).toBe(0.4);
    expect(result.total).toBe(Math.round((0.2 * 4.5 + 0.2 * 1) * 100) / 100);
  });

  it("scores frequency from wording in the excerpts", () => {
    const result = scoreOpportunity(
      input({
        evidence: [
          ev("d", "Every morning our dispatcher rebuilds the schedule."),
          ev("w", "Chasing job sheets takes most of every Friday afternoon."),
          ev("n", "Scheduling is painful."),
        ],
      }),
      config,
    );
    expect(component(result, "FREQUENCY")).toMatchObject({ value: 4.5, evidenceIds: ["d", "w"] });
    expect(component(result, "FREQUENCY").rationale).toContain("2 of 3 excerpts");
  });

  it("scores impact only from stated impact, never inventing money", () => {
    const result = scoreOpportunity(
      input({
        evidence: [
          ev("t", "Two hours every morning.", { impactNote: "About two hours of dispatcher time each morning." }),
          ev("m", "We lost $400 on missed jobs.", { impactNote: "Lost $400 on missed jobs." }),
          ev("x", "It is annoying."),
        ],
      }),
      config,
    );
    expect(component(result, "BUSINESS_IMPACT")).toMatchObject({ value: 4.5, evidenceIds: ["t", "m"] });
  });

  it("computes evidence quality from directness and confidence", () => {
    const result = scoreOpportunity(
      input({ evidence: [ev("a", "x", { kind: "OBSERVED", confidence: 1 }), ev("b", "y", { kind: "INFERRED", confidence: 0.5 })] }),
      config,
    );
    // directness (1 + 0.5) / 2 = 0.75, confidence 0.75 -> 5 x 0.75
    expect(component(result, "EVIDENCE_QUALITY").value).toBe(3.8);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 4],
    [6, 5],
    [20, 5],
  ])("maps %i independent businesses to recurrence %i", (n, expected) => {
    expect(component(scoreOpportunity(input({ independentCompanies: n }), config), "RECURRENCE").value).toBe(expected);
  });

  it("scores buyer accessibility from reachable linked companies", () => {
    expect(component(scoreOpportunity(input({ linkedCompanies: 4, reachableCompanies: 1 }), config), "BUYER_ACCESSIBILITY").value).toBe(1.3);
  });

  it("scores differentiation from reviewed alternatives first, then from evidence", () => {
    const reviewed = scoreOpportunity(
      input({
        alternatives: [
          { name: "BigFleet Pro", fit: "poor" },
          { name: "SimpleBook", fit: "partial" },
        ],
      }),
      config,
    );
    expect(component(reviewed, "DIFFERENTIATION")).toMatchObject({ value: 3, rationale: expect.stringContaining("SimpleBook") });

    const fromEvidence = scoreOpportunity(
      input({ evidence: [ev("s", "We tried two field service apps but they needed weeks of setup.")] }),
      config,
    );
    expect(component(fromEvidence, "DIFFERENTIATION")).toMatchObject({ value: 4, evidenceIds: ["s"] });
  });

  it("refuses to score an empty cluster", () => {
    expect(() => scoreOpportunity(input({ evidence: [] }), config)).toThrow();
  });
});
