/*
  Warnings:

  - You are about to drop the `Trainees` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[cpf,customerId]` on the table `Trainee` will be added. If there are existing duplicate values, this will fail.

*/
-- DropTable
DROP TABLE "Trainees";

-- CreateIndex
CREATE UNIQUE INDEX "Trainee_cpf_customerId_key" ON "Trainee"("cpf", "customerId");
