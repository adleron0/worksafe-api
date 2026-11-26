-- Área fiscal: nota que nasce de uma parcela, medição de obra ou ordem de locação
ALTER TABLE "Fiscal_Invoice" ADD COLUMN "origin" JSONB;
ALTER TABLE "Fiscal_Invoice" ADD COLUMN "originBilledAt" TIMESTAMP(3);
