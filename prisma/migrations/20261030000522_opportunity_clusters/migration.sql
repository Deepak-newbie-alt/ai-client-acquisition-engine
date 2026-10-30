-- DropIndex
DROP INDEX "ClusterEvidence_evidenceId_idx";

-- AlterTable
ALTER TABLE "ProblemCluster" ADD COLUMN     "scoreCoverage" DOUBLE PRECISION;

-- CreateIndex
CREATE UNIQUE INDEX "ClusterEvidence_evidenceId_key" ON "ClusterEvidence"("evidenceId");

