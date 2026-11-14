-- E-mails de tratativas das propostas da WorkSafe (pedido do dono em 13/11/2026):
-- comercial@ para serviços e treinamentos@ para treinamentos. Só grava onde ainda
-- não há valor; as outras empresas não são tocadas e podem definir os seus em
-- Comercial → Modelos → Identidade.
INSERT INTO "Commercial_Settings" ("companyId", "brand")
SELECT c."id", '{}'::jsonb FROM "Company" c
WHERE c."cnpj" = '33714458000161'
ON CONFLICT ("companyId") DO NOTHING;

UPDATE "Commercial_Settings" s
SET "brand" = jsonb_build_object('serviceEmail', 'comercial@worksafebrasil.com.br', 'trainingEmail', 'treinamentos@worksafebrasil.com.br') || s."brand",
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Company" c
WHERE c."id" = s."companyId" AND c."cnpj" = '33714458000161';
