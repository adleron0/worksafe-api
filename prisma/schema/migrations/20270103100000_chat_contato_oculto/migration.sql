-- Conversas: contato oculto (assunto pessoal, nada é gravado)
ALTER TABLE "Chat_Contact" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Chat_Contact" ADD COLUMN "hiddenAt" TIMESTAMP(3);
ALTER TABLE "Chat_Contact" ADD COLUMN "hiddenByUserId" INTEGER;
CREATE INDEX "Chat_Contact_channelId_hidden_idx" ON "Chat_Contact"("channelId", "hidden");
