-- Instagram: limites e modos por ação, Direct e comentários

ALTER TABLE "Ai_Connector" ADD COLUMN "settings" JSONB;

CREATE TABLE "Ai_SocialMessage" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "provider" VARCHAR(30) NOT NULL DEFAULT 'instagram',
    "channel" VARCHAR(20) NOT NULL DEFAULT 'direct',
    "conversationId" VARCHAR(80) NOT NULL,
    "externalId" VARCHAR(255) NOT NULL,
    "direction" VARCHAR(5) NOT NULL,
    "fromId" VARCHAR(80),
    "fromUsername" VARCHAR(120),
    "text" TEXT NOT NULL DEFAULT '',
    "attachments" JSONB,
    "parentId" VARCHAR(80),
    "sentAt" TIMESTAMP(3) NOT NULL,
    "readAt" TIMESTAMP(3),
    "origin" VARCHAR(20) NOT NULL DEFAULT 'webhook',
    "status" VARCHAR(20) NOT NULL DEFAULT 'received',
    "note" TEXT,
    "repliedByBotId" INTEGER,
    "repliedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ai_SocialMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Ai_SocialMessage_externalId_key" ON "Ai_SocialMessage"("externalId");
CREATE INDEX "Ai_SocialMessage_companyId_channel_conversationId_sentAt_idx" ON "Ai_SocialMessage"("companyId", "channel", "conversationId", "sentAt");
CREATE INDEX "Ai_SocialMessage_companyId_direction_origin_sentAt_idx" ON "Ai_SocialMessage"("companyId", "direction", "origin", "sentAt");

-- Permissão: ler e responder Direct e comentários
INSERT INTO "Permission" ("name", "description", "group")
SELECT 'instagram_mensagens_bots', 'Ler e responder mensagens do Direct e comentários do Instagram', 'bots'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "name" = 'instagram_mensagens_bots');

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", perm."id" FROM "Profile" p, "Permission" perm
WHERE p."name" = 'super' AND perm."name" = 'instagram_mensagens_bots'
  AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" pp WHERE pp."profileId" = p."id" AND pp."permissionId" = perm."id");

-- A Nina ganha Direct e comentários
UPDATE "Ai_Bot"
SET "tools" = "tools" || '["instagram_conversas", "instagram_ler_conversa", "instagram_responder_mensagem", "instagram_comentarios", "instagram_responder_comentario", "instagram_ocultar_comentario"]'::jsonb,
    "instructions" = "instructions" || E'\n- Direct e comentários: veja com instagram_conversas / instagram_ler_conversa e instagram_comentarios. Responder (instagram_responder_mensagem, instagram_responder_comentario) pode virar cartão ou sair direto, conforme a configuração da empresa: o resultado diz qual.\n- A Meta só deixa responder o Direct até 24 horas depois da última mensagem do cliente; fora disso, explique e sugira que alguém responda pelo app.\n- Nunca invente preço, data, vaga ou certificado: consulte as turmas (listar_turmas) antes. Se não achar, diga que um atendente confirma.\n- Tom da marca: cordial, direto, frases curtas, sem gírias nem emojis em excesso, assinando como equipe.\n- Passe para humano (não responda) em reclamação, cobrança, pedido de orçamento de serviço, dados pessoais, assunto jurídico ou médico, ou quando estiver em dúvida.\n- Ocultar comentário é só para ofensa, spam ou golpe, e sempre com confirmação.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'marketing' AND NOT ("tools" @> '["instagram_conversas"]'::jsonb);
