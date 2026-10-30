export type Role = "ADMIN" | "REVIEWER";
export type RunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type EvidenceKind = "OBSERVED" | "INFERRED" | "UNKNOWN";
export type Component =
  | "FREQUENCY"
  | "BUSINESS_IMPACT"
  | "EVIDENCE_QUALITY"
  | "RECURRENCE"
  | "BUYER_ACCESSIBILITY"
  | "DIFFERENTIATION";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface RunStats {
  searchHits: number;
  rejectedUrls: Record<string, number>;
  duplicateUrls: number;
  selected: number;
  reusedSources: number;
  fetched: number;
  skipped: Record<string, number>;
  failed: Record<string, number>;
  evidenceAccepted: number;
  evidenceRejected: Record<string, number>;
  extractionErrors: number;
  extractionErrorCodes?: Record<string, number>;
}

export interface ResearchRun {
  id: string;
  query: string;
  industry: string;
  country: string;
  companySize: string | null;
  keywords: string[];
  resultLimit: number;
  status: RunStatus;
  errorCode: string | null;
  errorMessage: string | null;
  searchCalls: number;
  llmCalls: number;
  costMicros: string;
  stats: RunStats | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  _count?: { sources: number; evidence: number };
}

export interface RunSource {
  id: string;
  canonicalUrl: string;
  domain: string;
  registrableDomain: string;
  title: string | null;
  retrievalStatus: "PENDING" | "FETCHED" | "SKIPPED" | "FAILED";
  skipReason: string | null;
  httpStatus: number | null;
  searchRank: number | null;
  _count: { evidence: number };
}

export interface Evidence {
  id: string;
  excerpt: string;
  problemSummary: string;
  workflow: string | null;
  kind: EvidenceKind;
  confidence: number;
  impactNote: string | null;
  validationStatus: "PENDING" | "VALID" | "REJECTED";
  validationNote: string | null;
  llmModel: string | null;
  extractedAt: string;
  source: { id: string; canonicalUrl: string; title: string | null; registrableDomain: string };
}

export interface Score {
  component: Component;
  value: number | null;
  weight: number;
  rationale: string;
  weightsVersion: string;
  evidenceIds?: string[];
}

export interface Alternative {
  name: string;
  note?: string;
  fit: "good" | "partial" | "poor";
}

export interface Opportunity {
  id: string;
  title: string;
  description: string;
  segment: string;
  buyer: string;
  alternatives: Alternative[];
  validationQuestions: string[];
  independentCompanyCount: number;
  independentSourceCount: number;
  totalScore: number | null;
  scoreCoverage: number | null;
  weightsVersion: string | null;
  scoredAt: string | null;
  scores?: Score[];
  _count?: { evidence: number };
}

export interface Company {
  id: string;
  name: string;
  website: string | null;
  domain: string;
  researchStatus: "DISCOVERED" | "RESEARCHING" | "RESEARCHED" | "EXCLUDED";
  profile: { summary?: string; notes?: string } | null;
  createdAt: string;
  _count?: { contacts: number; sources: number };
}

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  sourceUrl: string;
  verificationStatus: "UNVERIFIED" | "VERIFIED" | "INVALID";
  retrievedAt: string;
  suppressed: boolean;
}

export interface Suppression {
  id: string;
  scope: "EMAIL" | "DOMAIN";
  value: string;
  reason: string;
  source: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorType: "USER" | "SERVICE" | "SYSTEM";
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, string | number | boolean | null> | null;
  createdAt: string;
}

export const COMPONENT_LABELS: Record<Component, string> = {
  FREQUENCY: "Frequency",
  BUSINESS_IMPACT: "Impact",
  EVIDENCE_QUALITY: "Evidence",
  RECURRENCE: "Recurrence",
  BUYER_ACCESSIBILITY: "Buyer access",
  DIFFERENTIATION: "Differentiation",
};

export const COMPONENT_ORDER = Object.keys(COMPONENT_LABELS) as Component[];

export interface Usage {
  monthStart: string;
  spentMicros: string;
  monthlyBudgetMicros: string;
  runBudgetMicros: string;
  byKind: { kind: "SEARCH" | "LLM"; costMicros: string }[];
}
