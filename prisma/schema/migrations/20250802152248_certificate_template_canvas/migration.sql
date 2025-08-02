/*
  Warnings:

  - You are about to drop the column `conformity` on the `CouseCertificate` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `CouseCertificate` table. All the data in the column will be lost.
  - You are about to drop the column `imageUrl` on the `CouseCertificate` table. All the data in the column will be lost.
  - You are about to drop the column `objective` on the `CouseCertificate` table. All the data in the column will be lost.
  - You are about to drop the column `yearsOfValidity` on the `CouseCertificate` table. All the data in the column will be lost.
  - Added the required column `companyId` to the `CouseCertificate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `CouseCertificate` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "CouseCertificate" DROP COLUMN "conformity",
DROP COLUMN "description",
DROP COLUMN "imageUrl",
DROP COLUMN "objective",
DROP COLUMN "yearsOfValidity",
ADD COLUMN     "canvas_height" INTEGER NOT NULL DEFAULT 600,
ADD COLUMN     "canvas_width" INTEGER NOT NULL DEFAULT 800,
ADD COLUMN     "companyId" INTEGER NOT NULL,
ADD COLUMN     "fabric_json_back" JSONB,
ADD COLUMN     "fabric_json_front" JSONB,
ADD COLUMN     "name" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "CouseCertificate" ADD CONSTRAINT "CouseCertificate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
