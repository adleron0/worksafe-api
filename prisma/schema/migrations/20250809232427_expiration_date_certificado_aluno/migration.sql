/*
  Warnings:

  - You are about to drop the column `yearsOfValidity` on the `TraineeCourseCertificate` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."TraineeCourseCertificate" DROP COLUMN "yearsOfValidity",
ADD COLUMN     "expirationDate" TIMESTAMP(3);
