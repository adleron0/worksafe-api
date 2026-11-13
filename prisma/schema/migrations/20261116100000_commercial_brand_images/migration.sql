-- AlterTable
ALTER TABLE "Commercial_Proposal" ADD COLUMN     "images" JSONB;

-- CreateTable
CREATE TABLE "Commercial_Settings" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "brand" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commercial_Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_Settings_companyId_key" ON "Commercial_Settings"("companyId");

