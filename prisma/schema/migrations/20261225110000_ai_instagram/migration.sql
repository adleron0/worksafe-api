-- Instagram: conta conectada por empresa e posts agendados
CREATE TABLE "Ai_Connector" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "accountId" VARCHAR(60) NOT NULL,
    "username" VARCHAR(120),
    "name" VARCHAR(200),
    "pictureUrl" TEXT,
    "accountType" VARCHAR(40),
    "tokenEncrypted" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(20) NOT NULL DEFAULT 'connected',
    "lastError" TEXT,
    "connectedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ai_Connector_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Ai_Connector_companyId_provider_key" ON "Ai_Connector"("companyId", "provider");

CREATE TABLE "Ai_SocialPost" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "provider" VARCHAR(30) NOT NULL DEFAULT 'instagram',
    "kind" VARCHAR(20) NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "media" JSONB NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    "containerId" VARCHAR(60),
    "externalId" VARCHAR(60),
    "permalink" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "botId" INTEGER,
    "createdByUserId" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ai_SocialPost_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Ai_SocialPost_status_scheduledAt_idx" ON "Ai_SocialPost"("status", "scheduledAt");
CREATE INDEX "Ai_SocialPost_companyId_scheduledAt_idx" ON "Ai_SocialPost"("companyId", "scheduledAt");

-- Permissões: conectar contas e publicar no Instagram
INSERT INTO "Permission" ("name", "description", "group")
SELECT 'conectores_bots', 'Conectar contas externas (Instagram) aos bots', 'bots'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "name" = 'conectores_bots');
INSERT INTO "Permission" ("name", "description", "group")
SELECT 'instagram_bots', 'Criar e agendar posts e stories no Instagram', 'bots'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "name" = 'instagram_bots');

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", perm."id" FROM "Profile" p, "Permission" perm
WHERE p."name" = 'super' AND perm."name" IN ('conectores_bots', 'instagram_bots')
  AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" pp WHERE pp."profileId" = p."id" AND pp."permissionId" = perm."id");

-- A Nina ganha as ferramentas do Instagram
UPDATE "Ai_Bot" SET "tools" = "tools" || '["instagram_conta","instagram_posts","instagram_agendar_post","instagram_cancelar_post"]'::jsonb
WHERE "key" = 'marketing' AND NOT ("tools" @> '["instagram_agendar_post"]'::jsonb);
