/*
  Warnings:

  - Made the column `companyId` on table `DOM_Ranks` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "DOM_Ranks" ALTER COLUMN "companyId" SET NOT NULL;
