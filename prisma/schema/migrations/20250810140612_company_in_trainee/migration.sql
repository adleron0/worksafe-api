/*
  Warnings:

  - Added the required column `companyId` to the `Trainee` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."Trainee" ADD COLUMN     "companyId" INTEGER NOT NULL;
