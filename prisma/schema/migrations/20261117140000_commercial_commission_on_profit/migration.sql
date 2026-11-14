-- Comissão padrão das propostas passa a ser sobre o lucro (pedido do dono em 13/11/2026).
-- Muda só o padrão guardado na base de cálculo; as propostas já criadas mantêm o que têm.
UPDATE "Commercial_CostBase"
SET "defaults" = jsonb_set("defaults", '{commission,base}', '"lucro"')
WHERE "defaults"->'commission'->>'base' = 'faturado';
