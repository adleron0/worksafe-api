/*
  Warnings:

  - You are about to alter the column `name` on the `AccessEquipment` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `Area` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `imageUrl` on the `Area` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `description` on the `Area` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `comercial_name` on the `Company` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `corporate_name` on the `Company` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `cnpj` on the `Company` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(14)`.
  - You are about to alter the column `region` on the `Company` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `state` on the `Company` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `representative_email` on the `Company` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `segment` on the `Company` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `imageUrl` on the `Confinus_AuxiliaryImages` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `description` on the `Confinus_AuxiliaryImages` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `tag` on the `Confinus_ConfinedSpace` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(100)`.
  - You are about to alter the column `mainCoverPhotoUrl` on the `Confinus_ConfinedSpace` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `equipmentDescription` on the `Confinus_ConfinedSpace` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `storedMaterial` on the `Confinus_ConfinedSpace` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `physicalState` on the `Confinus_ConfinedSpace` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `flammableAgent` on the `Confinus_ConfinedSpace` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `Confinus_DOM_Categories` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `Confinus_DOM_ClassifiedZone` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `description` on the `Confinus_DOM_SeverityDefinition` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `classification` on the `Confinus_DOM_SeverityDefinition` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `imageUrl` on the `Confinus_Manhole` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `positioning` on the `Confinus_Manhole` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `dimensions` on the `Confinus_Manhole` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `shape` on the `Confinus_Manhole` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `corporateName` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `cnpj` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(14)`.
  - You are about to alter the column `imageUrl` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `description` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `phone` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(100)`.
  - You are about to alter the column `email` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `neighborhood` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `street` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - The `number` column on the `Customer` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to alter the column `complement` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `zipcode` on the `Customer` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(10)`.
  - You are about to alter the column `name` on the `Customer_Contacts` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `email` on the `Customer_Contacts` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `phone` on the `Customer_Contacts` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `DOM_Cities` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `DOM_ConstructionMaterial` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `DOM_Equipaments` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `imageUrl` on the `DOM_Equipaments` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `DOM_Ranks` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `color` on the `DOM_Ranks` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `DOM_Roles` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `uf` on the `DOM_States` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(2)`.
  - You are about to alter the column `name` on the `DOM_States` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `description` on the `Permission` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `group` on the `Permission` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `Product` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `groupPermission` on the `Product` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `sessionToken` on the `Session` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `SubArea` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `action` on the `System_Logs` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `entity` on the `System_Logs` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `column` on the `System_Logs` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `ipAddress` on the `System_Logs` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `name` on the `User` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `email` on the `User` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `password` on the `User` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `imageUrl` on the `User` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `phone` on the `User` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `cpf` on the `User` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(20)`.

*/
-- AlterTable
ALTER TABLE "AccessEquipment" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Area" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "imageUrl" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "description" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Company" ALTER COLUMN "comercial_name" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "corporate_name" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "cnpj" SET DATA TYPE VARCHAR(14),
ALTER COLUMN "region" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "state" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "representative_email" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "segment" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Confinus_AuxiliaryImages" ALTER COLUMN "imageUrl" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "description" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Confinus_ConfinedSpace" ALTER COLUMN "tag" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "mainCoverPhotoUrl" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "equipmentDescription" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "storedMaterial" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "physicalState" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "flammableAgent" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Confinus_DOM_Categories" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Confinus_DOM_ClassifiedZone" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Confinus_DOM_SeverityDefinition" ALTER COLUMN "description" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "classification" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Confinus_Manhole" ALTER COLUMN "imageUrl" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "positioning" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "dimensions" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "shape" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Customer" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "corporateName" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "cnpj" SET DATA TYPE VARCHAR(14),
ALTER COLUMN "imageUrl" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "description" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "phone" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "email" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "neighborhood" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "street" SET DATA TYPE VARCHAR(255),
DROP COLUMN "number",
ADD COLUMN     "number" INTEGER,
ALTER COLUMN "complement" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "zipcode" SET DATA TYPE VARCHAR(10);

-- AlterTable
ALTER TABLE "Customer_Contacts" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "email" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "phone" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "DOM_Cities" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "DOM_ConstructionMaterial" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "DOM_Equipaments" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "imageUrl" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "DOM_Ranks" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "color" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "DOM_Roles" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "DOM_States" ALTER COLUMN "uf" SET DATA TYPE VARCHAR(2),
ALTER COLUMN "name" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Permission" ALTER COLUMN "description" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "group" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "groupPermission" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "sessionToken" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "SubArea" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "System_Logs" ALTER COLUMN "action" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "entity" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "column" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "ipAddress" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "name" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "email" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "password" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "imageUrl" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "phone" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "cpf" SET DATA TYPE VARCHAR(20);
