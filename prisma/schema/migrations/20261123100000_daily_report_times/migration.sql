-- RDO: hora de entrada e de saída, intervalo, clima e condição da frente de trabalho nos dois momentos
ALTER TABLE "Service_DailyReport" ADD COLUMN "startTime" VARCHAR(5);
ALTER TABLE "Service_DailyReport" ADD COLUMN "endTime" VARCHAR(5);
ALTER TABLE "Service_DailyReport" ADD COLUMN "breakMinutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Service_DailyReport" ADD COLUMN "weatherEnd" VARCHAR(16);
ALTER TABLE "Service_DailyReport" ADD COLUMN "startCondition" VARCHAR(12);
ALTER TABLE "Service_DailyReport" ADD COLUMN "endCondition" VARCHAR(12);
ALTER TABLE "Service_DailyReport" ADD COLUMN "startNote" VARCHAR(500);
ALTER TABLE "Service_DailyReport" ADD COLUMN "endNote" VARCHAR(500);
