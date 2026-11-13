-- Contas a receber de empresas: NF emitida fora do sistema, parcela e baixa manual.
-- Só acréscimo: nada do que o checkout grava muda.

-- Formas de recebimento que só existem na baixa manual (nunca no checkout).
ALTER TYPE "paymentMethods" ADD VALUE IF NOT EXISTS 'transferencia';
ALTER TYPE "paymentMethods" ADD VALUE IF NOT EXISTS 'dinheiro';
ALTER TYPE "paymentMethods" ADD VALUE IF NOT EXISTS 'outro';

ALTER TABLE "FinancialRecords"
  ADD COLUMN "invoiceNumber" VARCHAR(60),
  ADD COLUMN "invoiceIssuedAt" TIMESTAMP(3),
  ADD COLUMN "invoiceUrl" TEXT,
  ADD COLUMN "installmentNumber" INTEGER,
  ADD COLUMN "installmentTotal" INTEGER,
  ADD COLUMN "netValue" DECIMAL(18,2),
  ADD COLUMN "receivedValue" DECIMAL(18,2),
  ADD COLUMN "settledByUserId" INTEGER;

CREATE INDEX "FinancialRecords_customerId_idx" ON "FinancialRecords"("customerId");
CREATE INDEX "FinancialRecords_companyId_invoiceNumber_idx" ON "FinancialRecords"("companyId", "invoiceNumber");
