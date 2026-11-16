-- Estoque de equipamentos e materiais (Suprimentos). Plano em worksafe/estoque-planejamento/.

-- AlterEnum
ALTER TYPE "CommercialItemType" ADD VALUE 'locacao_cliente';

-- AlterTable
ALTER TABLE "Commercial_ProposalItem" ADD COLUMN     "stockItemId" INTEGER;

-- CreateTable
CREATE TABLE "Stock_Category" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "parentId" INTEGER,
    "prefix" VARCHAR(8),
    "defaults" JSONB,
    "inspectionTemplateId" INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Stock_Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_Location" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'almoxarifado',
    "placeId" INTEGER,
    "responsibleUserId" INTEGER,
    "sellsOnline" BOOLEAN NOT NULL DEFAULT false,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Stock_Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_Item" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "categoryId" INTEGER,
    "manufacturer" VARCHAR(120),
    "model" VARCHAR(120),
    "photoUrl" VARCHAR(500),
    "unit" VARCHAR(20) NOT NULL DEFAULT 'un',
    "purchaseUnit" VARCHAR(20),
    "purchaseFactor" DECIMAL(12,4),
    "tracking" VARCHAR(12) NOT NULL DEFAULT 'quantidade',
    "returnable" BOOLEAN NOT NULL DEFAULT false,
    "minQuantity" DECIMAL(14,3),
    "reorderQuantity" DECIMAL(14,3),
    "requiresInspection" BOOLEAN NOT NULL DEFAULT false,
    "inspectionIntervalDays" INTEGER,
    "inspectionBeforeUse" BOOLEAN NOT NULL DEFAULT false,
    "inspectionTemplateId" INTEGER,
    "lifeMonths" INTEGER,
    "lifeFrom" VARCHAR(14) NOT NULL DEFAULT 'fabricacao',
    "warnDays" INTEGER NOT NULL DEFAULT 30,
    "requiresCalibration" BOOLEAN NOT NULL DEFAULT false,
    "calibrationIntervalMonths" INTEGER,
    "isPpe" BOOLEAN NOT NULL DEFAULT false,
    "caNumber" VARCHAR(30),
    "caExpiry" DATE,
    "replaceEveryDays" INTEGER,
    "rentable" BOOLEAN NOT NULL DEFAULT false,
    "rentDaily" DECIMAL(14,2),
    "rentWeekly" DECIMAL(14,2),
    "rentMonthly" DECIMAL(14,2),
    "replacementValue" DECIMAL(14,2),
    "siteProductId" INTEGER,
    "averageCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lastCost" DECIMAL(18,4),
    "lastSupplierId" INTEGER,
    "lastPurchaseAt" DATE,
    "notes" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Stock_Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_Lot" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "number" VARCHAR(60) NOT NULL,
    "manufacturedAt" DATE,
    "expiresAt" DATE,
    "supplierId" INTEGER,
    "purchaseOrderId" INTEGER,
    "unitCost" DECIMAL(18,4),
    "status" VARCHAR(12) NOT NULL DEFAULT 'liberado',
    "nextInspectionAt" DATE,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Stock_Lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_Unit" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "lotId" INTEGER,
    "tag" VARCHAR(40) NOT NULL,
    "serialNumber" VARCHAR(80),
    "manufacturedAt" DATE,
    "acquiredAt" DATE,
    "firstUseAt" DATE,
    "supplierId" INTEGER,
    "purchaseOrderId" INTEGER,
    "acquisitionCost" DECIMAL(18,4),
    "status" VARCHAR(16) NOT NULL DEFAULT 'disponivel',
    "needsInspection" BOOLEAN NOT NULL DEFAULT false,
    "holderType" VARCHAR(12) NOT NULL DEFAULT 'local',
    "holderId" INTEGER,
    "nextInspectionAt" DATE,
    "nextCalibrationAt" DATE,
    "lifeEndsAt" DATE,
    "retiredAt" DATE,
    "retiredReason" VARCHAR(14),
    "retiredNote" VARCHAR(500),
    "originUnitId" INTEGER,
    "length" DECIMAL(10,2),
    "attributes" JSONB,
    "notes" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stock_Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_Balance" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "lotId" INTEGER NOT NULL DEFAULT 0,
    "holderType" VARCHAR(12) NOT NULL,
    "holderId" INTEGER NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stock_Balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_Movement" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "date" DATE NOT NULL,
    "userId" INTEGER,
    "note" VARCHAR(1000),
    "purchaseOrderId" INTEGER,
    "serviceOrderId" INTEGER,
    "employeeId" INTEGER,
    "rentalId" INTEGER,
    "supplierId" INTEGER,
    "countId" INTEGER,
    "costCenterId" INTEGER,
    "reversesId" INTEGER,
    "reversedById" INTEGER,
    "reason" VARCHAR(20),
    "signature" JSONB,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stock_Movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_MovementLine" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "movementId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "lotId" INTEGER,
    "unitId" INTEGER,
    "quantity" DECIMAL(14,3) NOT NULL,
    "fromType" VARCHAR(12) NOT NULL,
    "fromId" INTEGER,
    "toType" VARCHAR(12) NOT NULL,
    "toId" INTEGER,
    "unitCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "chargedToOrder" BOOLEAN NOT NULL DEFAULT false,
    "condition" VARCHAR(12),
    "note" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stock_MovementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_InspectionTemplate" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Stock_InspectionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_Inspection" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "unitId" INTEGER,
    "lotId" INTEGER,
    "kind" VARCHAR(16) NOT NULL,
    "date" DATE NOT NULL,
    "result" VARCHAR(18) NOT NULL,
    "templateId" INTEGER,
    "answers" JSONB NOT NULL,
    "inspectorEmployeeId" INTEGER,
    "inspectorUserId" INTEGER,
    "serviceOrderId" INTEGER,
    "nextDueAt" DATE,
    "photos" JSONB NOT NULL,
    "notes" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stock_Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_ServiceEvent" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "unitId" INTEGER NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'enviado',
    "sentAt" DATE,
    "returnedAt" DATE,
    "supplierId" INTEGER,
    "purchaseOrderId" INTEGER,
    "cost" DECIMAL(14,2),
    "result" VARCHAR(12),
    "certificateNumber" VARCHAR(80),
    "nextDueAt" DATE,
    "locationId" INTEGER,
    "notes" VARCHAR(1000),
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stock_ServiceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_Rental" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "contractId" INTEGER,
    "proposalId" INTEGER,
    "serviceOrderId" INTEGER,
    "status" VARCHAR(12) NOT NULL DEFAULT 'reservada',
    "startDate" DATE NOT NULL,
    "expectedEnd" DATE,
    "deliveredAt" DATE,
    "returnedAt" DATE,
    "billing" VARCHAR(10) NOT NULL DEFAULT 'periodo',
    "period" VARCHAR(8) NOT NULL DEFAULT 'mes',
    "billedUntil" DATE,
    "deliveryAddress" VARCHAR(300),
    "responsibleName" VARCHAR(160),
    "terms" TEXT,
    "deposit" DECIMAL(14,2),
    "notes" VARCHAR(1000),
    "statusNote" VARCHAR(500),
    "signature" JSONB,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Stock_Rental_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_RentalLine" (
    "id" SERIAL NOT NULL,
    "rentalId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "unitId" INTEGER,
    "lotId" INTEGER,
    "quantity" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deliveredQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "returnedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "condition" VARCHAR(12),
    "damageValue" DECIMAL(14,2),
    "note" VARCHAR(500),

    CONSTRAINT "Stock_RentalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_RentalCharge" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "rentalId" INTEGER NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "description" VARCHAR(255),
    "financialRecordId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stock_RentalCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_Count" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "locationId" INTEGER NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'aberta',
    "blindCount" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(500),
    "openedByUserId" INTEGER,
    "closedByUserId" INTEGER,
    "movementId" INTEGER,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Stock_Count_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_CountLine" (
    "id" SERIAL NOT NULL,
    "countId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "lotId" INTEGER NOT NULL DEFAULT 0,
    "unitId" INTEGER,
    "expected" DECIMAL(14,3) NOT NULL,
    "counted" DECIMAL(14,3),
    "note" VARCHAR(300),

    CONSTRAINT "Stock_CountLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Stock_Category_companyId_parentId_idx" ON "Stock_Category"("companyId", "parentId");

