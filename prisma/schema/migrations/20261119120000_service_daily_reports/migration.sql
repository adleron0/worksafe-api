-- RDO: relatório diário de obra de uma ordem de serviço.
CREATE TABLE "Service_DailyReport" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "shift" VARCHAR(12) NOT NULL DEFAULT 'integral',
    "weather" VARCHAR(16) NOT NULL DEFAULT 'bom',
    "status" VARCHAR(12) NOT NULL DEFAULT 'rascunho',
    "crew" JSONB NOT NULL,
    "activities" TEXT,
    "progress" JSONB NOT NULL,
    "occurrences" JSONB NOT NULL,
    "equipment" TEXT,
    "photos" JSONB NOT NULL,
    "notes" TEXT,
    "createdByUserId" INTEGER,
    "closedAt" TIMESTAMP(3),
    "closedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Service_DailyReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Service_DailyReport_orderId_date_shift_key" ON "Service_DailyReport"("orderId", "date", "shift");
CREATE INDEX "Service_DailyReport_companyId_orderId_idx" ON "Service_DailyReport"("companyId", "orderId");
CREATE INDEX "Service_DailyReport_companyId_date_idx" ON "Service_DailyReport"("companyId", "date");
