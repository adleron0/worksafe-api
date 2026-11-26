-- Área fiscal: notas recebidas de fornecedores (distribuição do ambiente nacional) e pacote do contador
ALTER TABLE "Fiscal_Settings" ADD COLUMN "receivedLastNsu" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Fiscal_Settings" ADD COLUMN "receivedSyncedAt" TIMESTAMP(3);

CREATE TABLE "Fiscal_ReceivedInvoice" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "nsu" INTEGER NOT NULL,
    "accessKey" VARCHAR(50) NOT NULL,
    "number" VARCHAR(20),
    "issuedAt" TIMESTAMP(3),
    "competence" DATE,
    "issuerDocument" VARCHAR(14) NOT NULL,
    "issuerName" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "grossValue" DECIMAL(15,2) NOT NULL,
    "netValue" DECIMAL(15,2) NOT NULL,
    "issWithheld" BOOLEAN NOT NULL DEFAULT false,
    "issValue" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "retentions" JSONB,
    "status" VARCHAR(12) NOT NULL DEFAULT 'nova',
    "supplierId" INTEGER,
    "payableId" INTEGER,
    "xmlKey" VARCHAR(255),
    "handledByUserId" INTEGER,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Fiscal_ReceivedInvoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Fiscal_ReceivedInvoice_companyId_accessKey_key" ON "Fiscal_ReceivedInvoice"("companyId", "accessKey");
CREATE INDEX "Fiscal_ReceivedInvoice_companyId_status_idx" ON "Fiscal_ReceivedInvoice"("companyId", "status");
