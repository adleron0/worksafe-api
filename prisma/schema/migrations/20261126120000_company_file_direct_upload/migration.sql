-- Arquivos da empresa, fase 3: envio direto ao armazenamento em partes (arquivos grandes).
-- Enquanto o envio não fecha, a linha fica marcada com o identificador do envio e não aparece nas listas.
ALTER TABLE "File_Item"
    ADD COLUMN "uploadId" VARCHAR(300),
    ADD COLUMN "replacesId" INTEGER;
