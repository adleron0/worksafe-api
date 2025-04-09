/*
  Warnings:

  - You are about to drop the column `antityId` on the `System_Logs` table. All the data in the column will be lost.
  - Added the required column `entityId` to the `System_Logs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "System_Logs" DROP COLUMN "antityId",
ADD COLUMN     "entityId" INTEGER NOT NULL;
