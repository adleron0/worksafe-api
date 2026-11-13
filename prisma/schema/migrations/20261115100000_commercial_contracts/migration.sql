-- CreateEnum
CREATE TYPE "CommercialContractStatus" AS ENUM ('vigente', 'concluido', 'cancelado');

-- AlterTable
ALTER TABLE "FinancialRecords" ADD COLUMN     "contractId" INTEGER,
ADD COLUMN     "contractInstallmentId" INTEGER;

-- CreateTable
CREATE TABLE "Commercial_Contract" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "kind" "CommercialProposalKind" NOT NULL,
    "status" "CommercialContractStatus" NOT NULL DEFAULT 'vigente',
    "title" VARCHAR(200) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "documentHtml" TEXT,
    "documentHash" VARCHAR(64),
    "signer" JSONB,
    "sellerId" INTEGER,
    "classes" JSONB,
    "notes" TEXT,
    "statusNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Commercial_Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_ContractInstallment" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "contractId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "description" VARCHAR(200),
    "value" DECIMAL(14,2) NOT NULL,
    "dueRule" "CommercialDueRule" NOT NULL,
    "dueDate" DATE,
    "dueDays" INTEGER,
    "financialRecordId" INTEGER,
    "billedAt" TIMESTAMP(3),

    CONSTRAINT "Commercial_ContractInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_Contract_proposalId_key" ON "Commercial_Contract"("proposalId");

-- CreateIndex
CREATE INDEX "Commercial_Contract_companyId_status_idx" ON "Commercial_Contract"("companyId", "status");

-- CreateIndex
CREATE INDEX "Commercial_Contract_companyId_customerId_idx" ON "Commercial_Contract"("companyId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_Contract_companyId_number_key" ON "Commercial_Contract"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_ContractInstallment_financialRecordId_key" ON "Commercial_ContractInstallment"("financialRecordId");

-- CreateIndex
CREATE INDEX "Commercial_ContractInstallment_contractId_idx" ON "Commercial_ContractInstallment"("contractId");

-- CreateIndex
CREATE INDEX "FinancialRecords_contractId_idx" ON "FinancialRecords"("contractId");

-- AddForeignKey
ALTER TABLE "Commercial_Contract" ADD CONSTRAINT "Commercial_Contract_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commercial_ContractInstallment" ADD CONSTRAINT "Commercial_ContractInstallment_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Commercial_Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

