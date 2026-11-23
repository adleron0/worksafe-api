-- Lia (Treinamentos) passa a cadastrar alunos e inscrevê-los nas turmas (inclusive já pagos)
UPDATE "Ai_Bot"
SET "tools" = "tools" || '["listar_inscritos", "buscar_aluno", "cadastrar_aluno", "inscrever_na_turma", "vincular_empresa_inscricao", "buscar_clientes"]'::jsonb,
    "description" = 'Turmas, vagas, alunos e inscrições. Inscreve alunos (inclusive os que já pagaram) e abre turmas novas.',
    "instructions" = "instructions" || E'\n- Inscrição feita fora do site (WhatsApp, telefone): procure antes o aluno com buscar_aluno (CPF). Depois use inscrever_na_turma com nome, CPF, e-mail e telefone; se já pagou, marque jaPago e pergunte a forma de pagamento (o valor padrão é o preço da turma). É ação com confirmação; para várias pessoas, uma chamada por pessoa.\n- Empresa contratante (sai no certificado): ache o cliente com buscar_clientes e passe clienteId.',
    "shortcuts" = COALESCE("shortcuts", '[]'::jsonb) || '[{"label": "Inscrever aluno", "prompt": "Quero inscrever um aluno que já pagou."}]'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'treinamentos' AND NOT ("tools" @> '["inscrever_na_turma"]'::jsonb);
