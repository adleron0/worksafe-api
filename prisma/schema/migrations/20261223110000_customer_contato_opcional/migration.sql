-- Telefone e e-mail do cliente deixam de ser obrigatórios
ALTER TABLE "Customer" ALTER COLUMN "phone" DROP NOT NULL,
ALTER COLUMN "email" DROP NOT NULL;
UPDATE "Customer" SET "phone" = NULL WHERE "phone" = '';
UPDATE "Customer" SET "email" = NULL WHERE "email" = '';
