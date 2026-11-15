-- Bots como funcionários: nome, cargo e rosto.
ALTER TABLE "Ai_Bot" ADD COLUMN "persona" VARCHAR(40), ADD COLUMN "role" VARCHAR(80), ADD COLUMN "avatar" VARCHAR(40);

UPDATE "Ai_Bot" SET "persona" = 'Helena', "role" = 'Diretora de Gestão', "avatar" = 'gestao' WHERE "key" = 'gestao' AND "persona" IS NULL;
UPDATE "Ai_Bot" SET "persona" = 'Rafael', "role" = 'Executivo Comercial', "avatar" = 'comercial' WHERE "key" = 'comercial' AND "persona" IS NULL;
UPDATE "Ai_Bot" SET "persona" = 'Bruno', "role" = 'Coordenador de Operação e RH', "avatar" = 'operacao' WHERE "key" = 'operacao' AND "persona" IS NULL;
UPDATE "Ai_Bot" SET "persona" = 'Lia', "role" = 'Coordenadora de Treinamentos', "avatar" = 'treinamentos' WHERE "key" = 'treinamentos' AND "persona" IS NULL;
UPDATE "Ai_Bot" SET "persona" = 'Nina', "role" = 'Analista de Marketing', "avatar" = 'marketing' WHERE "key" = 'marketing' AND "persona" IS NULL;
UPDATE "Ai_Bot" SET "persona" = 'Otávio', "role" = 'Analista Financeiro', "avatar" = 'financeiro' WHERE "key" = 'financeiro' AND "persona" IS NULL;
