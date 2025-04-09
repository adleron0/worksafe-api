/*
  Warnings:

  - You are about to drop the `Confinus_DOM_ConstructionMaterial` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Confinus_ConfinedSpace" DROP CONSTRAINT "Confinus_ConfinedSpace_constructionMaterialId_fkey";

-- DropForeignKey
ALTER TABLE "Confinus_DOM_ConstructionMaterial" DROP CONSTRAINT "Confinus_DOM_ConstructionMaterial_companyId_fkey";

-- DropTable
DROP TABLE "Confinus_DOM_ConstructionMaterial";

-- CreateTable
CREATE TABLE "DOM_ConstructionMaterial" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "DOM_ConstructionMaterial_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DOM_ConstructionMaterial" ADD CONSTRAINT "DOM_ConstructionMaterial_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_constructionMaterialId_fkey" FOREIGN KEY ("constructionMaterialId") REFERENCES "DOM_ConstructionMaterial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
