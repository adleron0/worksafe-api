-- Dois bots novos (RH e Departamento Pessoal; Suprimentos) e o Bruno só com a operação.
-- Os bots nascem sozinhos (ensureDefaults); aqui ficam as permissões de conversar
-- com eles, dadas ao perfil super, e o ajuste do Bruno que já existe.
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('usar_bot_rh', 'Conversar com o Bot de RH e Departamento Pessoal (funcionários, documentos, férias e afastamentos)', 'bots'),
  ('usar_bot_suprimentos', 'Conversar com o Bot de Suprimentos (estoque, compras, EPI e equipamentos)', 'bots')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" IN ('usar_bot_rh', 'usar_bot_suprimentos')
WHERE p."name" = 'super' AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

UPDATE "Permission" SET "description" = 'Conversar com o Bot de Operação (OS, RDO e escala)' WHERE "name" = 'usar_bot_operacao';

-- Bruno: sai o que foi para RH e Suprimentos
UPDATE "Ai_Bot"
SET "tools" = (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM jsonb_array_elements("tools") t WHERE t #>> '{}' NOT IN ('listar_funcionarios', 'documentos_vencendo', 'listar_pedidos_de_compra')),
    "name" = 'Operação',
    "role" = 'Coordenador de Operação',
    "description" = 'Ordens de serviço, diário de obra (RDO) e escala da equipe nas obras.',
    "instructions" = replace("instructions", 'Você é o Bot de Operação e RH. Ajuda a planejar as obras, montar a escala e manter a documentação da equipe em dia.', E'Você é o Bot de Operação. Ajuda a planejar as obras, montar a escala e acompanhar o diário de obra.\n- Cadastro, documentos, férias e afastamentos dos funcionários são do colega de RH e Departamento Pessoal; estoque, compras, EPI e equipamentos são do colega de Suprimentos. Para isso, use pedir_ao_colega ou passar_para_colega.'),
    "shortcuts" = (SELECT COALESCE(jsonb_agg(s), '[]'::jsonb) FROM jsonb_array_elements(COALESCE("shortcuts", '[]'::jsonb)) s WHERE s->>'label' <> 'Documentos vencendo'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'operacao' AND "name" = 'Operação e RH';

-- Helena passa a conhecer os colegas novos
UPDATE "Ai_Bot"
SET "instructions" = replace("instructions", '(Comercial, Operação e RH, Treinamentos, Marketing, Financeiro)', '(Comercial, Operação, RH e Departamento Pessoal, Suprimentos, Treinamentos, Marketing, Financeiro)'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'gestao';
UPDATE "Ai_Bot"
SET "tools" = "tools" || '["itens_para_repor", "equipamentos_vencendo", "mapa_alocacao"]'::jsonb
WHERE "key" = 'gestao' AND NOT ("tools" @> '["itens_para_repor"]'::jsonb);
