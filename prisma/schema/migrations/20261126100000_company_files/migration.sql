-- Arquivos da empresa, fase 1: pastas em árvore e arquivos no armazenamento privado.
CREATE TABLE "File_Folder" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "parentId" INTEGER,
    "name" VARCHAR(120) NOT NULL,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "profileIds" JSONB,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trashedAt" TIMESTAMP(3),
    "trashedByUserId" INTEGER,

    CONSTRAINT "File_Folder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "File_Folder_companyId_parentId_idx" ON "File_Folder"("companyId", "parentId");
ALTER TABLE "File_Folder" ADD CONSTRAINT "File_Folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "File_Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "File_Item" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "folderId" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "fileName" VARCHAR(200) NOT NULL,
    "fileKey" VARCHAR(300) NOT NULL,
    "mimeType" VARCHAR(150) NOT NULL,
    "size" BIGINT NOT NULL,
    "notes" VARCHAR(500),
    "uploadedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trashedAt" TIMESTAMP(3),
    "trashedByUserId" INTEGER,

    CONSTRAINT "File_Item_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "File_Item_companyId_folderId_idx" ON "File_Item"("companyId", "folderId");
CREATE INDEX "File_Item_companyId_trashedAt_idx" ON "File_Item"("companyId", "trashedAt");
ALTER TABLE "File_Item" ADD CONSTRAINT "File_Item_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "File_Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Permissões: ver (abrir e baixar), alterar (enviar, mover, lixeira) e administrar (acesso por pasta, apagar de vez).
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('view_arquivos', 'Ver e baixar os arquivos da empresa nas pastas a que o perfil tem acesso', 'arquivos'),
  ('update_arquivos', 'Enviar, renomear, mover e mandar para a lixeira arquivos e subpastas', 'arquivos'),
  ('manage_arquivos', 'Criar pastas principais, definir quem acessa cada pasta, apagar de vez e ver o histórico de acesso', 'arquivos')
ON CONFLICT ("name") DO NOTHING;

-- super e Gestão recebem as três.
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" IN ('view_arquivos', 'update_arquivos', 'manage_arquivos')
WHERE p."name" IN ('super', 'Gestão') AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

-- RH, Financeiro, Comercial, Suprimentos e o gestor da Operação veem e enviam.
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" IN ('view_arquivos', 'update_arquivos')
WHERE p."name" IN ('RH', 'Financeiro', 'Comercial', 'Suprimentos', 'Operação - gestor') AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

-- O campo só vê.
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" = 'view_arquivos'
WHERE p."name" = 'Operação - campo' AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
