-- CreateEnum
CREATE TYPE "ChartAccountNature" AS ENUM ('receita', 'despesa');

-- CreateEnum
CREATE TYPE "BankAccountType" AS ENUM ('corrente', 'poupanca', 'caixa', 'gateway');

-- AlterTable
ALTER TABLE "FinancialRecords" ADD COLUMN     "bankAccountId" INTEGER,
ADD COLUMN     "chartAccountId" INTEGER,
ADD COLUMN     "costCenterId" INTEGER;

-- CreateTable
CREATE TABLE "Financial_ChartAccount" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "parentId" INTEGER,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "nature" "ChartAccountNature" NOT NULL,
    "level" INTEGER NOT NULL,
    "acceptsEntries" BOOLEAN NOT NULL DEFAULT true,
    "dreGroup" VARCHAR(40),
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Financial_ChartAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Financial_CostCenter" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(20),
    "description" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Financial_CostCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Financial_BankAccount" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "BankAccountType" NOT NULL DEFAULT 'corrente',
    "bankCode" VARCHAR(10),
    "bankName" VARCHAR(120),
    "agency" VARCHAR(20),
    "agencyDigit" VARCHAR(5),
    "account" VARCHAR(30),
    "accountDigit" VARCHAR(5),
    "pixKey" VARCHAR(140),
    "holderName" VARCHAR(255),
    "holderDocument" VARCHAR(20),
    "openingBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "openingBalanceDate" TIMESTAMP(3),
    "gateway" "gateways",
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Financial_BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Financial_ClassificationDefault" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "origin" VARCHAR(40) NOT NULL,
    "chartAccountId" INTEGER,
    "costCenterId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Financial_ClassificationDefault_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Financial_ChartAccount_companyId_parentId_idx" ON "Financial_ChartAccount"("companyId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Financial_ChartAccount_companyId_code_key" ON "Financial_ChartAccount"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Financial_CostCenter_companyId_name_key" ON "Financial_CostCenter"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Financial_BankAccount_companyId_name_key" ON "Financial_BankAccount"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Financial_ClassificationDefault_companyId_origin_key" ON "Financial_ClassificationDefault"("companyId", "origin");

-- CreateIndex
CREATE INDEX "FinancialRecords_chartAccountId_idx" ON "FinancialRecords"("chartAccountId");

-- CreateIndex
CREATE INDEX "FinancialRecords_costCenterId_idx" ON "FinancialRecords"("costCenterId");

-- CreateIndex
CREATE INDEX "FinancialRecords_bankAccountId_idx" ON "FinancialRecords"("bankAccountId");

-- AddForeignKey
ALTER TABLE "Financial_ChartAccount" ADD CONSTRAINT "Financial_ChartAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Financial_ChartAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Financial_ClassificationDefault" ADD CONSTRAINT "Financial_ClassificationDefault_chartAccountId_fkey" FOREIGN KEY ("chartAccountId") REFERENCES "Financial_ChartAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Financial_ClassificationDefault" ADD CONSTRAINT "Financial_ClassificationDefault_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "Financial_CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialRecords" ADD CONSTRAINT "FinancialRecords_chartAccountId_fkey" FOREIGN KEY ("chartAccountId") REFERENCES "Financial_ChartAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialRecords" ADD CONSTRAINT "FinancialRecords_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "Financial_CostCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialRecords" ADD CONSTRAINT "FinancialRecords_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "Financial_BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

