-- Pedidos de compra (Suprimentos).
CREATE TABLE "Purchase_Order" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "group" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'solicitado',
    "supplierId" INTEGER,
    "serviceOrderId" INTEGER,
    "items" JSONB NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "justification" TEXT,
    "neededBy" DATE,
    "deliveryDate" DATE,
    "paymentTerms" JSONB,
    "attachments" JSONB NOT NULL,
    "invoiceNumber" VARCHAR(60),
    "statusNote" VARCHAR(500),
    "requestedByUserId" INTEGER,
    "approvedByUserId" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "purchasedAt" DATE,
    "receivedAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Purchase_Order_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Purchase_Order_companyId_number_key" ON "Purchase_Order"("companyId", "number");
CREATE INDEX "Purchase_Order_companyId_status_idx" ON "Purchase_Order"("companyId", "status");
CREATE INDEX "Purchase_Order_companyId_serviceOrderId_idx" ON "Purchase_Order"("companyId", "serviceOrderId");
CREATE INDEX "Purchase_Order_companyId_supplierId_idx" ON "Purchase_Order"("companyId", "supplierId");
CREATE INDEX "Financial_Payable_companyId_purchaseOrderId_idx" ON "Financial_Payable"("companyId", "purchaseOrderId");

-- Permissões: as de sempre e uma própria para aprovar.
INSERT INTO "Permission" ("name", "description", "group")
SELECT v.prefix || '_pedidos_de_compra', v.label || ' pedidos de compra', 'servicos'
FROM (VALUES ('view', 'Ver'), ('list', 'Listar'), ('create', 'Criar'), ('update', 'Editar'), ('inactive', 'Inativar'), ('activate', 'Ativar'), ('approve', 'Aprovar')) AS v(prefix, label)
ON CONFLICT ("name") DO NOTHING;

-- Por padrão só o perfil super recebe (inclusive aprovar); os demais perfis são definidos depois.
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", n."id"
FROM "Profile" p
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "name" LIKE '%\_pedidos\_de\_compra') n
WHERE p."name" = 'super'
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
