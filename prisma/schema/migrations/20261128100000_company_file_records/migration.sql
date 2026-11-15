-- Arquivos da empresa, fase 4: arquivo ligado a um registro (cliente, proposta ou ordem de serviço).
-- Esse arquivo não fica em pasta: pertence ao registro, e quem vê o registro vê o arquivo.
ALTER TABLE "File_Item" ALTER COLUMN "folderId" DROP NOT NULL;
ALTER TABLE "File_Item"
    ADD COLUMN "entity" VARCHAR(30),
    ADD COLUMN "entityId" INTEGER;
CREATE INDEX "File_Item_companyId_entity_entityId_idx" ON "File_Item"("companyId", "entity", "entityId");
