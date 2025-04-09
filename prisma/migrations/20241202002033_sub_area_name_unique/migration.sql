/*
  Warnings:

  - A unique constraint covering the columns `[name,areaId]` on the table `SubArea` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `name` to the `SubArea` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "SubArea_areaId_key";

-- AlterTable
ALTER TABLE "SubArea" ADD COLUMN     "name" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "SubArea_id_areaId_idx" ON "SubArea"("id", "areaId");

-- CreateIndex
CREATE UNIQUE INDEX "SubArea_name_areaId_key" ON "SubArea"("name", "areaId");
