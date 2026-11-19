-- AlterTable
ALTER TABLE "Commercial_Proposal" ADD COLUMN     "measurement" JSONB;
-- AlterTable
ALTER TABLE "Commercial_Contract" ADD COLUMN     "measurementPlan" JSONB,
ADD COLUMN     "depositRecordId" INTEGER;
-- AlterTable
ALTER TABLE "Commercial_Measurement" ADD COLUMN     "depositValue" DECIMAL(14,2),
ADD COLUMN     "notes" VARCHAR(2000),
ADD COLUMN     "publicKey" VARCHAR(40),
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decision" JSONB;
-- CreateIndex
CREATE UNIQUE INDEX "Commercial_Measurement_publicKey_key" ON "Commercial_Measurement"("publicKey");
