-- Bots nas páginas: onde cada bot aparece (rostinhos no topo + janela rápida)
ALTER TABLE "Ai_Bot" ADD COLUMN "pages" JSONB;

-- padrões por área para os bots que já existem
UPDATE "Ai_Bot" SET "pages" = '["home"]'::jsonb WHERE "key" = 'gestao';
UPDATE "Ai_Bot" SET "pages" = '["comercial","clientes"]'::jsonb WHERE "key" = 'comercial';
UPDATE "Ai_Bot" SET "pages" = '["servicos"]'::jsonb WHERE "key" = 'operacao';
UPDATE "Ai_Bot" SET "pages" = '["rh"]'::jsonb WHERE "key" = 'rh';
UPDATE "Ai_Bot" SET "pages" = '["estoque","compras","equipamentos","locacoes"]'::jsonb WHERE "key" = 'suprimentos';
UPDATE "Ai_Bot" SET "pages" = '["treinamentos"]'::jsonb WHERE "key" = 'treinamentos';
UPDATE "Ai_Bot" SET "pages" = '["blog","site","divulgacao"]'::jsonb WHERE "key" = 'marketing';
UPDATE "Ai_Bot" SET "pages" = '["financeiro"]'::jsonb WHERE "key" = 'financeiro';
UPDATE "Ai_Bot" SET "pages" = '[]'::jsonb WHERE "pages" IS NULL;
