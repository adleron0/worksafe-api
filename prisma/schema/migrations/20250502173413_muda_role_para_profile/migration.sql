/*
  Warnings:

  - You are about to drop the column `roleId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `Role` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `RolePermission` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_permissionId_fkey";

-- DropForeignKey
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_roleId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_roleId_fkey";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "roleId",
ADD COLUMN     "profileId" INTEGER;

-- DropTable
DROP TABLE "Role";

-- DropTable
DROP TABLE "RolePermission";

-- CreateTable
CREATE TABLE "Profile" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "companyId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfilePermission" (
    "id" SERIAL NOT NULL,
    "profileId" INTEGER NOT NULL,
    "permissionId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "ProfilePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Profile_name_key" ON "Profile"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePermission_profileId_permissionId_key" ON "ProfilePermission"("profileId", "permissionId");

-- AddForeignKey
ALTER TABLE "ProfilePermission" ADD CONSTRAINT "ProfilePermission_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfilePermission" ADD CONSTRAINT "ProfilePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
