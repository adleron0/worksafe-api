-- Vagas de turma aberta compradas por empresa: reserva de vagas e a empresa
-- contratante na inscrição (é o que sai no certificado).
-- AlterTable
ALTER TABLE "CourseClassSubscription" ADD COLUMN     "contractId" INTEGER,
ADD COLUMN     "customerId" INTEGER,
ADD COLUMN     "origin" VARCHAR(20),
ADD COLUMN     "reservationId" INTEGER;

-- CreateTable
CREATE TABLE "CourseClassReservation" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "classId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "contractId" INTEGER,
    "contractSlotIndex" INTEGER,
    "seats" INTEGER NOT NULL,
    "unitValue" DECIMAL(18,2),
    "notes" VARCHAR(300),
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),
    "cancelReason" VARCHAR(300),

    CONSTRAINT "CourseClassReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourseClassReservation_classId_inactiveAt_idx" ON "CourseClassReservation"("classId", "inactiveAt");

-- CreateIndex
CREATE INDEX "CourseClassReservation_contractId_idx" ON "CourseClassReservation"("contractId");

-- CreateIndex
CREATE INDEX "CourseClassReservation_customerId_idx" ON "CourseClassReservation"("customerId");

-- CreateIndex
CREATE INDEX "CourseClassReservation_companyId_inactiveAt_idx" ON "CourseClassReservation"("companyId", "inactiveAt");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_reservationId_idx" ON "CourseClassSubscription"("reservationId");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_customerId_idx" ON "CourseClassSubscription"("customerId");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_contractId_idx" ON "CourseClassSubscription"("contractId");

-- AddForeignKey
ALTER TABLE "CourseClassReservation" ADD CONSTRAINT "CourseClassReservation_classId_fkey" FOREIGN KEY ("classId") REFERENCES "CourseClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseClassReservation" ADD CONSTRAINT "CourseClassReservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseClassSubscription" ADD CONSTRAINT "CourseClassSubscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseClassSubscription" ADD CONSTRAINT "CourseClassSubscription_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "CourseClassReservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

