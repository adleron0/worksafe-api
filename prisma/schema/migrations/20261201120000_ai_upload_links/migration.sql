-- Link de envio de imagens para os bots e o MCP.
CREATE TABLE "Ai_UploadLink" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" VARCHAR(128) NOT NULL,
    "purpose" VARCHAR(200) NOT NULL,
    "maxFiles" INTEGER NOT NULL DEFAULT 10,
    "images" JSONB NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ai_UploadLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Ai_UploadLink_tokenHash_key" ON "Ai_UploadLink"("tokenHash");
CREATE INDEX "Ai_UploadLink_companyId_userId_idx" ON "Ai_UploadLink"("companyId", "userId");

-- Bots de Treinamentos e Marketing que já existem ganham as ferramentas de imagem.
UPDATE "Ai_Bot"
SET "tools" = "tools" || '["link_para_enviar_imagens", "imagens_do_envio", "enviar_imagem_por_url", "definir_imagem"]'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('treinamentos', 'marketing')
  AND NOT ("tools" @> '["link_para_enviar_imagens"]'::jsonb);
