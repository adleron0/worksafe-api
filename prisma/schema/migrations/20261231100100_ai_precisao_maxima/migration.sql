-- Precisão máxima: a empresa manda usar sempre o modelo principal (ignora o econômico dos bots)
ALTER TABLE "Ai_Settings" ADD COLUMN "maxPrecision" BOOLEAN NOT NULL DEFAULT false;
