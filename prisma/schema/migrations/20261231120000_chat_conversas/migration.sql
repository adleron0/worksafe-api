-- Conversas: canais (números), equipe, contatos, conversas e mensagens
-- CreateTable
CREATE TABLE "Chat_Channel" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "type" VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
    "provider" VARCHAR(20) NOT NULL DEFAULT 'evolution',
    "name" VARCHAR(120) NOT NULL,
    "color" VARCHAR(20),
    "sector" VARCHAR(40),
    "defaultBotId" INTEGER,
    "botMode" VARCHAR(20) NOT NULL DEFAULT 'sugere',
    "instanceName" VARCHAR(80),
    "phone" VARCHAR(30),
    "profileName" VARCHAR(160),
    "status" VARCHAR(20) NOT NULL DEFAULT 'desconectado',
    "statusReason" TEXT,
    "statusAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "webhookTokenHash" VARCHAR(64),
    "settings" JSONB,
    "nextSendAt" TIMESTAMP(3),
    "termsVersion" VARCHAR(20),
    "termsAcceptedAt" TIMESTAMP(3),
    "termsAcceptedByUserId" INTEGER,
    "termsAcceptedIp" VARCHAR(64),
    "historyDays" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat_ChannelMember" (
    "id" SERIAL NOT NULL,
    "channelId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "Chat_ChannelMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat_Contact" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "channelId" INTEGER NOT NULL,
    "externalId" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(30),
    "name" VARCHAR(160),
    "pushName" VARCHAR(160),
    "avatarUrl" TEXT,
    "customerId" INTEGER,
    "optOut" BOOLEAN NOT NULL DEFAULT false,
    "optOutAt" TIMESTAMP(3),
    "firstInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat_Conversation" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "channelId" INTEGER NOT NULL,
    "contactId" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'aberta',
    "sector" VARCHAR(40),
    "assignedUserId" INTEGER,
    "botId" INTEGER,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" VARCHAR(200),
    "lastDirection" VARCHAR(5),
    "unread" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat_Message" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "channelId" INTEGER NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "direction" VARCHAR(5) NOT NULL,
    "type" VARCHAR(20) NOT NULL DEFAULT 'text',
    "text" TEXT NOT NULL DEFAULT '',
    "media" JSONB,
    "externalId" VARCHAR(255),
    "status" VARCHAR(20) NOT NULL DEFAULT 'received',
    "error" TEXT,
    "origin" VARCHAR(20) NOT NULL DEFAULT 'webhook',
    "sentByUserId" INTEGER,
    "sentByBotId" INTEGER,
    "textHash" VARCHAR(64),
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chat_Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Chat_Channel_instanceName_key" ON "Chat_Channel"("instanceName");

-- CreateIndex
CREATE INDEX "Chat_Channel_companyId_active_idx" ON "Chat_Channel"("companyId", "active");

-- CreateIndex
CREATE INDEX "Chat_ChannelMember_userId_idx" ON "Chat_ChannelMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_ChannelMember_channelId_userId_key" ON "Chat_ChannelMember"("channelId", "userId");

-- CreateIndex
CREATE INDEX "Chat_Contact_companyId_phone_idx" ON "Chat_Contact"("companyId", "phone");

-- CreateIndex
CREATE INDEX "Chat_Contact_customerId_idx" ON "Chat_Contact"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_Contact_channelId_externalId_key" ON "Chat_Contact"("channelId", "externalId");

-- CreateIndex
CREATE INDEX "Chat_Conversation_companyId_status_lastMessageAt_idx" ON "Chat_Conversation"("companyId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Chat_Conversation_assignedUserId_idx" ON "Chat_Conversation"("assignedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_Conversation_channelId_contactId_key" ON "Chat_Conversation"("channelId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_Message_externalId_key" ON "Chat_Message"("externalId");

-- CreateIndex
CREATE INDEX "Chat_Message_conversationId_sentAt_idx" ON "Chat_Message"("conversationId", "sentAt");

-- CreateIndex
CREATE INDEX "Chat_Message_channelId_direction_status_sentAt_idx" ON "Chat_Message"("channelId", "direction", "status", "sentAt");

-- CreateIndex
CREATE INDEX "Chat_Message_status_scheduledAt_idx" ON "Chat_Message"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Chat_Message_channelId_textHash_sentAt_idx" ON "Chat_Message"("channelId", "textHash", "sentAt");

-- AddForeignKey
ALTER TABLE "Chat_ChannelMember" ADD CONSTRAINT "Chat_ChannelMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Chat_Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat_Contact" ADD CONSTRAINT "Chat_Contact_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Chat_Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat_Conversation" ADD CONSTRAINT "Chat_Conversation_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Chat_Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat_Conversation" ADD CONSTRAINT "Chat_Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Chat_Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat_Message" ADD CONSTRAINT "Chat_Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Chat_Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey

-- Permissões das Conversas
INSERT INTO "Permission" ("name", "description", "group")
SELECT v.name, v.description, 'conversas' FROM (VALUES
  ('view_conversas', 'Ver e responder as conversas dos números em que está na equipe'),
  ('todas_conversas', 'Ver as conversas de todos os números e setores'),
  ('responder_conversas', 'Responder clientes pelo WhatsApp e iniciar conversas'),
  ('canais_conversas', 'Conectar números e configurar canais (aceita o termo de risco)')
) AS v(name, description)
WHERE NOT EXISTS (SELECT 1 FROM "Permission" p WHERE p."name" = v.name);

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", perm."id" FROM "Profile" p, "Permission" perm
WHERE p."name" = 'super' AND perm."name" IN ('view_conversas', 'todas_conversas', 'responder_conversas', 'canais_conversas')
  AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" pp WHERE pp."profileId" = p."id" AND pp."permissionId" = perm."id");
