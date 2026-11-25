-- Área fiscal: emissão de NFS-e pelo padrão nacional (worksafe/nfse-planejamento)
-- CreateEnum
CREATE TYPE "FiscalEnvironment" AS ENUM ('restrita', 'producao');

-- CreateEnum
CREATE TYPE "FiscalInvoiceStatus" AS ENUM ('rascunho', 'emitindo', 'autorizada', 'rejeitada', 'cancelada', 'substituida');

-- CreateEnum
CREATE TYPE "FiscalTakerKind" AS ENUM ('cliente', 'aluno', 'avulso');

-- CreateEnum
CREATE TYPE "FiscalProviderKind" AS ENUM ('sefin', 'externa');

-- AlterTable
ALTER TABLE "Financial_Retention" ADD COLUMN     "fiscalInvoiceId" INTEGER;

-- AlterTable
ALTER TABLE "FinancialRecords" ADD COLUMN     "fiscalInvoiceId" INTEGER;

-- CreateTable
CREATE TABLE "Fiscal_Settings" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "environment" "FiscalEnvironment" NOT NULL DEFAULT 'restrita',
    "municipalRegistration" VARCHAR(15),
    "simplesNacional" INTEGER NOT NULL DEFAULT 3,
    "simplesRegime" INTEGER,
    "specialRegime" INTEGER NOT NULL DEFAULT 0,
    "simplesTotalRate" DECIMAL(5,2),
    "pisCofinsCst" VARCHAR(2) NOT NULL DEFAULT '49',
    "dpsSeries" VARCHAR(5) NOT NULL DEFAULT '900',
    "nextDpsNumber" INTEGER NOT NULL DEFAULT 1,
    "nextDpsNumberTest" INTEGER NOT NULL DEFAULT 1,
    "certificateEncrypted" TEXT,
    "certificateSubject" VARCHAR(255),
    "certificateDocument" VARCHAR(14),
    "certificateValidFrom" TIMESTAMP(3),
    "certificateValidTo" TIMESTAMP(3),
    "certificateUpdatedAt" TIMESTAMP(3),
    "autoSendEmail" BOOLEAN NOT NULL DEFAULT true,
    "defaultNotes" TEXT,
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fiscal_Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fiscal_ServiceCode" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "nationalCode" VARCHAR(6) NOT NULL,
    "municipalCode" VARCHAR(20),
    "nbsCode" VARCHAR(9),
    "issRate" DECIMAL(5,2),
    "issTaxation" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Fiscal_ServiceCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fiscal_Invoice" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "status" "FiscalInvoiceStatus" NOT NULL DEFAULT 'rascunho',
    "provider" "FiscalProviderKind" NOT NULL DEFAULT 'sefin',
    "environment" "FiscalEnvironment" NOT NULL DEFAULT 'restrita',
    "takerKind" "FiscalTakerKind" NOT NULL DEFAULT 'cliente',
    "customerId" INTEGER,
    "traineeId" INTEGER,
    "taker" JSONB NOT NULL,
    "serviceCodeId" INTEGER,
    "service" JSONB NOT NULL,
    "description" TEXT NOT NULL,
    "placeOfService" VARCHAR(7) NOT NULL,
    "competence" DATE NOT NULL,
    "grossValue" DECIMAL(15,2) NOT NULL,
    "discountValue" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "issRate" DECIMAL(5,2),
    "issValue" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "issWithheld" BOOLEAN NOT NULL DEFAULT false,
    "federalRetentions" JSONB,
    "netValue" DECIMAL(15,2) NOT NULL,
    "dpsSeries" VARCHAR(5),
    "dpsNumber" INTEGER,
    "dpsId" VARCHAR(45),
    "accessKey" VARCHAR(50),
    "number" VARCHAR(20),
    "issuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "xmlKey" VARCHAR(255),
    "pdfKey" VARCHAR(255),
    "externalUrl" TEXT,
    "messages" JSONB,
    "receivable" JSONB,
    "replacesId" INTEGER,
    "replacedById" INTEGER,
    "cancelReason" VARCHAR(255),
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" INTEGER,
    "emailSentAt" TIMESTAMP(3),
    "emailSentTo" VARCHAR(500),
    "createdByUserId" INTEGER,
    "issuedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fiscal_Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fiscal_InvoiceLink" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "contractId" INTEGER,
    "installmentId" INTEGER,
    "measurementId" INTEGER,
    "rentalChargeId" INTEGER,
    "subscriptionId" INTEGER,
    "financialRecordId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fiscal_InvoiceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fiscal_InvoiceEvent" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "detail" JSONB,
    "xmlKey" VARCHAR(255),
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fiscal_InvoiceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Fiscal_Settings_companyId_key" ON "Fiscal_Settings"("companyId");