-- CreateIndex
CREATE INDEX "Stock_Location_companyId_idx" ON "Stock_Location"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_Item_siteProductId_key" ON "Stock_Item"("siteProductId");

-- CreateIndex
CREATE INDEX "Stock_Item_companyId_categoryId_idx" ON "Stock_Item"("companyId", "categoryId");

-- CreateIndex
CREATE INDEX "Stock_Item_companyId_name_idx" ON "Stock_Item"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_Item_companyId_code_key" ON "Stock_Item"("companyId", "code");

-- CreateIndex
CREATE INDEX "Stock_Lot_companyId_expiresAt_idx" ON "Stock_Lot"("companyId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_Lot_itemId_number_key" ON "Stock_Lot"("itemId", "number");

-- CreateIndex
CREATE INDEX "Stock_Unit_companyId_itemId_status_idx" ON "Stock_Unit"("companyId", "itemId", "status");

-- CreateIndex
CREATE INDEX "Stock_Unit_companyId_holderType_holderId_idx" ON "Stock_Unit"("companyId", "holderType", "holderId");

-- CreateIndex
CREATE INDEX "Stock_Unit_companyId_nextInspectionAt_idx" ON "Stock_Unit"("companyId", "nextInspectionAt");

-- CreateIndex
CREATE INDEX "Stock_Unit_companyId_nextCalibrationAt_idx" ON "Stock_Unit"("companyId", "nextCalibrationAt");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_Unit_companyId_tag_key" ON "Stock_Unit"("companyId", "tag");

-- CreateIndex
CREATE INDEX "Stock_Balance_companyId_holderType_holderId_idx" ON "Stock_Balance"("companyId", "holderType", "holderId");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_Balance_itemId_lotId_holderType_holderId_key" ON "Stock_Balance"("itemId", "lotId", "holderType", "holderId");

-- CreateIndex
CREATE INDEX "Stock_Movement_companyId_type_date_idx" ON "Stock_Movement"("companyId", "type", "date");

-- CreateIndex
CREATE INDEX "Stock_Movement_companyId_serviceOrderId_idx" ON "Stock_Movement"("companyId", "serviceOrderId");

-- CreateIndex
CREATE INDEX "Stock_Movement_companyId_purchaseOrderId_idx" ON "Stock_Movement"("companyId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "Stock_Movement_companyId_employeeId_idx" ON "Stock_Movement"("companyId", "employeeId");

-- CreateIndex
CREATE INDEX "Stock_Movement_companyId_rentalId_idx" ON "Stock_Movement"("companyId", "rentalId");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_Movement_companyId_number_key" ON "Stock_Movement"("companyId", "number");

-- CreateIndex
CREATE INDEX "Stock_MovementLine_itemId_createdAt_idx" ON "Stock_MovementLine"("itemId", "createdAt");

-- CreateIndex
CREATE INDEX "Stock_MovementLine_unitId_idx" ON "Stock_MovementLine"("unitId");

-- CreateIndex
CREATE INDEX "Stock_MovementLine_companyId_toType_toId_idx" ON "Stock_MovementLine"("companyId", "toType", "toId");

-- CreateIndex
CREATE INDEX "Stock_MovementLine_companyId_fromType_fromId_idx" ON "Stock_MovementLine"("companyId", "fromType", "fromId");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_InspectionTemplate_companyId_name_key" ON "Stock_InspectionTemplate"("companyId", "name");

-- CreateIndex
CREATE INDEX "Stock_Inspection_companyId_unitId_idx" ON "Stock_Inspection"("companyId", "unitId");

-- CreateIndex
CREATE INDEX "Stock_Inspection_companyId_lotId_idx" ON "Stock_Inspection"("companyId", "lotId");

-- CreateIndex
CREATE INDEX "Stock_Inspection_companyId_date_idx" ON "Stock_Inspection"("companyId", "date");

-- CreateIndex
CREATE INDEX "Stock_ServiceEvent_companyId_unitId_idx" ON "Stock_ServiceEvent"("companyId", "unitId");

-- CreateIndex
CREATE INDEX "Stock_ServiceEvent_companyId_status_idx" ON "Stock_ServiceEvent"("companyId", "status");

-- CreateIndex
CREATE INDEX "Stock_Rental_companyId_status_idx" ON "Stock_Rental"("companyId", "status");

-- CreateIndex
CREATE INDEX "Stock_Rental_companyId_customerId_idx" ON "Stock_Rental"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "Stock_Rental_contractId_idx" ON "Stock_Rental"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_Rental_companyId_number_key" ON "Stock_Rental"("companyId", "number");

-- CreateIndex
CREATE INDEX "Stock_RentalLine_rentalId_idx" ON "Stock_RentalLine"("rentalId");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_RentalCharge_rentalId_periodStart_kind_key" ON "Stock_RentalCharge"("rentalId", "periodStart", "kind");

-- CreateIndex
CREATE INDEX "Stock_Count_companyId_status_idx" ON "Stock_Count"("companyId", "status");

-- CreateIndex
CREATE INDEX "Stock_CountLine_countId_idx" ON "Stock_CountLine"("countId");

-- AddForeignKey
ALTER TABLE "Stock_Category" ADD CONSTRAINT "Stock_Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Stock_Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_Item" ADD CONSTRAINT "Stock_Item_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Stock_Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_Lot" ADD CONSTRAINT "Stock_Lot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Stock_Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_Unit" ADD CONSTRAINT "Stock_Unit_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Stock_Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_MovementLine" ADD CONSTRAINT "Stock_MovementLine_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "Stock_Movement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_RentalLine" ADD CONSTRAINT "Stock_RentalLine_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES "Stock_Rental"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_RentalCharge" ADD CONSTRAINT "Stock_RentalCharge_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES "Stock_Rental"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_CountLine" ADD CONSTRAINT "Stock_CountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "Stock_Count"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Permissões do grupo suprimentos. Os pedidos de compra passam para o mesmo grupo (só o campo group; nenhum nome muda).
UPDATE "Permission" SET "group" = 'suprimentos' WHERE "name" LIKE '%\_pedidos\_de\_compra';

INSERT INTO "Permission" ("name", "description", "group")
SELECT v.prefix || '_' || r.resource, v.label || ' ' || r.label, 'suprimentos'
FROM (VALUES ('view', 'Ver'), ('list', 'Listar'), ('create', 'Criar'), ('update', 'Editar'), ('inactive', 'Inativar'), ('activate', 'Ativar')) AS v(prefix, label)
CROSS JOIN (VALUES ('itens_estoque', 'itens do estoque'), ('equipamentos', 'equipamentos (unidades e lotes)'), ('locacoes', 'locações a clientes')) AS r(resource, label)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('movimentar_estoque', 'Dar entrada, transferir, sair e retornar de obra, consumo interno', 'suprimentos'),
  ('view_ajuste_estoque', 'Ver ajustes e inventários do estoque', 'suprimentos'),
  ('ajuste_estoque', 'Ajustar saldo, fazer inventário e estornar movimentações', 'suprimentos'),
  ('custos_estoque', 'Ver custo médio, valores e o valor parado em estoque', 'suprimentos'),
  ('view_inspecoes_equipamentos', 'Ver inspeções e roteiros de inspeção', 'suprimentos'),
  ('inspecoes_equipamentos', 'Registrar inspeções e editar os roteiros', 'suprimentos'),
  ('view_entregas_epi', 'Ver entregas e fichas de EPI', 'suprimentos'),
  ('list_entregas_epi', 'Listar entregas de EPI', 'suprimentos'),
  ('create_entregas_epi', 'Entregar, trocar e receber EPI', 'suprimentos'),
  ('view_fornecedores_suprimentos', 'Ver fornecedores em Suprimentos (sem dados bancários)', 'suprimentos')
ON CONFLICT ("name") DO NOTHING;

-- o perfil super pode tudo
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", n."id"
FROM "Profile" p
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "group" = 'suprimentos') n
WHERE p."name" = 'super'
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

-- Perfis de fábrica que já existem (ninguém é movido; perfil ajustado continua com o que tinha).
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."group" = 'suprimentos'
WHERE p."name" IN ('Suprimentos', 'Gestão') AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM (VALUES
  ('Operação - gestor', 'view_itens_estoque'), ('Operação - gestor', 'list_itens_estoque'), ('Operação - gestor', 'view_equipamentos'), ('Operação - gestor', 'list_equipamentos'),
  ('Operação - gestor', 'movimentar_estoque'), ('Operação - gestor', 'view_inspecoes_equipamentos'), ('Operação - gestor', 'inspecoes_equipamentos'),
  ('Operação - gestor', 'view_locacoes'), ('Operação - gestor', 'list_locacoes'),
  ('Operação - campo', 'movimentar_estoque'), ('Operação - campo', 'view_inspecoes_equipamentos'), ('Operação - campo', 'inspecoes_equipamentos'),
  ('RH', 'view_entregas_epi'), ('RH', 'list_entregas_epi'), ('RH', 'create_entregas_epi'), ('RH', 'view_itens_estoque'), ('RH', 'list_itens_estoque'),
  ('Financeiro', 'view_itens_estoque'), ('Financeiro', 'list_itens_estoque'), ('Financeiro', 'custos_estoque'), ('Financeiro', 'view_locacoes'), ('Financeiro', 'list_locacoes'),
  ('Comercial', 'view_locacoes'), ('Comercial', 'list_locacoes')
) AS m("profile", "permission")
JOIN "Profile" p ON p."name" = m."profile" AND p."inactiveAt" IS NULL
JOIN "Permission" pm ON pm."name" = m."permission"
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
