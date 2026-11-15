-- RH, fase 1: cadastro de funcionários, funções e histórico.
CREATE TABLE "Hr_Employee" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "cpf" VARCHAR(11),
    "rg" VARCHAR(30),
    "birthDate" DATE,
    "email" VARCHAR(160),
    "emergencyName" VARCHAR(120),
    "emergencyPhone" VARCHAR(30),
    "phone" VARCHAR(30),
    "registration" VARCHAR(30),
    "contractType" VARCHAR(12) NOT NULL DEFAULT 'clt',
    "admissionDate" DATE,
    "terminationDate" DATE,
    "userId" INTEGER,
    "notes" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Hr_Employee_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Hr_Employee_userId_key" ON "Hr_Employee"("userId");
CREATE UNIQUE INDEX "Hr_Employee_companyId_cpf_key" ON "Hr_Employee"("companyId", "cpf");
CREATE INDEX "Hr_Employee_companyId_name_idx" ON "Hr_Employee"("companyId", "name");

CREATE TABLE "Hr_EmployeeRole" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "professionalId" INTEGER NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hr_EmployeeRole_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Hr_EmployeeRole_employeeId_professionalId_key" ON "Hr_EmployeeRole"("employeeId", "professionalId");
CREATE INDEX "Hr_EmployeeRole_professionalId_idx" ON "Hr_EmployeeRole"("professionalId");
ALTER TABLE "Hr_EmployeeRole" ADD CONSTRAINT "Hr_EmployeeRole_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Hr_Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Hr_EmployeeRole" ADD CONSTRAINT "Hr_EmployeeRole_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "Commercial_Professional"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Hr_EmployeeEvent" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "reason" VARCHAR(1000),
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Hr_EmployeeEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Hr_EmployeeEvent_employeeId_startDate_idx" ON "Hr_EmployeeEvent"("employeeId", "startDate");
CREATE INDEX "Hr_EmployeeEvent_companyId_type_startDate_idx" ON "Hr_EmployeeEvent"("companyId", "type", "startDate");
ALTER TABLE "Hr_EmployeeEvent" ADD CONSTRAINT "Hr_EmployeeEvent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Hr_Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Permissões (grupo rh): o cadastro, e três separadas para o que é mais reservado.
--   view_dados_pessoais_funcionarios: CPF, RG, nascimento, e-mail e contato de emergência.
--   view/update_ocorrencias_funcionarios: férias, afastamentos, suspensões, advertências e desligamento.
INSERT INTO "Permission" ("name", "description", "group")
SELECT v.prefix || '_funcionarios', v.label || ' funcionários', 'rh'
FROM (VALUES ('view', 'Ver'), ('list', 'Listar'), ('create', 'Criar'), ('update', 'Editar'), ('inactive', 'Inativar'), ('activate', 'Ativar')) AS v(prefix, label)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('view_dados_pessoais_funcionarios', 'Ver dados pessoais dos funcionários (CPF, RG, nascimento, contato de emergência)', 'rh'),
  ('view_ocorrencias_funcionarios', 'Ver o histórico dos funcionários (advertências, suspensões, motivos)', 'rh'),
  ('update_ocorrencias_funcionarios', 'Lançar férias, afastamento, suspensão, advertência e desligamento', 'rh')
ON CONFLICT ("name") DO NOTHING;

-- o perfil super pode tudo
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", n."id"
FROM "Profile" p
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "group" = 'rh') n
WHERE p."name" = 'super'
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

-- Perfil de fábrica RH: só nasce se não houver perfil com esse nome; ninguém é movido.
WITH home AS (
  SELECT COALESCE((SELECT MIN("companyId") FROM "Profile" WHERE "companyId" > 0), (SELECT MIN("id") FROM "Company")) AS "id"
),
created AS (
  INSERT INTO "Profile" ("name", "companyId")
  SELECT 'RH', home."id" FROM home
  WHERE home."id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Profile" p WHERE p."name" = 'RH')
  RETURNING "id"
)
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT c."id", pm."id" FROM created c JOIN "Permission" pm ON pm."group" = 'rh'
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

-- Perfis de fábrica que já existem: a Gestão recebe tudo do RH; o gestor da
-- Operação vê e lista os funcionários (sem dados pessoais nem histórico).
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."group" = 'rh'
WHERE p."name" = 'Gestão' AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" IN ('view_funcionarios', 'list_funcionarios')
WHERE p."name" = 'Operação - gestor' AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
