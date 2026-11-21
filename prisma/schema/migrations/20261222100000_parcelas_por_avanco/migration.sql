-- Parcelas por avanço da obra (plano 12): vencimento por % da obra e caução nas parcelas
ALTER TYPE "CommercialDueRule" ADD VALUE IF NOT EXISTS 'percentual_obra';

ALTER TABLE "Commercial_ProposalInstallment" ADD COLUMN "workPercent" DECIMAL(7,4);
ALTER TABLE "Commercial_ContractInstallment" ADD COLUMN "workPercent" DECIMAL(7,4), ADD COLUMN "depositValue" DECIMAL(14,2);
ALTER TABLE "Commercial_Proposal" ADD COLUMN "depositRate" DECIMAL(7,6) NOT NULL DEFAULT 0, ADD COLUMN "depositReleaseDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Commercial_Contract" ADD COLUMN "depositRate" DECIMAL(7,6) NOT NULL DEFAULT 0, ADD COLUMN "depositReleaseDays" INTEGER NOT NULL DEFAULT 0;
