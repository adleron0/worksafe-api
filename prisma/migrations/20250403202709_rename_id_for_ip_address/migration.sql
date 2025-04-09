/*
  Warnings:

  - You are about to drop the column `idAddress` on the `System_Logs` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "System_Logs" DROP COLUMN "idAddress",
ADD COLUMN     "ipAddress" TEXT;
