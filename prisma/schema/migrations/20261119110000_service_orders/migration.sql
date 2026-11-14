-- Ordem de serviço e histórico de passagens entre etapas.
CREATE TYPE "ServiceOrderStatus" AS ENUM ('a_liberar', 'a_mobilizar', 'agendada', 'em_execucao', 'concluida', 'encerrada', 'cancelada');

CREATE TABLE "Service_Order" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "contractId" INTEGER NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "status" "ServiceOrderStatus" NOT NULL DEFAULT 'a_liberar',
    "contactName" VARCHAR(160),
    "contactPhone" VARCHAR(60),
    "contactEmail" VARCHAR(255),
    "location" VARCHAR(300),
    "responsibleUserId" INTEGER,
    "team" JSONB,
    "plannedStart" DATE,
    "plannedEnd" DATE,
    "startedAt" DATE,
    "finishedAt" DATE,
    "scope" JSONB NOT NULL,
    "schedule" JSONB,
    "budget" JSONB,
    "checklist" JSONB NOT NULL,
    "notes" TEXT,
    "conclusionNotes" TEXT,
    "statusNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Service_Order_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Service_Order_contractId_key" ON "Service_Order"("contractId");
CREATE UNIQUE INDEX "Service_Order_companyId_number_key" ON "Service_Order"("companyId", "number");
CREATE INDEX "Service_Order_companyId_status_idx" ON "Service_Order"("companyId", "status");
CREATE INDEX "Service_Order_companyId_customerId_idx" ON "Service_Order"("companyId", "customerId");

CREATE TABLE "Flow_Event" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "entity" VARCHAR(40) NOT NULL,
    "entityId" INTEGER NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "fromStage" VARCHAR(40),
    "toStage" VARCHAR(40),
    "userId" INTEGER,
    "note" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Flow_Event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Flow_Event_entity_entityId_idx" ON "Flow_Event"("entity", "entityId");

-- Permissões da ordem de serviço (as chaves já existem onde o cadastro inicial rodou).
INSERT INTO "Permission" ("name", "description", "group")
SELECT v.prefix || '_ordens_de_servico', v.label || ' ordens de serviço', 'servicos'
FROM (VALUES ('view', 'Ver'), ('list', 'Listar'), ('create', 'Criar'), ('update', 'Editar'), ('inactive', 'Inativar'), ('activate', 'Ativar')) AS v(prefix, label)
ON CONFLICT ("name") DO NOTHING;

-- Quem hoje edita o Comercial passa a ver e tocar as ordens de serviço: é quem já
-- acompanha a venda. Depois cada empresa separa os perfis (Operação, Comercial...).
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT DISTINCT pp."profileId", n."id"
FROM "ProfilePermission" pp
JOIN "Permission" o ON o."id" = pp."permissionId" AND o."name" = 'update_comercial'
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "name" LIKE '%\_ordens\_de\_servico') n
WHERE pp."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

INSERT INTO "UserPermission" ("userId", "permissionId")
SELECT DISTINCT up."userId", n."id"
FROM "UserPermission" up
JOIN "Permission" o ON o."id" = up."permissionId" AND o."name" = 'update_comercial'
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "name" LIKE '%\_ordens\_de\_servico') n
WHERE up."inactiveAt" IS NULL
ON CONFLICT ("userId", "permissionId") DO NOTHING;

-- Produto "servicos" (libera o menu) para as empresas que já têm o Comercial.
INSERT INTO "Product" ("name", "groupPermission")
SELECT 'servicos', 'servicos'
WHERE NOT EXISTS (SELECT 1 FROM "Product" WHERE "name" = 'servicos');

INSERT INTO "CompanyProduct" ("companyId", "productId")
SELECT DISTINCT cp."companyId", s."id"
FROM "CompanyProduct" cp
JOIN "Product" c ON c."id" = cp."productId" AND c."name" = 'comercial'
CROSS JOIN (SELECT MIN("id") AS "id" FROM "Product" WHERE "name" = 'servicos') s
WHERE cp."inactiveAt" IS NULL
ON CONFLICT ("companyId", "productId") DO NOTHING;
