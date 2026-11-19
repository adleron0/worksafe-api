-- Plano 08, fases 2 a 4: proposta de locação, ordem de locação (OL) e faturamento por medição.

-- AlterTable
ALTER TABLE "Commercial_Activity" ADD COLUMN     "autoKey" VARCHAR(60),
ADD COLUMN     "rentalId" INTEGER;

-- AlterTable
ALTER TABLE "Commercial_Contract" ADD COLUMN     "billingMode" VARCHAR(10) NOT NULL DEFAULT 'parcelas';

-- AlterTable
ALTER TABLE "Commercial_Proposal" ADD COLUMN     "rental" JSONB;

-- AlterTable
ALTER TABLE "FinancialRecords" ADD COLUMN     "measurementId" INTEGER;

-- AlterTable
ALTER TABLE "Stock_Rental" ADD COLUMN     "periods" INTEGER;

-- AlterTable
ALTER TABLE "Stock_RentalCharge" ADD COLUMN     "measurementId" INTEGER,
ADD COLUMN     "payableId" INTEGER;

-- CreateTable
CREATE TABLE "Commercial_Measurement" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "contractId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "rentalId" INTEGER,
    "periodStart" DATE,
    "periodEnd" DATE,
    "value" DECIMAL(14,2) NOT NULL,
    "lines" JSONB NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'faturada',
    "financialRecordId" INTEGER,
    "invoiceNumber" VARCHAR(60),
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commercial_Measurement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Commercial_Measurement_contractId_idx" ON "Commercial_Measurement"("contractId");

-- CreateIndex
CREATE INDEX "Commercial_Measurement_rentalId_idx" ON "Commercial_Measurement"("rentalId");

-- CreateIndex
CREATE INDEX "Commercial_Activity_rentalId_idx" ON "Commercial_Activity"("rentalId");

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_Activity_companyId_autoKey_key" ON "Commercial_Activity"("companyId", "autoKey");

-- CreateIndex
CREATE INDEX "FinancialRecords_measurementId_idx" ON "FinancialRecords"("measurementId");

-- AddForeignKey
ALTER TABLE "Commercial_Measurement" ADD CONSTRAINT "Commercial_Measurement_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Commercial_Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- A locação passa a se chamar Ordem de Locação: LOC-2026-0001 vira OL-2026-0001.
UPDATE "Stock_Rental" SET "number" = 'OL-' || substr("number", 5) WHERE "number" LIKE 'LOC-%';
