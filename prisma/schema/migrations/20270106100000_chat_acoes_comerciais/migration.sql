-- Conversas fase 4: negociação aberta pela conversa e acompanhamento ligado à conversa
ALTER TABLE "Chat_Conversation" ADD COLUMN "dealId" INTEGER;
ALTER TABLE "Commercial_Activity" ADD COLUMN "chatConversationId" INTEGER;
CREATE INDEX "Commercial_Activity_chatConversationId_idx" ON "Commercial_Activity"("chatConversationId");
