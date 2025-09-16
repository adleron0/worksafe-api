-- AlterTable
ALTER TABLE "public"."FinancialRecords" ADD COLUMN     "commissionPercentage" DECIMAL(5,2),
ADD COLUMN     "discount" DECIMAL(18,2),
ADD COLUMN     "originalValue" DECIMAL(18,2);
