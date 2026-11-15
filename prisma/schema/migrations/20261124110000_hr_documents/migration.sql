-- RH, fase 2: documentos do funcionário (tipos configuráveis e arquivos em armazenamento privado).
CREATE TABLE "Hr_DocumentType" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "folder" VARCHAR(20) NOT NULL DEFAULT 'outros',
    "expires" BOOLEAN NOT NULL DEFAULT false,
    "validityMonths" INTEGER,
    "warnDays" INTEGER NOT NULL DEFAULT 30,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "requiredProfessionalIds" JSONB,
    "inIntegration" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Hr_DocumentType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Hr_DocumentType_companyId_name_key" ON "Hr_DocumentType"("companyId", "name");

CREATE TABLE "Hr_EmployeeDocument" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "typeId" INTEGER NOT NULL,
    "issueDate" DATE,
    "expiryDate" DATE,
    "fileKey" VARCHAR(300) NOT NULL,
    "fileName" VARCHAR(200) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    "size" INTEGER NOT NULL,
    "notes" VARCHAR(500),
    "uploadedByUserId" INTEGER,
    "replacedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Hr_EmployeeDocument_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Hr_EmployeeDocument_companyId_expiryDate_idx" ON "Hr_EmployeeDocument"("companyId", "expiryDate");
CREATE INDEX "Hr_EmployeeDocument_employeeId_typeId_idx" ON "Hr_EmployeeDocument"("employeeId", "typeId");
ALTER TABLE "Hr_EmployeeDocument" ADD CONSTRAINT "Hr_EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Hr_Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Hr_EmployeeDocument" ADD CONSTRAINT "Hr_EmployeeDocument_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "Hr_DocumentType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Permissões: ver (abrir e baixar) e alterar (enviar, substituir, tipos de documento).
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('view_documentos_funcionarios', 'Ver e baixar documentos dos funcionários', 'rh'),
  ('update_documentos_funcionarios', 'Enviar e substituir documentos dos funcionários e configurar os tipos', 'rh')
ON CONFLICT ("name") DO NOTHING;

-- super, RH e Gestão recebem as duas; o gestor da Operação só vê (para reunir os documentos da obra).
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" IN ('view_documentos_funcionarios', 'update_documentos_funcionarios')
WHERE p."name" IN ('super', 'RH', 'Gestão') AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" = 'view_documentos_funcionarios'
WHERE p."name" = 'Operação - gestor' AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
