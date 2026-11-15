-- RH, fase 4: permissão do mapa de alocação (quem está em qual obra e quem está livre).
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('view_alocacao', 'Ver o mapa de alocação dos funcionários', 'rh')
ON CONFLICT ("name") DO NOTHING;

-- super, RH, Gestão e o gestor da Operação (é quem escala as equipes).
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" = 'view_alocacao'
WHERE p."name" IN ('super', 'RH', 'Gestão', 'Operação - gestor') AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
