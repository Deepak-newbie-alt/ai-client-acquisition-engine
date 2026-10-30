-- AlterTable
ALTER TABLE "OutreachDraft" ADD COLUMN     "opportunityId" UUID,
ADD COLUMN     "optedOutAt" TIMESTAMPTZ(3);

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "ProblemCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

