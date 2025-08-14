/*
  Warnings:

  - You are about to drop the column `active` on the `TraineeCourseCertificate` table. All the data in the column will be lost.
  - You are about to drop the column `conformity` on the `TraineeCourseCertificate` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `TraineeCourseCertificate` table. All the data in the column will be lost.
  - You are about to drop the column `imageUrl` on the `TraineeCourseCertificate` table. All the data in the column will be lost.
  - You are about to drop the column `objective` on the `TraineeCourseCertificate` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."TraineeCourseCertificate" DROP COLUMN "active",
DROP COLUMN "conformity",
DROP COLUMN "description",
DROP COLUMN "imageUrl",
DROP COLUMN "objective",
ADD COLUMN     "pdfUrl" VARCHAR(255);
