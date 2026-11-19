-- AlterTable
ALTER TABLE "Commercial_Contract" ADD COLUMN     "retentionRates" JSONB;
-- AlterTable
ALTER TABLE "Financial_Payable" ADD COLUMN     "taxKind" VARCHAR(10);
-- CreateTable
CREATE TABLE "Financial_Retention" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "financialRecordId" INTEGER NOT NULL,
    "customerId" INTEGER,
    "contractId" INTEGER,
    "measurementId" INTEGER,
    "tax" VARCHAR(10) NOT NULL,
    "rate" DECIMAL(7,4),
    "base" DECIMAL(18,2) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "accrualDate" VARCHAR(7) NOT NULL,
    "invoiceNumber" VARCHAR(60),
    "declaredAt" TIMESTAMP(3),
    "declaredByUserId" INTEGER,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Financial_Retention_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "Financial_Retention_companyId_accrualDate_idx" ON "Financial_Retention"("companyId", "accrualDate");
-- CreateIndex
CREATE INDEX "Financial_Retention_financialRecordId_idx" ON "Financial_Retention"("financialRecordId");
-- AddForeignKey
ALTER TABLE "Financial_Retention" ADD CONSTRAINT "Financial_Retention_financialRecordId_fkey" FOREIGN KEY ("financialRecordId") REFERENCES "FinancialRecords"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AlterTable
ALTER TABLE "Commercial_Measurement" ADD COLUMN     "invoiceValue" DECIMAL(14,2);
