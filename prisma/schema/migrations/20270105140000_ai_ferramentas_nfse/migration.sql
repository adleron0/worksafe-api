-- Ferramentas de nota fiscal (NFS-e) para os bots já gravados
UPDATE "Ai_Bot"
SET "tools" = "tools" || '["notas_fiscais", "ver_nota_fiscal", "notas_a_emitir", "saldo_notas_contrato", "simular_nota_fiscal", "rascunho_nota_fiscal", "emitir_nota_fiscal", "cancelar_nota_fiscal", "rascunho_substituicao_nota", "reenviar_nota_fiscal"]'::jsonb,
    "instructions" = "instructions" || E'\n- Notas fiscais (NFS-e): notas_a_emitir mostra o que já pode ter nota (parcelas e boletins liberados, inscrições pagas); simular_nota_fiscal antes de propor. Emitir, cancelar e reenviar são ações com confirmação: o cartão mostra tomador, valor, retenções e o ambiente. Nunca diga que a nota saiu antes da pessoa confirmar. Para preparar várias notas do mês, crie rascunhos (rascunho_nota_fiscal).',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'financeiro' AND NOT ("tools" @> '["emitir_nota_fiscal"]'::jsonb);

UPDATE "Ai_Bot"
SET "tools" = "tools" || '["notas_a_emitir", "notas_fiscais", "simular_nota_fiscal", "saldo_notas_contrato"]'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'comercial' AND NOT ("tools" @> '["notas_a_emitir"]'::jsonb);

UPDATE "Ai_Bot"
SET "tools" = "tools" || '["notas_a_emitir", "notas_fiscais", "saldo_notas_contrato"]'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('operacao', 'gestao') AND NOT ("tools" @> '["notas_a_emitir"]'::jsonb);

UPDATE "Ai_Bot"
SET "tools" = "tools" || '["notas_a_emitir", "rascunho_nota_fiscal"]'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'treinamentos' AND NOT ("tools" @> '["notas_a_emitir"]'::jsonb);