-- CreateIndex
CREATE INDEX "Fiscal_ServiceCode_companyId_idx" ON "Fiscal_ServiceCode"("companyId");

-- CreateIndex
CREATE INDEX "Fiscal_Invoice_companyId_status_idx" ON "Fiscal_Invoice"("companyId", "status");

-- CreateIndex
CREATE INDEX "Fiscal_Invoice_companyId_competence_idx" ON "Fiscal_Invoice"("companyId", "competence");

-- CreateIndex
CREATE INDEX "Fiscal_Invoice_customerId_idx" ON "Fiscal_Invoice"("customerId");

-- CreateIndex
CREATE INDEX "Fiscal_Invoice_accessKey_idx" ON "Fiscal_Invoice"("accessKey");

-- CreateIndex
CREATE UNIQUE INDEX "Fiscal_Invoice_companyId_environment_dpsSeries_dpsNumber_key" ON "Fiscal_Invoice"("companyId", "environment", "dpsSeries", "dpsNumber");

-- CreateIndex
CREATE INDEX "Fiscal_InvoiceLink_invoiceId_idx" ON "Fiscal_InvoiceLink"("invoiceId");

-- CreateIndex
CREATE INDEX "Fiscal_InvoiceLink_contractId_idx" ON "Fiscal_InvoiceLink"("contractId");

-- CreateIndex
CREATE INDEX "Fiscal_InvoiceLink_installmentId_idx" ON "Fiscal_InvoiceLink"("installmentId");

-- CreateIndex
CREATE INDEX "Fiscal_InvoiceLink_measurementId_idx" ON "Fiscal_InvoiceLink"("measurementId");

-- CreateIndex
CREATE INDEX "Fiscal_InvoiceLink_financialRecordId_idx" ON "Fiscal_InvoiceLink"("financialRecordId");

-- CreateIndex
CREATE INDEX "Fiscal_InvoiceEvent_invoiceId_idx" ON "Fiscal_InvoiceEvent"("invoiceId");

-- CreateIndex
CREATE INDEX "FinancialRecords_fiscalInvoiceId_idx" ON "FinancialRecords"("fiscalInvoiceId");

-- AddForeignKey
ALTER TABLE "Fiscal_InvoiceLink" ADD CONSTRAINT "Fiscal_InvoiceLink_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Fiscal_Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fiscal_InvoiceEvent" ADD CONSTRAINT "Fiscal_InvoiceEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Fiscal_Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Permissões da área fiscal
INSERT INTO "Permission" ("name", "description", "group")
SELECT v.name, v.description, 'fiscal' FROM (VALUES
  ('view_nfse', 'Ver as notas fiscais de serviço'),
  ('emitir_nfse', 'Emitir notas fiscais de serviço'),
  ('cancelar_nfse', 'Cancelar e substituir notas fiscais de serviço'),
  ('config_fiscal', 'Configurar a área fiscal (certificado, série, serviços fiscais)')
) AS v(name, description)
WHERE NOT EXISTS (SELECT 1 FROM "Permission" p WHERE p."name" = v.name);

-- super recebe todas
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", perm."id" FROM "Profile" p, "Permission" perm
WHERE p."name" = 'super' AND perm."name" IN ('view_nfse', 'emitir_nfse', 'cancelar_nfse', 'config_fiscal')
AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" pp WHERE pp."profileId" = p."id" AND pp."permissionId" = perm."id");

-- quem vê o financeiro vê as notas; quem lança no financeiro emite
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT DISTINCT pp."profileId", perm."id" FROM "ProfilePermission" pp
JOIN "Permission" base ON base."id" = pp."permissionId" AND base."name" = 'list_financeiro'
CROSS JOIN "Permission" perm WHERE perm."name" = 'view_nfse'
AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" x WHERE x."profileId" = pp."profileId" AND x."permissionId" = perm."id");

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT DISTINCT pp."profileId", perm."id" FROM "ProfilePermission" pp
JOIN "Permission" base ON base."id" = pp."permissionId" AND base."name" = 'create_financeiro'
CROSS JOIN "Permission" perm WHERE perm."name" = 'emitir_nfse'
AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" x WHERE x."profileId" = pp."profileId" AND x."permissionId" = perm."id");
