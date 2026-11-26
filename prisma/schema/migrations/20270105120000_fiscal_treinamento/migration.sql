-- Área fiscal: nota da inscrição paga em turma aberta, com emissão automática opcional
ALTER TABLE "Fiscal_Settings" ADD COLUMN "autoEmitTraining" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Fiscal_Settings" ADD COLUMN "autoEmitTrainingSince" TIMESTAMP(3);
