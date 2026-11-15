-- AlterTable
ALTER TABLE "FinancialRecords" ADD COLUMN     "discountValue" DECIMAL(18,2),
ADD COLUMN     "fineValue" DECIMAL(18,2),
ADD COLUMN     "interestValue" DECIMAL(18,2),
ADD COLUMN     "receiptUrl" TEXT,
ADD COLUMN     "recurrenceId" INTEGER,
ADD COLUMN     "statementRef" VARCHAR(80);

-- AlterTable
ALTER TABLE "Financial_Payable" ADD COLUMN     "barcode" VARCHAR(60),
ADD COLUMN     "discountValue" DECIMAL(18,2),
ADD COLUMN     "fineValue" DECIMAL(18,2),
ADD COLUMN     "interestValue" DECIMAL(18,2),
ADD COLUMN     "pixCode" TEXT,
ADD COLUMN     "recurrenceId" INTEGER,
ADD COLUMN     "statementRef" VARCHAR(80);

-- CreateTable
CREATE TABLE "Financial_Recurrence" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "dayOfMonth" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "generatedUntil" TIMESTAMP(3),
    "supplierId" INTEGER,
    "customerId" INTEGER,
    "chartAccountId" INTEGER,
    "costCenterId" INTEGER,
    "serviceOrderId" INTEGER,
    "paymentMethod" VARCHAR(20),
    "observations" VARCHAR(500),
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Financial_Recurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Financial_Transfer" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "fromBankAccountId" INTEGER NOT NULL,
    "toBankAccountId" INTEGER NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" VARCHAR(255),
    "statementRef" VARCHAR(80),
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Financial_Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Financial_Recurrence_companyId_kind_idx" ON "Financial_Recurrence"("companyId", "kind");

-- CreateIndex
CREATE INDEX "Financial_Transfer_companyId_date_idx" ON "Financial_Transfer"("companyId", "date");

-- CreateIndex
CREATE INDEX "FinancialRecords_companyId_dueDate_idx" ON "FinancialRecords"("companyId", "dueDate");

-- CreateIndex
CREATE INDEX "FinancialRecords_recurrenceId_idx" ON "FinancialRecords"("recurrenceId");

-- CreateIndex
CREATE INDEX "Financial_Payable_companyId_recurrenceId_idx" ON "Financial_Payable"("companyId", "recurrenceId");

-- AddForeignKey
ALTER TABLE "Financial_Payable" ADD CONSTRAINT "Financial_Payable_recurrenceId_fkey" FOREIGN KEY ("recurrenceId") REFERENCES "Financial_Recurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Financial_Transfer" ADD CONSTRAINT "Financial_Transfer_fromBankAccountId_fkey" FOREIGN KEY ("fromBankAccountId") REFERENCES "Financial_BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Financial_Transfer" ADD CONSTRAINT "Financial_Transfer_toBankAccountId_fkey" FOREIGN KEY ("toBankAccountId") REFERENCES "Financial_BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialRecords" ADD CONSTRAINT "FinancialRecords_recurrenceId_fkey" FOREIGN KEY ("recurrenceId") REFERENCES "Financial_Recurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

