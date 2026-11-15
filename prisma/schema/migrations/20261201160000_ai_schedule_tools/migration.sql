-- Agenda pela conversa: todos os bots que já existem ganham as ferramentas da agenda.
UPDATE "Ai_Bot"
SET "tools" = "tools" || '["agendar_tarefa", "minhas_tarefas", "pausar_tarefa"]'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE NOT ("tools" @> '["agendar_tarefa"]'::jsonb);
