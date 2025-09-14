-- CreateEnum
CREATE TYPE "public"."sellerStatusTypes" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "public"."DiscountType" AS ENUM ('percentage', 'fixed');

-- CreateEnum
CREATE TYPE "public"."CommissionType" AS ENUM ('percentage', 'fixed');

-- CreateEnum
CREATE TYPE "public"."SplitStatus" AS ENUM ('PENDING', 'PROCESSING', 'CONFIRMED', 'SETTLED', 'WITHDRAWN', 'FAILED', 'CANCELLED', 'REFUNDED', 'BLOCKED');

-- AlterTable
ALTER TABLE "public"."FinancialRecords" ADD COLUMN     "commissionValue" DECIMAL(18,2),
ADD COLUMN     "couponId" INTEGER,
ADD COLUMN     "discountApplied" DECIMAL(18,2),
ADD COLUMN     "sellerId" INTEGER;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "isSeller" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sellerActivatedAt" TIMESTAMP(3),
ADD COLUMN     "sellerConfig" JSONB,
ADD COLUMN     "sellerStatus" "public"."sellerStatusTypes" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "public"."Coupon" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "description" VARCHAR(255),
    "sellerId" INTEGER,
    "discountType" "public"."DiscountType" NOT NULL DEFAULT 'percentage',
    "discountValue" DECIMAL(10,2) NOT NULL,
    "commissionType" "public"."CommissionType" DEFAULT 'percentage',
    "commissionValue" DECIMAL(10,2),
    "minPurchaseValue" DECIMAL(10,2),
    "maxDiscountValue" DECIMAL(10,2),
    "usageLimit" INTEGER,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "usagePerCustomer" INTEGER NOT NULL DEFAULT 1,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "firstPurchaseOnly" BOOLEAN NOT NULL DEFAULT false,
    "classId" INTEGER,
    "courseId" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "companyId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SplitTransaction" (
    "id" SERIAL NOT NULL,
    "financialRecordId" INTEGER NOT NULL,
    "toWalletId" VARCHAR(100) NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "originalValue" DECIMAL(18,2) NOT NULL,
    "splitValue" DECIMAL(18,2) NOT NULL,
    "splitPercentage" DECIMAL(5,2),
    "netValue" DECIMAL(18,2) NOT NULL,
    "splitDescription" VARCHAR(255),
    "status" "public"."SplitStatus" NOT NULL DEFAULT 'PENDING',
    "asaasSplitId" VARCHAR(100),
    "asaasTransferId" VARCHAR(100),
    "processedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "hasDivergence" BOOLEAN NOT NULL DEFAULT false,
    "divergenceReason" VARCHAR(255),
    "divergenceResolvedAt" TIMESTAMP(3),
    "gatewayResponse" JSONB,
    "companyId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SplitTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Coupon_sellerId_idx" ON "public"."Coupon"("sellerId");

-- CreateIndex
CREATE INDEX "Coupon_active_validFrom_validUntil_idx" ON "public"."Coupon"("active", "validFrom", "validUntil");

-- CreateIndex
CREATE INDEX "Coupon_companyId_active_idx" ON "public"."Coupon"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_companyId_key" ON "public"."Coupon"("code", "companyId");

-- CreateIndex
CREATE INDEX "SplitTransaction_financialRecordId_idx" ON "public"."SplitTransaction"("financialRecordId");

-- CreateIndex
CREATE INDEX "SplitTransaction_sellerId_status_idx" ON "public"."SplitTransaction"("sellerId", "status");

-- CreateIndex
CREATE INDEX "SplitTransaction_status_processedAt_idx" ON "public"."SplitTransaction"("status", "processedAt");

-- CreateIndex
CREATE INDEX "SplitTransaction_companyId_createdAt_idx" ON "public"."SplitTransaction"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "SplitTransaction_toWalletId_idx" ON "public"."SplitTransaction"("toWalletId");

-- CreateIndex
CREATE INDEX "SplitTransaction_asaasSplitId_idx" ON "public"."SplitTransaction"("asaasSplitId");

-- CreateIndex
CREATE INDEX "SplitTransaction_settledAt_sellerId_idx" ON "public"."SplitTransaction"("settledAt", "sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "SplitTransaction_financialRecordId_sellerId_key" ON "public"."SplitTransaction"("financialRecordId", "sellerId");

-- CreateIndex
CREATE INDEX "CourseClass_companyId_active_idx" ON "public"."CourseClass"("companyId", "active");

-- CreateIndex
CREATE INDEX "CourseClass_courseId_active_idx" ON "public"."CourseClass"("courseId", "active");

-- CreateIndex
CREATE INDEX "CourseClass_customerId_idx" ON "public"."CourseClass"("customerId");

-- CreateIndex
CREATE INDEX "CourseClass_allowCheckout_active_idx" ON "public"."CourseClass"("allowCheckout", "active");

-- CreateIndex
CREATE INDEX "CourseClass_periodClass_active_idx" ON "public"."CourseClass"("periodClass", "active");

-- CreateIndex
CREATE INDEX "CourseClass_initialDate_finalDate_idx" ON "public"."CourseClass"("initialDate", "finalDate");

-- CreateIndex
CREATE INDEX "CourseClassExam_traineeId_courseId_idx" ON "public"."CourseClassExam"("traineeId", "courseId");

-- CreateIndex
CREATE INDEX "CourseClassExam_classId_result_idx" ON "public"."CourseClassExam"("classId", "result");

-- CreateIndex
CREATE INDEX "CourseClassExam_companyId_createdAt_idx" ON "public"."CourseClassExam"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_cpf_idx" ON "public"."CourseClassSubscription"("cpf");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_email_idx" ON "public"."CourseClassSubscription"("email");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_classId_subscribeStatus_idx" ON "public"."CourseClassSubscription"("classId", "subscribeStatus");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_traineeId_idx" ON "public"."CourseClassSubscription"("traineeId");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_companyId_subscribeStatus_idx" ON "public"."CourseClassSubscription"("companyId", "subscribeStatus");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_createdAt_idx" ON "public"."CourseClassSubscription"("createdAt");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_phone_idx" ON "public"."CourseClassSubscription"("phone");

-- CreateIndex
CREATE INDEX "FinancialRecords_companyId_status_idx" ON "public"."FinancialRecords"("companyId", "status");

-- CreateIndex
CREATE INDEX "FinancialRecords_status_paidAt_idx" ON "public"."FinancialRecords"("status", "paidAt");

-- CreateIndex
CREATE INDEX "FinancialRecords_traineeId_idx" ON "public"."FinancialRecords"("traineeId");

-- CreateIndex
CREATE INDEX "FinancialRecords_subscriptionId_idx" ON "public"."FinancialRecords"("subscriptionId");

-- CreateIndex
CREATE INDEX "FinancialRecords_externalId_idx" ON "public"."FinancialRecords"("externalId");

-- CreateIndex
CREATE INDEX "FinancialRecords_accrualDate_companyId_idx" ON "public"."FinancialRecords"("accrualDate", "companyId");

-- CreateIndex
CREATE INDEX "FinancialRecords_couponId_status_idx" ON "public"."FinancialRecords"("couponId", "status");

-- CreateIndex
CREATE INDEX "FinancialRecords_sellerId_status_idx" ON "public"."FinancialRecords"("sellerId", "status");

-- CreateIndex
CREATE INDEX "FinancialRecords_gateway_status_idx" ON "public"."FinancialRecords"("gateway", "status");

-- CreateIndex
CREATE INDEX "FinancialRecords_createdAt_idx" ON "public"."FinancialRecords"("createdAt");

-- CreateIndex
CREATE INDEX "Trainee_email_idx" ON "public"."Trainee"("email");

-- CreateIndex
CREATE INDEX "Trainee_customerId_idx" ON "public"."Trainee"("customerId");

-- CreateIndex
CREATE INDEX "Trainee_active_idx" ON "public"."Trainee"("active");

-- CreateIndex
CREATE INDEX "Trainee_cpf_idx" ON "public"."Trainee"("cpf");

-- CreateIndex
CREATE INDEX "Trainee_name_idx" ON "public"."Trainee"("name");

-- CreateIndex
CREATE INDEX "TraineeCompany_companyId_idx" ON "public"."TraineeCompany"("companyId");

-- CreateIndex
CREATE INDEX "TraineeCourseCertificate_traineeId_idx" ON "public"."TraineeCourseCertificate"("traineeId");

-- CreateIndex
CREATE INDEX "TraineeCourseCertificate_courseId_idx" ON "public"."TraineeCourseCertificate"("courseId");

-- CreateIndex
CREATE INDEX "TraineeCourseCertificate_classId_idx" ON "public"."TraineeCourseCertificate"("classId");

-- CreateIndex
CREATE INDEX "TraineeCourseCertificate_companyId_idx" ON "public"."TraineeCourseCertificate"("companyId");

-- CreateIndex
CREATE INDEX "TraineeCourseCertificate_expirationDate_idx" ON "public"."TraineeCourseCertificate"("expirationDate");

-- CreateIndex
CREATE INDEX "TraineeCourseCertificate_key_idx" ON "public"."TraineeCourseCertificate"("key");

-- AddForeignKey
ALTER TABLE "public"."Coupon" ADD CONSTRAINT "Coupon_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Coupon" ADD CONSTRAINT "Coupon_classId_fkey" FOREIGN KEY ("classId") REFERENCES "public"."CourseClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Coupon" ADD CONSTRAINT "Coupon_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "public"."Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Coupon" ADD CONSTRAINT "Coupon_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FinancialRecords" ADD CONSTRAINT "FinancialRecords_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "public"."Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FinancialRecords" ADD CONSTRAINT "FinancialRecords_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SplitTransaction" ADD CONSTRAINT "SplitTransaction_financialRecordId_fkey" FOREIGN KEY ("financialRecordId") REFERENCES "public"."FinancialRecords"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SplitTransaction" ADD CONSTRAINT "SplitTransaction_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SplitTransaction" ADD CONSTRAINT "SplitTransaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
