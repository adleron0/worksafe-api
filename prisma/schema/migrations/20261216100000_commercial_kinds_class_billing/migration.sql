-- Fluxo comercial, fase 1: o tipo da proposta passa a ser serviço, treinamento
-- ou locação ("misto" sai; quem tiver "misto" vira serviço — em 18/11/2026 não
-- havia nenhuma em produção).
ALTER TYPE "CommercialProposalKind" RENAME TO "CommercialProposalKind_old";
CREATE TYPE "CommercialProposalKind" AS ENUM ('servico', 'treinamento', 'locacao');

ALTER TABLE "Commercial_Proposal" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "Commercial_Proposal" ALTER COLUMN "kind" TYPE "CommercialProposalKind"
  USING (CASE WHEN "kind"::text = 'misto' THEN 'servico' ELSE "kind"::text END)::"CommercialProposalKind";
ALTER TABLE "Commercial_Proposal" ALTER COLUMN "kind" SET DEFAULT 'servico';

ALTER TABLE "Commercial_Contract" ALTER COLUMN "kind" TYPE "CommercialProposalKind"
  USING (CASE WHEN "kind"::text = 'misto' THEN 'servico' ELSE "kind"::text END)::"CommercialProposalKind";

ALTER TABLE "Commercial_ProposalTemplate" ALTER COLUMN "kind" TYPE "CommercialProposalKind"
  USING (CASE WHEN "kind"::text = 'misto' THEN NULL ELSE "kind"::text END)::"CommercialProposalKind";

DROP TYPE "CommercialProposalKind_old";

-- Fluxo comercial, fase 5: turma fechada ligada à venda (ou "sem cobrança").
CREATE TABLE "Commercial_ClassBilling" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "classId" INTEGER NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "contractId" INTEGER,
    "reason" VARCHAR(300),
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Commercial_ClassBilling_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Commercial_ClassBilling_classId_key" ON "Commercial_ClassBilling"("classId");
CREATE INDEX "Commercial_ClassBilling_companyId_mode_idx" ON "Commercial_ClassBilling"("companyId", "mode");
CREATE INDEX "Commercial_ClassBilling_contractId_idx" ON "Commercial_ClassBilling"("contractId");

-- Turmas já criadas pelos contratos (guardadas no JSON "classes" da venda).
INSERT INTO "Commercial_ClassBilling" ("companyId", "classId", "mode", "contractId")
SELECT DISTINCT ON (cid::int) ct."companyId", cid::int, 'contrato', ct."id"
FROM "Commercial_Contract" ct
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ct."classes", '[]'::jsonb)) AS slot
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(slot->'classIds', '[]'::jsonb)) AS cid
JOIN "CourseClass" c ON c."id" = cid::int
ORDER BY cid::int, ct."id";
