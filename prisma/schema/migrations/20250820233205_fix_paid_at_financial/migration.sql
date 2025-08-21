/*
  Warnings:

  - You are about to drop the column `paiedAt` on the `FinancialRecords` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."FinancialRecords" DROP COLUMN "paiedAt",
ADD COLUMN     "paidAt" TIMESTAMP(3);
