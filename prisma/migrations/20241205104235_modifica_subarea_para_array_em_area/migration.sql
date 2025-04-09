/*
  Warnings:

  - You are about to drop the `SubArea` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Confinus_ConfinedSpace" DROP CONSTRAINT "Confinus_ConfinedSpace_subAreaId_fkey";

-- DropForeignKey
ALTER TABLE "SubArea" DROP CONSTRAINT "SubArea_areaId_fkey";

-- AlterTable
ALTER TABLE "Area" ADD COLUMN     "subAreas" TEXT[];

-- AlterTable
ALTER TABLE "Confinus_ConfinedSpace" ADD COLUMN     "subArea" TEXT;

-- DropTable
DROP TABLE "SubArea";
