-- Certificados de destaque: turma especial (tema na turma) e aluno destaque
-- (marcação no certificado emitido, com tema e texto opcionais).
CREATE TYPE "CertificateHighlightTheme" AS ENUM ('ouro', 'prata', 'holografico');

ALTER TABLE "CourseClass"
  ADD COLUMN "highlightTheme" "CertificateHighlightTheme",
  ADD COLUMN "highlightLabel" VARCHAR(60);

ALTER TABLE "TraineeCourseCertificate"
  ADD COLUMN "highlightStudent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "highlightTheme" "CertificateHighlightTheme",
  ADD COLUMN "highlightLabel" VARCHAR(60);
