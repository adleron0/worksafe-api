-- Descrição e características dos produtos da loja passam a aceitar texto longo
-- (antes VARCHAR(255): descrições comuns estouravam o limite). Conversão sem perda.
ALTER TABLE "Site_Products" ALTER COLUMN "description" SET DATA TYPE TEXT;
ALTER TABLE "Site_Products" ALTER COLUMN "features" SET DATA TYPE TEXT;
