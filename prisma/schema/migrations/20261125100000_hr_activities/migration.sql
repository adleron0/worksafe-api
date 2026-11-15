-- RH, fase 6: atividades fora de OS (aula, treinamento, atividade no CT...) e a parte do dia.
CREATE TABLE "Hr_ActivityType" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "color" VARCHAR(9) NOT NULL DEFAULT '#0f766e',
    "occupies" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Hr_ActivityType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Hr_ActivityType_companyId_name_key" ON "Hr_ActivityType"("companyId", "name");

CREATE TABLE "Hr_Activity" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "typeId" INTEGER NOT NULL,
    "location" VARCHAR(200),
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "shift" VARCHAR(12) NOT NULL DEFAULT 'integral',
    "notes" VARCHAR(500),
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Hr_Activity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Hr_Activity_companyId_startDate_endDate_idx" ON "Hr_Activity"("companyId", "startDate", "endDate");
ALTER TABLE "Hr_Activity" ADD CONSTRAINT "Hr_Activity_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "Hr_ActivityType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Hr_ActivityEmployee" (
    "id" SERIAL NOT NULL,
    "activityId" INTEGER NOT NULL,
    "employeeId" INTEGER NOT NULL,

    CONSTRAINT "Hr_ActivityEmployee_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Hr_ActivityEmployee_activityId_employeeId_key" ON "Hr_ActivityEmployee"("activityId", "employeeId");
CREATE INDEX "Hr_ActivityEmployee_employeeId_idx" ON "Hr_ActivityEmployee"("employeeId");
ALTER TABLE "Hr_ActivityEmployee" ADD CONSTRAINT "Hr_ActivityEmployee_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Hr_Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Hr_ActivityEmployee" ADD CONSTRAINT "Hr_ActivityEmployee_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Hr_Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Permissão para lançar atividades no mapa de alocação: quem já escala equipes.
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('update_alocacao', 'Lançar e alterar atividades dos funcionários no mapa de alocação', 'rh')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" = 'update_alocacao'
WHERE p."name" IN ('super', 'RH', 'Gestão', 'Operação - gestor') AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
