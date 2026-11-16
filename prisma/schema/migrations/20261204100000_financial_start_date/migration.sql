-- CreateTable
CREATE TABLE "Financial_Settings" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3),
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Financial_Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Financial_Settings_companyId_key" ON "Financial_Settings"("companyId");
