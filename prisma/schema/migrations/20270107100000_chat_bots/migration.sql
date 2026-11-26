-- Conversas fase 5: rascunhos do bot (modo "sugere resposta") e aproveitamento
CREATE TABLE "Chat_BotSuggestion" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "channelId" INTEGER NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "botId" INTEGER NOT NULL,
    "forMessageId" INTEGER,
    "text" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pendente',
    "finalText" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" INTEGER,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Chat_BotSuggestion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Chat_BotSuggestion_conversationId_status_idx" ON "Chat_BotSuggestion"("conversationId", "status");
CREATE INDEX "Chat_BotSuggestion_channelId_createdAt_idx" ON "Chat_BotSuggestion"("channelId", "createdAt");
