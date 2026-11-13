-- CreateEnum
CREATE TYPE "CommercialCostItemGroup" AS ENUM ('encargo', 'pessoal_indireto', 'outro_custo');

-- CreateEnum
CREATE TYPE "CommercialCostItemKind" AS ENUM ('fixo', 'por_pessoa');

-- CreateEnum
CREATE TYPE "CommercialTaxRegime" AS ENUM ('tradicional', 'hibrido');

-- CreateEnum
CREATE TYPE "CommercialTaxMode" AS ENUM ('nominal', 'efetiva', 'manual');

-- CreateTable
CREATE TABLE "Commercial_CostBase" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "notes" VARCHAR(500),
    "daysInYear" INTEGER NOT NULL DEFAULT 365,
    "restDays" INTEGER NOT NULL DEFAULT 88,
    "vacationDays" INTEGER NOT NULL DEFAULT 30,
    "holidays" INTEGER NOT NULL DEFAULT 15,
    "hoursPerDay" DECIMAL(6,2) NOT NULL DEFAULT 8,
    "idleRate" DECIMAL(7,6) NOT NULL DEFAULT 0.1,
    "monthsDivisor" INTEGER NOT NULL DEFAULT 11,
    "weeklyHours" DECIMAL(6,2) NOT NULL DEFAULT 44,
    "additionalDivisor" DECIMAL(8,2) NOT NULL DEFAULT 220,
    "nightRate" DECIMAL(7,6) NOT NULL DEFAULT 0.2,
    "travelRate" DECIMAL(7,6) NOT NULL DEFAULT 0.25,
    "weekendRate" DECIMAL(7,6) NOT NULL DEFAULT 2,
    "weekendPerWorker" BOOLEAN NOT NULL DEFAULT false,
    "mealPerDay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transportFare" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transportTrips" DECIMAL(6,2) NOT NULL DEFAULT 6,
    "transportDiscount" DECIMAL(7,6) NOT NULL DEFAULT 0.6,
    "fareDiscountRate" DECIMAL(7,6) NOT NULL DEFAULT 0.06,
    "headcount" DECIMAL(8,2) NOT NULL DEFAULT 1,
    "defaults" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Commercial_CostBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_CostBaseItem" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "costBaseId" INTEGER NOT NULL,
    "group" "CommercialCostItemGroup" NOT NULL,
    "subgroup" VARCHAR(80),
    "name" VARCHAR(160) NOT NULL,
    "rate" DECIMAL(9,6),
    "amount" DECIMAL(14,2),
    "quantity" DECIMAL(8,2) NOT NULL DEFAULT 1,
    "withCharges" BOOLEAN NOT NULL DEFAULT true,
    "kind" "CommercialCostItemKind" NOT NULL DEFAULT 'fixo',
    "isDebt" BOOLEAN NOT NULL DEFAULT false,
    "endsAt" DATE,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Commercial_CostBaseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_Professional" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "salary" DECIMAL(12,2) NOT NULL,
    "notes" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Commercial_Professional_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_TaxProfile" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "regime" "CommercialTaxRegime" NOT NULL DEFAULT 'tradicional',
    "effectiveFrom" DATE NOT NULL,
    "mode" "CommercialTaxMode" NOT NULL DEFAULT 'nominal',
    "rbt12" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "manualRate" DECIMAL(7,6),
    "ibsCbsShare" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "outsideRate" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "brackets" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Commercial_TaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Commercial_CostBase_companyId_effectiveFrom_idx" ON "Commercial_CostBase"("companyId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "Commercial_CostBaseItem_costBaseId_group_idx" ON "Commercial_CostBaseItem"("costBaseId", "group");

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_Professional_companyId_name_key" ON "Commercial_Professional"("companyId", "name");

-- CreateIndex
CREATE INDEX "Commercial_TaxProfile_companyId_effectiveFrom_idx" ON "Commercial_TaxProfile"("companyId", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "Commercial_CostBaseItem" ADD CONSTRAINT "Commercial_CostBaseItem_costBaseId_fkey" FOREIGN KEY ("costBaseId") REFERENCES "Commercial_CostBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

