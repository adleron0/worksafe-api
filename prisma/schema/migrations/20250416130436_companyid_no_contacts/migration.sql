/*
  Warnings:

  - Added the required column `companyId` to the `Customer_Contacts` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Customer_Contacts" ADD COLUMN     "companyId" INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE "Customer_Contacts" ADD CONSTRAINT "Customer_Contacts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
