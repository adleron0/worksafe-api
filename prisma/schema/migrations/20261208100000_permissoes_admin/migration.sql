-- Permissões: base de cálculo com permissão própria e o perfil admin como gerente.

-- 1. Base de cálculo e perfis de impostos mudam o preço de toda proposta. Até
--    hoje bastava editar o Comercial; agora é uma permissão à parte, só do super.
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('update_base_calculo', 'Criar e editar a base de cálculo e os perfis de impostos (muda o preço das propostas)', 'comercial')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" = 'update_base_calculo'
WHERE p."name" = 'super'
ON CONFLICT ("profileId", "permissionId") DO UPDATE SET "inactiveAt" = NULL;

-- 2. O perfil admin passa a ter quase tudo. Ficam só com o super: os bots e o
--    MCP, as integrações (chaves de gateway), a edição dos dados da empresa e a
--    base de cálculo. Nada é retirado do que o admin já tinha.
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
CROSS JOIN "Permission" pm
WHERE p."name" = 'admin'
  AND pm."group" NOT IN ('bots', 'integracoes')
  AND pm."name" NOT IN ('create_company', 'update_company', 'inactive_company', 'activate_company', 'update_base_calculo')
ON CONFLICT ("profileId", "permissionId") DO UPDATE SET "inactiveAt" = NULL;
