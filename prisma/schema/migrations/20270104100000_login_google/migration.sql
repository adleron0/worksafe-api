-- Login com Google: domínio da empresa, vínculo pelo `sub`, pedidos de perfil e convites externos
ALTER TABLE "Company" ADD COLUMN "google_domain" VARCHAR(255);
ALTER TABLE "Company" ADD COLUMN "google_login_enabled" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Company_google_domain_key" ON "Company"("google_domain");

ALTER TABLE "User" ADD COLUMN "googleSub" VARCHAR(64);
ALTER TABLE "User" ADD COLUMN "externalUntil" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

CREATE TABLE "AccessRequest" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "message" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "profileId" INTEGER,
    "decidedById" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "reason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccessRequest_companyId_status_idx" ON "AccessRequest"("companyId", "status");
CREATE INDEX "AccessRequest_userId_idx" ON "AccessRequest"("userId");
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ExternalInvite" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "profileId" INTEGER NOT NULL,
    "reason" VARCHAR(500),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedById" INTEGER NOT NULL,
    "googleSub" VARCHAR(64),
    "userId" INTEGER,
    "firstLoginAt" TIMESTAMP(3),
    "warnedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExternalInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExternalInvite_userId_key" ON "ExternalInvite"("userId");
CREATE UNIQUE INDEX "ExternalInvite_companyId_email_key" ON "ExternalInvite"("companyId", "email");
ALTER TABLE "ExternalInvite" ADD CONSTRAINT "ExternalInvite_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExternalInvite" ADD CONSTRAINT "ExternalInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExternalInvite" ADD CONSTRAINT "ExternalInvite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Permissões: aprovar pedidos de perfil e convidar externos (super e admin)
INSERT INTO "Permission" ("name", "description", "group")
SELECT 'aprovar_acesso_user', 'Aprovar ou recusar pedidos de acesso de quem entrou com o Google', 'user'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "name" = 'aprovar_acesso_user');
INSERT INTO "Permission" ("name", "description", "group")
SELECT 'convidar_externo_user', 'Convidar, renovar e revogar acesso de pessoas de fora do domínio', 'user'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "name" = 'convidar_externo_user');
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", perm."id" FROM "Profile" p, "Permission" perm
WHERE p."name" IN ('super', 'admin') AND perm."name" IN ('aprovar_acesso_user', 'convidar_externo_user')
AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" pp WHERE pp."profileId" = p."id" AND pp."permissionId" = perm."id");
