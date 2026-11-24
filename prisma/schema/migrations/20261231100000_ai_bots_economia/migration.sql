-- Bots: modo econômico por bot, contagem por tier na execução e teto de gasto por empresa

ALTER TABLE "Ai_Bot" ADD COLUMN "economyProvider" VARCHAR(20);
ALTER TABLE "Ai_Bot" ADD COLUMN "economyModel" VARCHAR(80);
ALTER TABLE "Ai_Bot" ADD COLUMN "economyMode" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Ai_Run" ADD COLUMN "primarySteps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ai_Run" ADD COLUMN "economySteps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ai_Run" ADD COLUMN "escalations" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ai_Run" ADD COLUMN "economyCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0;

CREATE TABLE "Ai_Settings" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "monthlyBudgetUsd" DECIMAL(10,2),
    "warnPercent" INTEGER NOT NULL DEFAULT 80,
    "onExceed" VARCHAR(12) NOT NULL DEFAULT 'parar',
    "economyProvider" VARCHAR(20),
    "economyModel" VARCHAR(80),
    "botBudgets" JSONB,
    "warnedMonth" VARCHAR(7),
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ai_Settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Ai_Settings_companyId_key" ON "Ai_Settings"("companyId");
