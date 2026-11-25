-- OS como documento: segurança na folha, cronograma replanejável, link do cliente e permissão de valores.
ALTER TABLE "Service_Order" ADD COLUMN "safety" TEXT;
ALTER TABLE "Service_Order" ADD COLUMN "baseline" JSONB;
ALTER TABLE "Service_Order" ADD COLUMN "publicKey" VARCHAR(64);
ALTER TABLE "Service_Order" ADD COLUMN "publicEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Service_Order" ADD COLUMN "publicOptions" JSONB;
CREATE UNIQUE INDEX "Service_Order_publicKey_key" ON "Service_Order"("publicKey");

-- view_valores_os: ver o valor de venda na OS e imprimir "com valores".
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('view_valores_os', 'Ver os valores da venda na ordem de serviço e imprimir com valores', 'servicos')
ON CONFLICT ("name") DO NOTHING;

-- quem já via custos e margem (que inclui a receita) passa a ver os valores; o super pode tudo
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT DISTINCT pp."profileId", n."id"
FROM "Permission" o
JOIN "Permission" n ON n."name" = 'view_valores_os'
JOIN "ProfilePermission" pp ON pp."permissionId" = o."id" AND pp."inactiveAt" IS NULL
WHERE o."name" = 'view_custos_comercial'
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

INSERT INTO "UserPermission" ("userId", "permissionId")
SELECT DISTINCT up."userId", n."id"
FROM "Permission" o
JOIN "Permission" n ON n."name" = 'view_valores_os'
JOIN "UserPermission" up ON up."permissionId" = o."id" AND up."inactiveAt" IS NULL
WHERE o."name" = 'view_custos_comercial'
ON CONFLICT ("userId", "permissionId") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", n."id" FROM "Profile" p CROSS JOIN (SELECT "id" FROM "Permission" WHERE "name" = 'view_valores_os') n
WHERE p."name" = 'super'
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
