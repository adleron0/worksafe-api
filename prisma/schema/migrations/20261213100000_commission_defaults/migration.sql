-- Comissão do vendedor nas propostas: zero por padrão.
-- 1) Comissão própria por vendedor (nula = segue o padrão da base de cálculo).
ALTER TABLE "User"
  ADD COLUMN "commissionRate" DECIMAL(6,4),
  ADD COLUMN "commissionBase" VARCHAR(20);

-- 2) O padrão da base de cálculo passa a ter liga/desliga. As versões que já
--    existem nascem DESLIGADAS: proposta nova começa com comissão zero até a
--    diretoria ligar o padrão na tela de base de cálculo.
UPDATE "Commercial_CostBase"
SET "defaults" = jsonb_set("defaults"::jsonb, '{commission,enabled}', 'false'::jsonb, true)
WHERE jsonb_typeof("defaults"::jsonb -> 'commission') = 'object';
