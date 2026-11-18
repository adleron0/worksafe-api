-- Permissão: os bots pedem ajuda uns aos outros e passam a conversa (só no perfil super)
INSERT INTO "Permission" ("name", "description", "group")
SELECT 'equipe_bots', 'Bots perguntam aos colegas e passam a conversa para o colega da área', 'bots'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "name" = 'equipe_bots');
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", perm."id" FROM "Profile" p, "Permission" perm
WHERE p."name" = 'super' AND perm."name" = 'equipe_bots'
AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" pp WHERE pp."profileId" = p."id" AND pp."permissionId" = perm."id");

-- Ferramentas da equipe em todos os bots que já existem
UPDATE "Ai_Bot"
SET "tools" = "tools" || '["pedir_ao_colega", "passar_para_colega"]'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE NOT ("tools" @> '["pedir_ao_colega"]'::jsonb);

-- Helena passa a conversa em vez de só dizer qual bot faz
UPDATE "Ai_Bot"
SET "instructions" = replace("instructions", 'Se pedirem uma ação, diga qual bot faz (Comercial, Operação e RH, Treinamentos, Marketing, Financeiro).', 'Se pedirem uma ação, passe a conversa para o colega da área com passar_para_colega (Comercial, Operação e RH, Treinamentos, Marketing, Financeiro).'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'gestao';
