-- Permissões novas dos Bots (nascem só no perfil super; os outros perfis recebem pela tela de Perfis).
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('agendar_bots', 'Agendar tarefas para os bots (tela Agenda e pedindo na conversa)', 'bots'),
  ('view_pedidos_bots', 'Ver os pedidos e tarefas de todas as pessoas aos bots, com quem pediu', 'bots')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" IN ('agendar_bots', 'view_pedidos_bots')
WHERE p."name" = 'super' AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
