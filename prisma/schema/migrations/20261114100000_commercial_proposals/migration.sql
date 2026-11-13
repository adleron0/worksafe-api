-- CreateEnum
CREATE TYPE "CommercialProposalKind" AS ENUM ('servico', 'treinamento', 'misto');

-- CreateEnum
CREATE TYPE "CommercialProposalStatus" AS ENUM ('rascunho', 'enviada', 'visualizada', 'aceita', 'recusada', 'expirada', 'cancelada', 'substituida');

-- CreateEnum
CREATE TYPE "CommercialItemType" AS ENUM ('mao_de_obra', 'locacao', 'material', 'treinamento', 'avulso');

-- CreateEnum
CREATE TYPE "CommercialDueRule" AS ENUM ('data_fixa', 'dias_apos_aceite', 'dias_apos_nf', 'dias_apos_conclusao');

-- CreateTable
CREATE TABLE "Commercial_CoursePrice" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "courseId" INTEGER NOT NULL,
    "classPrice" DECIMAL(12,2),
    "includedStudents" INTEGER,
    "studentPrice" DECIMAL(12,2),
    "notes" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commercial_CoursePrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_Proposal" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "rootId" INTEGER,
    "kind" "CommercialProposalKind" NOT NULL DEFAULT 'servico',
    "status" "CommercialProposalStatus" NOT NULL DEFAULT 'rascunho',
    "customerId" INTEGER NOT NULL,
    "contactName" VARCHAR(160),
    "contactEmail" VARCHAR(255),
    "contactPhone" VARCHAR(60),
    "requester" VARCHAR(160),
    "department" VARCHAR(160),
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "sellerId" INTEGER,
    "validUntil" DATE,
    "referenceDate" DATE NOT NULL,
    "workDays" INTEGER NOT NULL DEFAULT 0,
    "weekendDays" INTEGER NOT NULL DEFAULT 0,
    "contingencyRate" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "commissionRate" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "commissionBase" VARCHAR(20) NOT NULL DEFAULT 'faturado',
    "commissionInPrice" BOOLEAN NOT NULL DEFAULT false,
    "taxRegime" "CommercialTaxRegime",
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "snapshot" JSONB NOT NULL,
    "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalSuggested" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "profit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "commission" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "internalNotes" TEXT,
    "statusNote" VARCHAR(500),
    "sentAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Commercial_Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_ProposalSection" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "kind" "CommercialItemType" NOT NULL,
    "margin" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "showInDocument" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Commercial_ProposalSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_ProposalItem" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "sectionId" INTEGER NOT NULL,
    "type" "CommercialItemType" NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "unit" VARCHAR(30),
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "professionalId" INTEGER,
    "night" BOOLEAN NOT NULL DEFAULT false,
    "travel" BOOLEAN NOT NULL DEFAULT false,
    "weekend" BOOLEAN NOT NULL DEFAULT false,
    "workDays" INTEGER,
    "weekendDays" INTEGER,
    "hoursPerDay" DECIMAL(6,2),
    "courseId" INTEGER,
    "extra" JSONB,
    "unitCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "extraCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "margin" DECIMAL(7,6),
    "cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "suggestedValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "finalValue" DECIMAL(14,2),
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "showInDocument" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Commercial_ProposalItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_ProposalInstallment" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "percent" DECIMAL(7,6),
    "amount" DECIMAL(14,2),
    "dueRule" "CommercialDueRule" NOT NULL DEFAULT 'dias_apos_nf',
    "dueDate" DATE,
    "dueDays" INTEGER,
    "description" VARCHAR(200),

    CONSTRAINT "Commercial_ProposalInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_CoursePrice_companyId_courseId_key" ON "Commercial_CoursePrice"("companyId", "courseId");

-- CreateIndex
CREATE INDEX "Commercial_Proposal_companyId_status_idx" ON "Commercial_Proposal"("companyId", "status");

-- CreateIndex
CREATE INDEX "Commercial_Proposal_companyId_customerId_idx" ON "Commercial_Proposal"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "Commercial_Proposal_companyId_year_sequence_idx" ON "Commercial_Proposal"("companyId", "year", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_Proposal_companyId_number_key" ON "Commercial_Proposal"("companyId", "number");

-- CreateIndex
CREATE INDEX "Commercial_ProposalSection_proposalId_idx" ON "Commercial_ProposalSection"("proposalId");

-- CreateIndex
CREATE INDEX "Commercial_ProposalItem_proposalId_idx" ON "Commercial_ProposalItem"("proposalId");

-- CreateIndex
CREATE INDEX "Commercial_ProposalItem_sectionId_idx" ON "Commercial_ProposalItem"("sectionId");

-- CreateIndex
CREATE INDEX "Commercial_ProposalInstallment_proposalId_idx" ON "Commercial_ProposalInstallment"("proposalId");

-- AddForeignKey
ALTER TABLE "Commercial_Proposal" ADD CONSTRAINT "Commercial_Proposal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commercial_ProposalSection" ADD CONSTRAINT "Commercial_ProposalSection_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Commercial_Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commercial_ProposalItem" ADD CONSTRAINT "Commercial_ProposalItem_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Commercial_Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commercial_ProposalItem" ADD CONSTRAINT "Commercial_ProposalItem_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Commercial_ProposalSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commercial_ProposalInstallment" ADD CONSTRAINT "Commercial_ProposalInstallment_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Commercial_Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Permissão para ver custos, margens, lucro e comissão dentro da proposta.
-- Quem já edita a base de cálculo (update_comercial) já vê custos hoje, então
-- recebe a permissão nova: ninguém perde acesso e ninguém ganha visão nova.
INSERT INTO "Permission" ("name", "description", "group")
VALUES ('view_custos_comercial', 'Ver custos e margens das propostas', 'comercial')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT pp."profileId", n."id"
FROM "ProfilePermission" pp
JOIN "Permission" o ON o."id" = pp."permissionId" AND o."name" = 'update_comercial'
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "name" = 'view_custos_comercial') n
WHERE pp."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;

INSERT INTO "UserPermission" ("userId", "permissionId")
SELECT up."userId", n."id"
FROM "UserPermission" up
JOIN "Permission" o ON o."id" = up."permissionId" AND o."name" = 'update_comercial'
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "name" = 'view_custos_comercial') n
WHERE up."inactiveAt" IS NULL
ON CONFLICT ("userId", "permissionId") DO NOTHING;
