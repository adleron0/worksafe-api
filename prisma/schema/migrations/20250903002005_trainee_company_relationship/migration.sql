-- CreateTable
CREATE TABLE "public"."TraineeCompany" (
    "id" SERIAL NOT NULL,
    "traineeId" INTEGER NOT NULL,
    "companyId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TraineeCompany_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TraineeCompany_traineeId_companyId_key" ON "public"."TraineeCompany"("traineeId", "companyId");

-- AddForeignKey
ALTER TABLE "public"."TraineeCompany" ADD CONSTRAINT "TraineeCompany_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "public"."Trainee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TraineeCompany" ADD CONSTRAINT "TraineeCompany_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
