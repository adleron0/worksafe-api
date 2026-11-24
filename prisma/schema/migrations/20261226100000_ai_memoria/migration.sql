-- Resumo rolante da conversa
ALTER TABLE "Ai_Conversation" ADD COLUMN "summary" TEXT;
ALTER TABLE "Ai_Conversation" ADD COLUMN "summaryUntilId" INTEGER;
ALTER TABLE "Ai_Conversation" ADD COLUMN "summaryAt" TIMESTAMP(3);

-- Memória de longo prazo (fatos curtos)
CREATE TABLE "Ai_Memory" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "botId" INTEGER NOT NULL,
    "scope" VARCHAR(10) NOT NULL,
    "userId" INTEGER,
    "text" VARCHAR(300) NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "conversationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ai_Memory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Ai_Memory_companyId_botId_scope_userId_idx" ON "Ai_Memory"("companyId", "botId", "scope", "userId");
CREATE INDEX "Ai_Memory_lastUsedAt_idx" ON "Ai_Memory"("lastUsedAt");
ALTER TABLE "Ai_Memory" ADD CONSTRAINT "Ai_Memory_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Ai_Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Permissão: ver, editar e limpar a memória da empresa dos bots (só no perfil super)
INSERT INTO "Permission" ("name", "description", "group")
SELECT 'memoria_bots', 'Ver, ensinar, editar e limpar a memória da empresa dos bots', 'bots'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "name" = 'memoria_bots');
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", perm."id" FROM "Profile" p, "Permission" perm
WHERE p."name" = 'super' AND perm."name" = 'memoria_bots'
AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" pp WHERE pp."profileId" = p."id" AND pp."permissionId" = perm."id");

-- Ferramentas da memória em todos os bots que já existem
UPDATE "Ai_Bot"
SET "tools" = "tools" || '["lembrar", "esquecer"]'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE NOT ("tools" @> '["lembrar"]'::jsonb);
