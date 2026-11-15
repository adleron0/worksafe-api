-- Padronagem do centro no efeito de destaque (turma e certificado).
CREATE TYPE "CertificateHighlightPattern" AS ENUM ('rosetas', 'estrelas', 'estilhacos', 'bolhas', 'espiral', 'glitter', 'arco_iris', 'gravado', 'nenhum');

ALTER TABLE "CourseClass" ADD COLUMN "highlightPattern" "CertificateHighlightPattern";
ALTER TABLE "TraineeCourseCertificate" ADD COLUMN "highlightPattern" "CertificateHighlightPattern";
