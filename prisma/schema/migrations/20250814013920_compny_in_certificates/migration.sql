/*
  Warnings:

  - Added the required column `companyId` to the `TraineeCourseCertificate` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."TraineeCourseCertificate" ADD COLUMN     "companyId" INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."TraineeCourseCertificate" ADD CONSTRAINT "TraineeCourseCertificate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
