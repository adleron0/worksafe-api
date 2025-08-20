-- CreateEnum
CREATE TYPE "public"."gateways" AS ENUM ('asaas', 'stripe', 'efi', 'mercadoPago', 'pagSeguro', 'paypal');

-- CreateEnum
CREATE TYPE "public"."paymentMethods" AS ENUM ('cartaoCredito', 'boleto', 'pix');

-- CreateEnum
CREATE TYPE "public"."financialRecordsStatus" AS ENUM ('processing', 'waiting', 'received', 'declined', 'chargeback', 'cancelled', 'overdue');

-- CreateTable
CREATE TABLE "public"."CompanyGateWays" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "gateway" "public"."gateways" NOT NULL,
    "payload" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CompanyGateWays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FinancialRecords" (
    "id" SERIAL NOT NULL,
    "accrualDate" VARCHAR(10) NOT NULL,
    "companyId" INTEGER NOT NULL,
    "gateway" "public"."gateways" NOT NULL,
    "status" "public"."financialRecordsStatus" NOT NULL DEFAULT 'processing',
    "subscriptionId" INTEGER,
    "traineeId" INTEGER,
    "customerId" INTEGER,
    "paymentMethod" "public"."paymentMethods" NOT NULL,
    "value" DECIMAL(18,2),
    "dueDate" TIMESTAMP(3),
    "paiedAt" TIMESTAMP(3),
    "billUrl" VARCHAR(255),
    "billNumber" VARCHAR(255),
    "pixUrl" VARCHAR(255),
    "pixNumber" VARCHAR(255),
    "request_data" JSONB,
    "response_data" JSONB,
    "error_data" JSONB,
    "observations" VARCHAR(255),
    "description" VARCHAR(255),
    "externalId" VARCHAR(255),
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "FinancialRecords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Webhooks" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "gateway" "public"."gateways" NOT NULL,
    "payload" JSONB,
    "error" JSONB,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Webhooks_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."CompanyGateWays" ADD CONSTRAINT "CompanyGateWays_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FinancialRecords" ADD CONSTRAINT "FinancialRecords_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FinancialRecords" ADD CONSTRAINT "FinancialRecords_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "public"."CourseClassSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FinancialRecords" ADD CONSTRAINT "FinancialRecords_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "public"."Trainee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FinancialRecords" ADD CONSTRAINT "FinancialRecords_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Webhooks" ADD CONSTRAINT "Webhooks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
