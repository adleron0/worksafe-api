-- Fase G: permissões próprias, "só as minhas" e perfis de fábrica.

-- 1. Permissões novas.
--    update_rdo: lançar RDO sem poder alterar a OS (encarregado).
--    update_acompanhamento: registrar contato e agendar retorno sem editar proposta.
--    all_*: quem tem vê tudo; quem não tem vê só o que é seu.
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('update_rdo', 'Lançar e fechar RDO', 'servicos'),
  ('all_ordens_de_servico', 'Ver todas as ordens de serviço (sem ela, só as suas)', 'servicos'),
  ('update_acompanhamento', 'Registrar contatos e agendar retornos', 'comercial'),
  ('all_propostas', 'Ver todas as propostas e vendas (sem ela, só as suas)', 'comercial')
ON CONFLICT ("name") DO NOTHING;

-- 2. Ninguém perde o que já fazia: cada permissão nova vai para quem tinha a
--    permissão que cobria aquilo até hoje (perfis e usuários).
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT DISTINCT pp."profileId", n."id"
FROM (VALUES
  ('update_rdo', 'update_ordens_de_servico'),
  ('all_ordens_de_servico', 'list_ordens_de_servico'),
  ('update_acompanhamento', 'update_comercial'),
  ('all_propostas', 'list_comercial')
) AS m("new", "old")
JOIN "Permission" o ON o."name" = m."old"
JOIN "Permission" n ON n."name" = m."new"
JOIN "ProfilePermission" pp ON pp."permissionId" = o."id" AND pp."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

INSERT INTO "UserPermission" ("userId", "permissionId")
SELECT DISTINCT up."userId", n."id"
FROM (VALUES
  ('update_rdo', 'update_ordens_de_servico'),
  ('all_ordens_de_servico', 'list_ordens_de_servico'),
  ('update_acompanhamento', 'update_comercial'),
  ('all_propostas', 'list_comercial')
) AS m("new", "old")
JOIN "Permission" o ON o."name" = m."old"
JOIN "Permission" n ON n."name" = m."new"
JOIN "UserPermission" up ON up."permissionId" = o."id" AND up."inactiveAt" IS NULL
ON CONFLICT ("userId", "permissionId") DO NOTHING;

-- o perfil super pode tudo
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", n."id"
FROM "Profile" p
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "name" IN ('update_rdo', 'all_ordens_de_servico', 'update_acompanhamento', 'all_propostas')) n
WHERE p."name" = 'super'
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

-- 3. Perfis de fábrica: ponto de partida, ajustável em Equipe → Perfis.
--    Só nascem se ainda não houver perfil com o mesmo nome; nenhum usuário é movido.
WITH home AS (
  SELECT COALESCE((SELECT MIN("companyId") FROM "Profile" WHERE "companyId" > 0), (SELECT MIN("id") FROM "Company")) AS "id"
),
created AS (
  INSERT INTO "Profile" ("name", "companyId")
  SELECT d."name", home."id"
  FROM (VALUES ('Comercial'), ('Operação - gestor'), ('Operação - campo'), ('Suprimentos'), ('Financeiro'), ('Gestão')) AS d("name"), home
  WHERE home."id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Profile" p WHERE p."name" = d."name")
  RETURNING "id", "name"
),
grants("profile", "permission") AS (VALUES
  -- Comercial: propostas, acompanhamento e clientes; a OS das suas vendas, só leitura
  ('Comercial', 'view_comercial'), ('Comercial', 'list_comercial'), ('Comercial', 'create_comercial'), ('Comercial', 'update_comercial'),
  ('Comercial', 'update_acompanhamento'), ('Comercial', 'all_propostas'),
  ('Comercial', 'view_clientes'), ('Comercial', 'list_clientes'), ('Comercial', 'create_clientes'), ('Comercial', 'update_clientes'),
  ('Comercial', 'view_ordens_de_servico'), ('Comercial', 'list_ordens_de_servico'),
  -- Operação - gestor: todas as OS, RDO e pedido de compra; sem preço nem margem
  ('Operação - gestor', 'view_ordens_de_servico'), ('Operação - gestor', 'list_ordens_de_servico'), ('Operação - gestor', 'update_ordens_de_servico'),
  ('Operação - gestor', 'all_ordens_de_servico'), ('Operação - gestor', 'update_rdo'),
  ('Operação - gestor', 'view_pedidos_de_compra'), ('Operação - gestor', 'list_pedidos_de_compra'), ('Operação - gestor', 'create_pedidos_de_compra'), ('Operação - gestor', 'update_pedidos_de_compra'),
  -- Operação - campo: só as OS em que está escalado; preenche RDO
  ('Operação - campo', 'view_ordens_de_servico'), ('Operação - campo', 'list_ordens_de_servico'), ('Operação - campo', 'update_rdo'),
  -- Suprimentos: pedidos de compra (aprovar fica com a Gestão)
  ('Suprimentos', 'view_pedidos_de_compra'), ('Suprimentos', 'list_pedidos_de_compra'), ('Suprimentos', 'create_pedidos_de_compra'), ('Suprimentos', 'update_pedidos_de_compra'),
  ('Suprimentos', 'inactive_pedidos_de_compra'), ('Suprimentos', 'activate_pedidos_de_compra'),
  -- Financeiro: a faturar, a receber, a pagar; vê vendas, OS e compras sem editar
  ('Financeiro', 'view_financeiro'), ('Financeiro', 'list_financeiro'), ('Financeiro', 'create_financeiro'), ('Financeiro', 'update_financeiro'),
  ('Financeiro', 'inactive_financeiro'), ('Financeiro', 'activate_financeiro'),
  ('Financeiro', 'view_clientes'), ('Financeiro', 'list_clientes'),
  ('Financeiro', 'view_comercial'), ('Financeiro', 'list_comercial'), ('Financeiro', 'all_propostas'),
  ('Financeiro', 'view_ordens_de_servico'), ('Financeiro', 'list_ordens_de_servico'), ('Financeiro', 'all_ordens_de_servico'),
  ('Financeiro', 'view_pedidos_de_compra'), ('Financeiro', 'list_pedidos_de_compra')
)
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT c."id", pm."id"
FROM created c
JOIN grants g ON g."profile" = c."name"
JOIN "Permission" pm ON pm."name" = g."permission"
UNION
-- Gestão: tudo de Comercial, Operação, Suprimentos, Financeiro e Clientes, com custos, aprovação e resultado
SELECT c."id", pm."id"
FROM created c
JOIN "Permission" pm ON pm."group" IN ('comercial', 'servicos', 'financeiro', 'clientes')
WHERE c."name" = 'Gestão'
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
