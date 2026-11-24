-- Ferramentas extras de Treinamentos (Lia) e de Obras (Bruno), com leituras para Comercial, Financeiro e Gestão

UPDATE "Ai_Bot"
SET "tools" = "tools" || '["certificados_vencendo", "listar_cursos", "instrutores_disponiveis", "lista_de_presenca", "vagas_empresas_turma", "registrar_presenca", "registrar_resultado_prova", "emitir_certificados", "reenviar_certificado", "cancelar_inscricao"]'::jsonb,
    "instructions" = "instructions" || E'\n- Presença (registrar_presenca) e resultado de prova feita fora do sistema (registrar_resultado_prova) são rascunhos diretos. Emitir certificados, reenviar por e-mail e cancelar inscrição são ações com confirmação: mostre quem fica de fora e por quê.\n- Reciclagem: certificados_vencendo mostra quem vence; avise o colega Comercial quando houver empresa com vários vencendo.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'treinamentos' AND NOT ("tools" @> '["certificados_vencendo"]'::jsonb);

UPDATE "Ai_Bot"
SET "tools" = "tools" || '["certificados_vencendo", "vagas_empresas_turma", "os_da_proposta", "avanco_da_obra", "informar_pedido_do_cliente"]'::jsonb,
    "instructions" = "instructions" || E'\n- Oportunidades de reciclagem: certificados_vencendo, agrupado por empresa. Depois do aceite, a OS nasce sozinha: veja em os_da_proposta e, quando o cliente mandar o pedido, informe com informar_pedido_do_cliente (confirmação) para liberar a mobilização.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'comercial' AND NOT ("tools" @> '["certificados_vencendo"]'::jsonb);

UPDATE "Ai_Bot"
SET "tools" = "tools" || '["os_da_proposta", "informar_pedido_do_cliente", "avanco_da_obra", "estatisticas_diario", "atualizar_os", "registrar_medicao"]'::jsonb,
    "instructions" = "instructions" || E'\n- A OS nasce sozinha no aceite da proposta, "A liberar" até chegar o pedido do cliente (informar_pedido_do_cliente, com confirmação). Datas, responsável e observações: atualizar_os.\n- Avanço da obra (avanco_da_obra) e estatísticas do diário (estatisticas_diario: clima, paradas, ocorrências, horas perdidas). Medição: registrar_medicao cria o boletim em rascunho; enviar e faturar são pela tela.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'operacao' AND NOT ("tools" @> '["os_da_proposta"]'::jsonb);

UPDATE "Ai_Bot"
SET "tools" = "tools" || '["a_faturar", "avanco_da_obra"]'::jsonb,
    "instructions" = "instructions" || E'\n- O que já pode ser faturado (parcelas por avanço da obra e medições): a_faturar.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'financeiro' AND NOT ("tools" @> '["a_faturar"]'::jsonb);

UPDATE "Ai_Bot"
SET "tools" = "tools" || '["certificados_vencendo", "avanco_da_obra", "a_faturar", "estatisticas_diario"]'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'gestao' AND NOT ("tools" @> '["certificados_vencendo"]'::jsonb);
