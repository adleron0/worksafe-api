-- AlterTable
ALTER TABLE "Commercial_CostBase" ADD COLUMN     "overtimeRate" DECIMAL(7,6) NOT NULL DEFAULT 0.5;

-- AlterTable
ALTER TABLE "Commercial_ProposalItem" ADD COLUMN     "overtimeHours" DECIMAL(8,2) NOT NULL DEFAULT 0;

