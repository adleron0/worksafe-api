/*
  Warnings:

  - A unique constraint covering the columns `[cnpj,companyId]` on the table `Customer` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Customer_cnpj_companyId_key" ON "Customer"("cnpj", "companyId");
