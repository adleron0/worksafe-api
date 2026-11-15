-- Resultado da OS (orçado × realizado) congelado no encerramento
ALTER TABLE "Service_Order" ADD COLUMN "result" JSONB;
ALTER TABLE "Service_Order" ADD COLUMN "closedAt" TIMESTAMP(3);
