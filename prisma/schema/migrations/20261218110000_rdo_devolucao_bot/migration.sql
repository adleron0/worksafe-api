-- RDO devolvido para quem preencheu corrigir: o motivo fica até fechar de novo
ALTER TABLE "Service_DailyReport" ADD COLUMN "returnNote" VARCHAR(500);
ALTER TABLE "Service_DailyReport" ADD COLUMN "returnedAt" TIMESTAMP(3);
ALTER TABLE "Service_DailyReport" ADD COLUMN "returnedByUserId" INTEGER;

-- Bruno (Operação e RH) passa a ler, conferir, devolver e cobrar o diário de obra
UPDATE "Ai_Bot"
SET "tools" = "tools" || '["listar_rdos", "ver_rdo", "rdos_pendentes", "resumo_diario_de_obra", "devolver_rdo", "cobrar_rdo"]'::jsonb,
    "description" = 'Ordens de serviço, diário de obra (RDO), escala da equipe e documentos dos funcionários.',
    "instructions" = "instructions" || E'\n- Diário de obra (RDO): para revisar, abra o RDO (ver_rdo) e use os pontosDeAtencao, sem inventar falhas. Andamento da obra: listar_rdos com o osId (avanço feito × planejado, horas × orçado).\n- Para devolver um RDO (devolver_rdo), o motivo diz exatamente o que corrigir. Para cobrar (cobrar_rdo), veja antes as pendências (rdos_pendentes). As duas são ações com confirmação.',
    "shortcuts" = '[{"label": "RDOs pendentes", "prompt": "Quais obras estão com RDO faltando, em rascunho ou devolvido?"}, {"label": "Revisar RDOs de ontem", "prompt": "Revise os RDOs de ontem e aponte o que precisa ser corrigido."}]'::jsonb || COALESCE("shortcuts", '[]'::jsonb),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'operacao' AND NOT ("tools" @> '["ver_rdo"]'::jsonb);
