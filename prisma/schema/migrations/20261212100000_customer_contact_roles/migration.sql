-- Papéis do contato do cliente (comercial, financeiro, fiscal) e o contato
-- padrão de cada papel. O cargo (roleId) passa a ser opcional.
ALTER TABLE "Customer_Contacts" ALTER COLUMN "roleId" DROP NOT NULL;
ALTER TABLE "Customer_Contacts"
  ADD COLUMN "isCommercial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isFinancial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isFiscal" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "defaultCommercial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "defaultFinancial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "defaultFiscal" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "notes" VARCHAR(255);

CREATE INDEX "Customer_Contacts_customerId_idx" ON "Customer_Contacts"("customerId");
