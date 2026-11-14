-- Propostas em rascunho que só guardavam uma cópia SEM EDIÇÃO dos modelos antigos
-- (os quatro textos originais, reconhecidos pelo md5) voltam a acompanhar o modelo
-- padrão da empresa. Texto que alguém editou não é tocado; proposta enviada também não.
UPDATE "Commercial_Proposal"
SET "documentBody" = NULL, "templateId" = NULL, "termIds" = '{}'
WHERE "status" = 'rascunho'
  AND "documentBody" IS NOT NULL
  AND md5("documentBody") IN ('f8bf218ab98ee64e2274a9717b2d25c3', '75e8021801d38bdcc72d28c981e6f87f', '3441c13c84706e235658b995e24c6f59', '81749d34f79d4e0c657785879ba69f57');

-- Rascunhos sem texto próprio que apontavam para um desses modelos antigos, sem edição.
UPDATE "Commercial_Proposal" p
SET "templateId" = NULL, "termIds" = '{}'
FROM "Commercial_ProposalTemplate" t
WHERE p."status" = 'rascunho'
  AND p."documentBody" IS NULL
  AND p."templateId" = t."id"
  AND md5(t."body") IN ('f8bf218ab98ee64e2274a9717b2d25c3', '75e8021801d38bdcc72d28c981e6f87f', '3441c13c84706e235658b995e24c6f59', '81749d34f79d4e0c657785879ba69f57');
