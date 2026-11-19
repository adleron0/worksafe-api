-- AlterTable
ALTER TABLE "Commercial_Proposal" ADD COLUMN     "dealDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "dealId" INTEGER;

-- AlterTable
ALTER TABLE "Commercial_Activity" ADD COLUMN     "dealId" INTEGER;

-- AlterTable
ALTER TABLE "Purchase_Order" ADD COLUMN     "classId" INTEGER,
ADD COLUMN     "rentalId" INTEGER;

-- CreateTable
CREATE TABLE "Commercial_Deal" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "sellerId" INTEGER,
    "notes" TEXT,
    "discountEnabled" BOOLEAN NOT NULL DEFAULT false,
    "discountType" VARCHAR(12) NOT NULL DEFAULT 'percentual',
    "discountValue" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "discountSplit" VARCHAR(12) NOT NULL DEFAULT 'proporcional',
    "discountManual" JSONB,
    "discountTargets" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "discountCondition" VARCHAR(14) NOT NULL DEFAULT 'incondicional',
    "requiredIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "onBreak" VARCHAR(12) NOT NULL DEFAULT 'avisar',
    "breach" JSONB,
    "discountAppliedAt" TIMESTAMP(3),
    "publicKey" VARCHAR(64),
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Commercial_Deal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_Deal_publicKey_key" ON "Commercial_Deal"("publicKey");

-- CreateIndex
CREATE INDEX "Commercial_Deal_companyId_customerId_idx" ON "Commercial_Deal"("companyId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_Deal_companyId_number_key" ON "Commercial_Deal"("companyId", "number");

-- CreateIndex
CREATE INDEX "Commercial_Proposal_dealId_idx" ON "Commercial_Proposal"("dealId");

-- CreateIndex
CREATE INDEX "Purchase_Order_companyId_rentalId_idx" ON "Purchase_Order"("companyId", "rentalId");

-- CreateIndex
CREATE INDEX "Purchase_Order_companyId_classId_idx" ON "Purchase_Order"("companyId", "classId");

