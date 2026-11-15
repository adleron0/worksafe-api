-- Agenda de tarefas dos bots: uma vez, a cada X horas, vários dias da semana,
-- gatilhos por evento e as travas (limite por dia, pausa depois de falhas).
-- AlterTable
ALTER TABLE "Ai_Schedule" ADD COLUMN     "daysOfWeek" JSONB,
ADD COLUMN     "eventCursor" TIMESTAMP(3),
ADD COLUMN     "eventParams" JSONB,
ADD COLUMN     "eventType" VARCHAR(40),
ADD COLUMN     "everyHours" INTEGER,
ADD COLUMN     "failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "firedKeys" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "lastReportId" INTEGER,
ADD COLUMN     "lastStatus" VARCHAR(12),
ADD COLUMN     "maxRunsPerDay" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "pausedReason" VARCHAR(300),
ADD COLUMN     "runAt" TIMESTAMP(3),
ADD COLUMN     "runsDay" VARCHAR(10),
ADD COLUMN     "runsToday" INTEGER NOT NULL DEFAULT 0;

