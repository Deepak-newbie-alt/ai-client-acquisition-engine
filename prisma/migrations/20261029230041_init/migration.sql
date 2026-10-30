-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'REVIEWER');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SERVICE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ResearchRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('WEB_PAGE', 'ARTICLE', 'FORUM', 'REVIEW', 'JOB_POSTING', 'OTHER');

-- CreateEnum
CREATE TYPE "RetrievalStatus" AS ENUM ('PENDING', 'FETCHED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('OBSERVED', 'INFERRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ValidationStatus" AS ENUM ('PENDING', 'VALID', 'REJECTED');

-- CreateEnum
CREATE TYPE "ScoreComponent" AS ENUM ('FREQUENCY', 'BUSINESS_IMPACT', 'EVIDENCE_QUALITY', 'RECURRENCE', 'BUYER_ACCESSIBILITY', 'DIFFERENTIATION');

-- CreateEnum
CREATE TYPE "CompanyResearchStatus" AS ENUM ('DISCOVERED', 'RESEARCHING', 'RESEARCHED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "ContactVerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'INVALID');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('DRAFT', 'APPROVED', 'SENDING', 'SENT', 'REJECTED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "SendOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SuppressionScope" AS ENUM ('EMAIL', 'DOMAIN');

-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('SEARCH', 'LLM');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'REVIEWER',
    "disabledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceToken" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ServiceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchRun" (
    "id" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "companySize" TEXT,
    "keywords" TEXT[],
    "resultLimit" INTEGER NOT NULL,
    "status" "ResearchRunStatus" NOT NULL DEFAULT 'QUEUED',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "requestedByType" "ActorType" NOT NULL,
    "requestedById" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "searchCalls" INTEGER NOT NULL DEFAULT 0,
    "llmCalls" INTEGER NOT NULL DEFAULT 0,
    "llmInputTokens" INTEGER NOT NULL DEFAULT 0,
    "llmOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" UUID NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "registrableDomain" TEXT NOT NULL,
    "title" TEXT,
    "sourceType" "SourceType" NOT NULL DEFAULT 'WEB_PAGE',
    "retrievalStatus" "RetrievalStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "httpStatus" INTEGER,
    "contentType" TEXT,
    "retrievedAt" TIMESTAMPTZ(3),
    "contentHash" TEXT,
    "extractedText" TEXT,
    "companyId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunSource" (
    "runId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "searchRank" INTEGER,
    "searchScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunSource_pkey" PRIMARY KEY ("runId","sourceId")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "runId" UUID,
    "excerpt" TEXT NOT NULL,
    "excerptHash" TEXT NOT NULL,
    "problemSummary" TEXT NOT NULL,
    "workflow" TEXT,
    "kind" "EvidenceKind" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "impactNote" TEXT,
    "validationStatus" "ValidationStatus" NOT NULL DEFAULT 'PENDING',
    "validationNote" TEXT,
    "llmModel" TEXT,
    "promptVersion" TEXT,
    "extractedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProblemCluster" (
    "id" UUID NOT NULL,
    "normalizedKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "buyer" TEXT NOT NULL,
    "alternatives" JSONB NOT NULL DEFAULT '[]',
    "validationQuestions" JSONB NOT NULL DEFAULT '[]',
    "independentCompanyCount" INTEGER NOT NULL DEFAULT 0,
    "independentSourceCount" INTEGER NOT NULL DEFAULT 0,
    "totalScore" DOUBLE PRECISION,
    "weightsVersion" TEXT,
    "scoredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProblemCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterEvidence" (
    "clusterId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClusterEvidence_pkey" PRIMARY KEY ("clusterId","evidenceId")
);

-- CreateTable
CREATE TABLE "ClusterScore" (
    "id" UUID NOT NULL,
    "clusterId" UUID NOT NULL,
    "component" "ScoreComponent" NOT NULL,
    "value" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,
    "weightsVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClusterScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreEvidence" (
    "scoreId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,

    CONSTRAINT "ScoreEvidence_pkey" PRIMARY KEY ("scoreId","evidenceId")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "domain" TEXT NOT NULL,
    "profile" JSONB,
    "researchStatus" "CompanyResearchStatus" NOT NULL DEFAULT 'DISCOVERED',
    "provenanceSourceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT,
    "role" TEXT,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "verificationStatus" "ContactVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "retrievedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachDraft" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'DRAFT',
    "createdByType" "ActorType" NOT NULL,
    "createdById" UUID,
    "generatedByModel" TEXT,
    "followUpOfId" UUID,
    "rfcMessageId" TEXT,
    "providerMessageId" TEXT,
    "providerThreadId" TEXT,
    "providerResult" JSONB,
    "sendOutcome" "SendOutcome",
    "sendAttemptedAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "repliedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OutreachDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "draftId" UUID NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "approvedById" UUID NOT NULL,
    "approvedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "invalidatedAt" TIMESTAMPTZ(3),
    "invalidationReason" TEXT,
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionRecord" (
    "id" UUID NOT NULL,
    "scope" "SuppressionScope" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" UUID NOT NULL,
    "runId" UUID,
    "kind" "UsageKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costMicros" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceToken_name_key" ON "ServiceToken"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceToken_tokenHash_key" ON "ServiceToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ResearchRun_status_createdAt_idx" ON "ResearchRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_canonicalUrl_key" ON "SourceDocument"("canonicalUrl");

-- CreateIndex
CREATE INDEX "SourceDocument_registrableDomain_idx" ON "SourceDocument"("registrableDomain");

-- CreateIndex
CREATE INDEX "SourceDocument_contentHash_idx" ON "SourceDocument"("contentHash");

-- CreateIndex
CREATE INDEX "SourceDocument_companyId_idx" ON "SourceDocument"("companyId");

-- CreateIndex
CREATE INDEX "RunSource_sourceId_idx" ON "RunSource"("sourceId");

-- CreateIndex
CREATE INDEX "Evidence_validationStatus_idx" ON "Evidence"("validationStatus");

-- CreateIndex
CREATE INDEX "Evidence_runId_idx" ON "Evidence"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_sourceId_excerptHash_key" ON "Evidence"("sourceId", "excerptHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProblemCluster_normalizedKey_key" ON "ProblemCluster"("normalizedKey");

-- CreateIndex
CREATE INDEX "ProblemCluster_totalScore_idx" ON "ProblemCluster"("totalScore");

-- CreateIndex
CREATE INDEX "ClusterEvidence_evidenceId_idx" ON "ClusterEvidence"("evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ClusterScore_clusterId_component_key" ON "ClusterScore"("clusterId", "component");

-- CreateIndex
CREATE INDEX "ScoreEvidence_evidenceId_idx" ON "ScoreEvidence"("evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "Company_domain_key" ON "Company"("domain");

-- CreateIndex
CREATE INDEX "Contact_emailNormalized_idx" ON "Contact"("emailNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_companyId_emailNormalized_key" ON "Contact"("companyId", "emailNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachDraft_rfcMessageId_key" ON "OutreachDraft"("rfcMessageId");

-- CreateIndex
CREATE INDEX "OutreachDraft_status_idx" ON "OutreachDraft"("status");

-- CreateIndex
CREATE INDEX "OutreachDraft_contactId_idx" ON "OutreachDraft"("contactId");

-- CreateIndex
CREATE INDEX "OutreachDraft_companyId_idx" ON "OutreachDraft"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachDraft_one_active_per_contact" ON "OutreachDraft"("contactId") WHERE (status IN ('DRAFT', 'APPROVED', 'SENDING'));

-- CreateIndex
CREATE INDEX "Approval_draftId_idx" ON "Approval"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_one_live_per_draft" ON "Approval"("draftId") WHERE ("invalidatedAt" IS NULL AND "consumedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionRecord_scope_value_key" ON "SuppressionRecord"("scope", "value");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEvent_actorType_actorId_idx" ON "AuditEvent"("actorType", "actorId");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_createdAt_idx" ON "UsageEvent"("createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_runId_idx" ON "UsageEvent"("runId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunSource" ADD CONSTRAINT "RunSource_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunSource" ADD CONSTRAINT "RunSource_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterEvidence" ADD CONSTRAINT "ClusterEvidence_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "ProblemCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterEvidence" ADD CONSTRAINT "ClusterEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterScore" ADD CONSTRAINT "ClusterScore_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "ProblemCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreEvidence" ADD CONSTRAINT "ScoreEvidence_scoreId_fkey" FOREIGN KEY ("scoreId") REFERENCES "ClusterScore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreEvidence" ADD CONSTRAINT "ScoreEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_provenanceSourceId_fkey" FOREIGN KEY ("provenanceSourceId") REFERENCES "SourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_followUpOfId_fkey" FOREIGN KEY ("followUpOfId") REFERENCES "OutreachDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "OutreachDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =====================================================================
-- Raw SQL constraints (not expressible in schema.prisma)
-- =====================================================================

-- Value ranges
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_confidence_range"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);
ALTER TABLE "ClusterScore" ADD CONSTRAINT "ClusterScore_value_range"
  CHECK ("value" IS NULL OR ("value" >= 0 AND "value" <= 5));
ALTER TABLE "ClusterScore" ADD CONSTRAINT "ClusterScore_weight_range"
  CHECK ("weight" >= 0 AND "weight" <= 1);
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_resultLimit_range"
  CHECK ("resultLimit" BETWEEN 1 AND 100);
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_usage_nonnegative"
  CHECK ("costMicros" >= 0 AND "searchCalls" >= 0 AND "llmCalls" >= 0
         AND "llmInputTokens" >= 0 AND "llmOutputTokens" >= 0);
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_cost_nonnegative"
  CHECK ("costMicros" >= 0);

-- Normalized identifiers must actually be normalized
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_emailNormalized_lowercase"
  CHECK ("emailNormalized" = lower(btrim("emailNormalized")));
ALTER TABLE "SuppressionRecord" ADD CONSTRAINT "SuppressionRecord_value_lowercase"
  CHECK ("value" = lower(btrim("value")) AND "value" <> '');

-- Send-state invariants: a send attempt always has a pre-generated Message-ID,
-- and SENT is only reachable with a recorded successful outcome.
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_attempt_recorded"
  CHECK ("status" NOT IN ('SENDING', 'SENT')
         OR ("rfcMessageId" IS NOT NULL AND "sendAttemptedAt" IS NOT NULL));
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_sent_has_success"
  CHECK ("status" <> 'SENT' OR ("sentAt" IS NOT NULL AND "sendOutcome" = 'SUCCESS'));

-- Audit log is append-only. (TRUNCATE is not blocked; it requires table
-- ownership and is used only by the test suite.)
CREATE FUNCTION audit_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
