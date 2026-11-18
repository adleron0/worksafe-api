-- Chaves dos fornecedores de IA cadastradas pela tela (criptografadas)
CREATE TABLE "Ai_ProviderKey" (
    "id" SERIAL NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "keyEncrypted" TEXT NOT NULL,
    "hint" VARCHAR(12) NOT NULL,
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ai_ProviderKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Ai_ProviderKey_provider_key" ON "Ai_ProviderKey"("provider");

-- Permissão: cadastrar e trocar as chaves de IA (só no perfil super)
INSERT INTO "Permission" ("name", "description", "group")
SELECT 'chaves_ia_bots', 'Cadastrar e trocar as chaves dos fornecedores de IA dos bots', 'bots'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "name" = 'chaves_ia_bots');
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", perm."id" FROM "Profile" p, "Permission" perm
WHERE p."name" = 'super' AND perm."name" = 'chaves_ia_bots'
AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" pp WHERE pp."profileId" = p."id" AND pp."permissionId" = perm."id");
