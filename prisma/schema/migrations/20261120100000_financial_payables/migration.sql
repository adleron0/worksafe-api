-- Fornecedores e contas a pagar.
CREATE TABLE "Financial_Supplier" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "legalName" VARCHAR(200),
    "document" VARCHAR(14),
    "supplies" VARCHAR(255),
    "contactName" VARCHAR(120),
    "email" VARCHAR(160),
    "phone" VARCHAR(30),
    "pixKey" VARCHAR(140),
    "bankName" VARCHAR(120),
    "agency" VARCHAR(20),
    "account" VARCHAR(30),
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Financial_Supplier_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Financial_Supplier_companyId_name_idx" ON "Financial_Supplier"("companyId", "name");
CREATE INDEX "Financial_Supplier_companyId_document_idx" ON "Financial_Supplier"("companyId", "document");

CREATE TABLE "Financial_Payable" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "supplierId" INTEGER,
    "description" VARCHAR(255) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "accrualDate" VARCHAR(7) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'aberta',
    "documentNumber" VARCHAR(60),
    "paymentMethod" VARCHAR(20),
    "installmentNumber" INTEGER,
    "installmentTotal" INTEGER,
    "groupKey" VARCHAR(40),
    "origin" VARCHAR(20) NOT NULL DEFAULT 'manual',
    "serviceOrderId" INTEGER,
    "purchaseOrderId" INTEGER,
    "chartAccountId" INTEGER,
    "costCenterId" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paidValue" DECIMAL(18,2),
    "bankAccountId" INTEGER,
    "settledByUserId" INTEGER,
    "billUrl" TEXT,
    "invoiceUrl" TEXT,
    "receiptUrl" TEXT,
    "observations" VARCHAR(500),
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Financial_Payable_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Financial_Payable_companyId_status_dueDate_idx" ON "Financial_Payable"("companyId", "status", "dueDate");
CREATE INDEX "Financial_Payable_companyId_accrualDate_idx" ON "Financial_Payable"("companyId", "accrualDate");
CREATE INDEX "Financial_Payable_companyId_supplierId_idx" ON "Financial_Payable"("companyId", "supplierId");
CREATE INDEX "Financial_Payable_companyId_serviceOrderId_idx" ON "Financial_Payable"("companyId", "serviceOrderId");
CREATE INDEX "Financial_Payable_groupKey_idx" ON "Financial_Payable"("groupKey");

ALTER TABLE "Financial_Payable" ADD CONSTRAINT "Financial_Payable_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Financial_Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Financial_Payable" ADD CONSTRAINT "Financial_Payable_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "Service_Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Financial_Payable" ADD CONSTRAINT "Financial_Payable_chartAccountId_fkey" FOREIGN KEY ("chartAccountId") REFERENCES "Financial_ChartAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Financial_Payable" ADD CONSTRAINT "Financial_Payable_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "Financial_CostCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Financial_Payable" ADD CONSTRAINT "Financial_Payable_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "Financial_BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
