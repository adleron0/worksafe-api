-- Rosto montado no editor: além das chaves dos modelos ("gestao", "comercial"...),
-- o campo guarda a combinação "r:forma.cor.acessorio.olhos.jeito", que passa de 40.
ALTER TABLE "Ai_Bot" ALTER COLUMN "avatar" TYPE VARCHAR(80);
