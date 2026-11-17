-- Cancelamento do certificado emitido: motivo e, se reemitido, a chave do novo
ALTER TABLE "TraineeCourseCertificate" ADD COLUMN "cancelReason" VARCHAR(255);
ALTER TABLE "TraineeCourseCertificate" ADD COLUMN "replacedByKey" VARCHAR(36);
