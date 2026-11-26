-- CreateTable
CREATE TABLE "Chat_ChannelEvent" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "channelId" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chat_ChannelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chat_ChannelEvent_channelId_createdAt_idx" ON "Chat_ChannelEvent"("channelId", "createdAt");

-- Status atual dos números vira o primeiro registro do histórico
INSERT INTO "Chat_ChannelEvent" ("companyId", "channelId", "status", "reason", "createdAt")
SELECT "companyId", "id", "status", CASE WHEN "status" = 'conectado' THEN NULL ELSE "statusReason" END, COALESCE("statusAt", "createdAt") FROM "Chat_Channel" WHERE "active" = true AND "type" = 'whatsapp';
