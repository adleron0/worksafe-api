-- CreateTable
CREATE TABLE "Confinus_DOM_SeverityDefinition" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "description" TEXT,
    "classification" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Confinus_DOM_SeverityDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubArea" (
    "id" SERIAL NOT NULL,
    "areaId" INTEGER NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "SubArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DOM_Equipaments" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "DOM_Equipaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessEquipment" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "equipamentId" INTEGER NOT NULL,
    "manHoleId" INTEGER NOT NULL,
    "confinedSpaceId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "AccessEquipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Confinus_DOM_Categories" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Confinus_DOM_Categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Confinus_DOM_ClassifiedZone" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Confinus_DOM_ClassifiedZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Confinus_DOM_ConstructionMaterial" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Confinus_DOM_ConstructionMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Confinus_ConfinedSpace" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "areaId" INTEGER NOT NULL,
    "subAreaId" INTEGER,
    "tag" TEXT,
    "mainCoverPhotoUrl" TEXT,
    "equipamentSerialNumber" INTEGER,
    "equipmentDescription" TEXT,
    "environment" TEXT,
    "cetegoryId" INTEGER NOT NULL,
    "severityId" INTEGER NOT NULL,
    "constructionMaterialId" INTEGER NOT NULL,
    "height" DECIMAL(65,30) NOT NULL,
    "width" DECIMAL(65,30) NOT NULL,
    "length" DECIMAL(65,30) NOT NULL,
    "diameter" DECIMAL(65,30) NOT NULL,
    "volume" DECIMAL(65,30) NOT NULL,
    "storedMaterial" TEXT,
    "physicalState" TEXT,
    "classifiedZoneId" INTEGER NOT NULL,
    "flammableAgent" TEXT,
    "registeredByUserId" INTEGER NOT NULL,
    "approvedByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Confinus_ConfinedSpace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Confinus_Manhole" (
    "id" SERIAL NOT NULL,
    "confinedSpaceId" INTEGER NOT NULL,
    "compnyId" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "positioning" TEXT,
    "dimensions" TEXT,
    "shape" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Confinus_Manhole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Confinus_AuxiliaryImages" (
    "id" SERIAL NOT NULL,
    "compnyId" INTEGER NOT NULL,
    "confinedSpaceId" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Confinus_AuxiliaryImages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Confinus_DOM_SeverityDefinition_classification_companyId_key" ON "Confinus_DOM_SeverityDefinition"("classification", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SubArea_areaId_key" ON "SubArea"("areaId");

-- AddForeignKey
ALTER TABLE "Confinus_DOM_SeverityDefinition" ADD CONSTRAINT "Confinus_DOM_SeverityDefinition_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubArea" ADD CONSTRAINT "SubArea_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DOM_Equipaments" ADD CONSTRAINT "DOM_Equipaments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessEquipment" ADD CONSTRAINT "AccessEquipment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessEquipment" ADD CONSTRAINT "AccessEquipment_equipamentId_fkey" FOREIGN KEY ("equipamentId") REFERENCES "DOM_Equipaments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessEquipment" ADD CONSTRAINT "AccessEquipment_manHoleId_fkey" FOREIGN KEY ("manHoleId") REFERENCES "Confinus_Manhole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessEquipment" ADD CONSTRAINT "AccessEquipment_confinedSpaceId_fkey" FOREIGN KEY ("confinedSpaceId") REFERENCES "Confinus_ConfinedSpace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_DOM_Categories" ADD CONSTRAINT "Confinus_DOM_Categories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_DOM_ClassifiedZone" ADD CONSTRAINT "Confinus_DOM_ClassifiedZone_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_DOM_ConstructionMaterial" ADD CONSTRAINT "Confinus_DOM_ConstructionMaterial_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_subAreaId_fkey" FOREIGN KEY ("subAreaId") REFERENCES "SubArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_cetegoryId_fkey" FOREIGN KEY ("cetegoryId") REFERENCES "Confinus_DOM_Categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_severityId_fkey" FOREIGN KEY ("severityId") REFERENCES "Confinus_DOM_SeverityDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_constructionMaterialId_fkey" FOREIGN KEY ("constructionMaterialId") REFERENCES "Confinus_DOM_ConstructionMaterial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_classifiedZoneId_fkey" FOREIGN KEY ("classifiedZoneId") REFERENCES "Confinus_DOM_ClassifiedZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_registeredByUserId_fkey" FOREIGN KEY ("registeredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_Manhole" ADD CONSTRAINT "Confinus_Manhole_confinedSpaceId_fkey" FOREIGN KEY ("confinedSpaceId") REFERENCES "Confinus_ConfinedSpace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_Manhole" ADD CONSTRAINT "Confinus_Manhole_compnyId_fkey" FOREIGN KEY ("compnyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_AuxiliaryImages" ADD CONSTRAINT "Confinus_AuxiliaryImages_compnyId_fkey" FOREIGN KEY ("compnyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_AuxiliaryImages" ADD CONSTRAINT "Confinus_AuxiliaryImages_confinedSpaceId_fkey" FOREIGN KEY ("confinedSpaceId") REFERENCES "Confinus_ConfinedSpace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
