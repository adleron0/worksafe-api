/*
  Warnings:

  - You are about to drop the column `subAreas` on the `Area` table. All the data in the column will be lost.
  - You are about to drop the column `subArea` on the `Confinus_ConfinedSpace` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Area" DROP COLUMN "subAreas";

-- AlterTable
ALTER TABLE "Confinus_ConfinedSpace" DROP COLUMN "subArea";

-- CreateTable
CREATE TABLE "SubArea" (
    "id" SERIAL NOT NULL,
    "areaId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "SubArea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubArea_id_areaId_idx" ON "SubArea"("id", "areaId");

-- CreateIndex
CREATE UNIQUE INDEX "SubArea_name_areaId_key" ON "SubArea"("name", "areaId");

-- AddForeignKey
ALTER TABLE "SubArea" ADD CONSTRAINT "SubArea_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_subAreaId_fkey" FOREIGN KEY ("subAreaId") REFERENCES "SubArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;
