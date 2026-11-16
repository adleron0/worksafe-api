-- Brilho da moldura do destaque (corda, reflexo, glitter, cristais, nenhum)
CREATE TYPE "CertificateHighlightBorder" AS ENUM ('corda', 'reflexo', 'glitter', 'cristais', 'nenhum');

ALTER TABLE "CourseClass" ADD COLUMN "highlightBorder" "CertificateHighlightBorder";
ALTER TABLE "TraineeCourseCertificate" ADD COLUMN "highlightBorder" "CertificateHighlightBorder";
