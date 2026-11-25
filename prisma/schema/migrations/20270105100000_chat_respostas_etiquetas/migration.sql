-- Conversas: respostas rápidas e etiquetas
CREATE TABLE "Chat_QuickReply" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "shortcut" VARCHAR(40) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "text" TEXT NOT NULL,
    "sector" VARCHAR(40),
    "uses" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "inactiveAt" TIMESTAMP(3),
    CONSTRAINT "Chat_QuickReply_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Chat_QuickReply_companyId_inactiveAt_idx" ON "Chat_QuickReply"("companyId", "inactiveAt");

CREATE TABLE "Chat_Tag" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "color" VARCHAR(20) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),
    CONSTRAINT "Chat_Tag_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Chat_Tag_companyId_inactiveAt_idx" ON "Chat_Tag"("companyId", "inactiveAt");

CREATE TABLE "Chat_ConversationTag" (
    "conversationId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Chat_ConversationTag_pkey" PRIMARY KEY ("conversationId","tagId")
);
CREATE INDEX "Chat_ConversationTag_tagId_idx" ON "Chat_ConversationTag"("tagId");
ALTER TABLE "Chat_ConversationTag" ADD CONSTRAINT "Chat_ConversationTag_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Chat_Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Chat_ConversationTag" ADD CONSTRAINT "Chat_ConversationTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Chat_Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
