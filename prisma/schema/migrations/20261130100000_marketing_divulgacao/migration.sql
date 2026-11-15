-- Divulgação de turmas: modelos de legenda e configurações por empresa.

CREATE TABLE "Marketing_CaptionTemplate" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" VARCHAR(30) NOT NULL DEFAULT 'outro',
    "body" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Marketing_CaptionTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Marketing_CaptionTemplate_companyId_active_idx" ON "Marketing_CaptionTemplate"("companyId", "active");

CREATE TABLE "Marketing_Setting" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Marketing_Setting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Marketing_Setting_companyId_key" ON "Marketing_Setting"("companyId");

-- Permissões: ver o menu, divulgar (gerar arte e legenda) e configurar (modelos e contatos).
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('view_divulgacao', 'Ver o menu Divulgação', 'treinamentos'),
  ('list_divulgacao', 'Gerar artes e legendas de divulgação das turmas', 'treinamentos'),
  ('update_divulgacao', 'Configurar modelos de legenda e dados da divulgação', 'treinamentos')
ON CONFLICT ("name") DO NOTHING;

-- Quem já edita turmas ganha as três (perfis e usuários); o perfil super também.
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT DISTINCT pp."profileId", n."id"
FROM "Permission" o
JOIN "ProfilePermission" pp ON pp."permissionId" = o."id" AND pp."inactiveAt" IS NULL
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "name" IN ('view_divulgacao', 'list_divulgacao', 'update_divulgacao')) n
WHERE o."name" = 'update_classes'
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

INSERT INTO "UserPermission" ("userId", "permissionId")
SELECT DISTINCT up."userId", n."id"
FROM "Permission" o
JOIN "UserPermission" up ON up."permissionId" = o."id" AND up."inactiveAt" IS NULL
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "name" IN ('view_divulgacao', 'list_divulgacao', 'update_divulgacao')) n
WHERE o."name" = 'update_classes'
ON CONFLICT ("userId", "permissionId") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", n."id"
FROM "Profile" p
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "name" IN ('view_divulgacao', 'list_divulgacao', 'update_divulgacao')) n
WHERE p."name" = 'super'
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
