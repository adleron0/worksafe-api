-- CreateTable
CREATE TABLE "DOM_Cities" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "stateId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "DOM_Cities_pkey" PRIMARY KEY ("id")
);

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
CREATE TABLE "DOM_Ranks" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "companyId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "DOM_Ranks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DOM_Roles" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "DOM_Roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DOM_States" (
    "id" SERIAL NOT NULL,
    "uf" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "DOM_States_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "Area" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" SERIAL NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "comercial_name" TEXT NOT NULL,
    "corporate_name" TEXT NOT NULL,
    "cnpj" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "representative_email" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyProduct" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CompanyProduct_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "Customer" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "searchName" VARCHAR(255),
    "corporateName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "companyId" INTEGER NOT NULL,
    "cnpj" TEXT NOT NULL,
    "imageUrl" TEXT,
    "description" TEXT,
    "rankId" INTEGER NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "stateId" INTEGER NOT NULL,
    "cityId" INTEGER NOT NULL,
    "neighborhood" TEXT,
    "street" TEXT,
    "number" TEXT,
    "complement" TEXT,
    "zipcode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer_Contacts" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "roleId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Customer_Contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "group" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "groupPermission" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" SERIAL NOT NULL,
    "roleId" INTEGER NOT NULL,
    "permissionId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "System_Logs" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "column" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "System_Logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "searchName" VARCHAR(255),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "imageUrl" TEXT,
    "phone" TEXT NOT NULL,
    "cpf" TEXT NOT NULL,
    "companyId" INTEGER,
    "roleId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPermission" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "permissionId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Area_id_companyId_idx" ON "Area"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Area_name_companyId_key" ON "Area"("name", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Company_cnpj_key" ON "Company"("cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyProduct_companyId_productId_key" ON "CompanyProduct"("companyId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Confinus_DOM_SeverityDefinition_classification_companyId_key" ON "Confinus_DOM_SeverityDefinition"("classification", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_cnpj_companyId_key" ON "Customer"("cnpj", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_name_key" ON "Permission"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_userId_sessionToken_key" ON "Session"("userId", "sessionToken");

-- CreateIndex
CREATE INDEX "SubArea_id_areaId_idx" ON "SubArea"("id", "areaId");

-- CreateIndex
CREATE UNIQUE INDEX "SubArea_name_areaId_key" ON "SubArea"("name", "areaId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_companyId_key" ON "User"("email", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "User_id_companyId_key" ON "User"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPermission_userId_permissionId_key" ON "UserPermission"("userId", "permissionId");

-- AddForeignKey
ALTER TABLE "DOM_Cities" ADD CONSTRAINT "DOM_Cities_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "DOM_States"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DOM_ConstructionMaterial" ADD CONSTRAINT "DOM_ConstructionMaterial_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "Area" ADD CONSTRAINT "Area_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyProduct" ADD CONSTRAINT "CompanyProduct_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyProduct" ADD CONSTRAINT "CompanyProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_AuxiliaryImages" ADD CONSTRAINT "Confinus_AuxiliaryImages_compnyId_fkey" FOREIGN KEY ("compnyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_AuxiliaryImages" ADD CONSTRAINT "Confinus_AuxiliaryImages_confinedSpaceId_fkey" FOREIGN KEY ("confinedSpaceId") REFERENCES "Confinus_ConfinedSpace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_constructionMaterialId_fkey" FOREIGN KEY ("constructionMaterialId") REFERENCES "DOM_ConstructionMaterial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_classifiedZoneId_fkey" FOREIGN KEY ("classifiedZoneId") REFERENCES "Confinus_DOM_ClassifiedZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_registeredByUserId_fkey" FOREIGN KEY ("registeredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_ConfinedSpace" ADD CONSTRAINT "Confinus_ConfinedSpace_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_DOM_Categories" ADD CONSTRAINT "Confinus_DOM_Categories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_DOM_ClassifiedZone" ADD CONSTRAINT "Confinus_DOM_ClassifiedZone_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_DOM_SeverityDefinition" ADD CONSTRAINT "Confinus_DOM_SeverityDefinition_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_Manhole" ADD CONSTRAINT "Confinus_Manhole_confinedSpaceId_fkey" FOREIGN KEY ("confinedSpaceId") REFERENCES "Confinus_ConfinedSpace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confinus_Manhole" ADD CONSTRAINT "Confinus_Manhole_compnyId_fkey" FOREIGN KEY ("compnyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_rankId_fkey" FOREIGN KEY ("rankId") REFERENCES "DOM_Ranks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "DOM_States"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "DOM_Cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer_Contacts" ADD CONSTRAINT "Customer_Contacts_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "DOM_Roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer_Contacts" ADD CONSTRAINT "Customer_Contacts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubArea" ADD CONSTRAINT "SubArea_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "System_Logs" ADD CONSTRAINT "System_Logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "System_Logs" ADD CONSTRAINT "System_Logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
