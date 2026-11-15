-- Arquivos da empresa, fase 2: tipos de documento com validade, vencimento no arquivo e versões.
CREATE TABLE "File_DocumentType" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "expires" BOOLEAN NOT NULL DEFAULT false,
    "validityMonths" INTEGER,
    "warnDays" INTEGER NOT NULL DEFAULT 30,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "File_DocumentType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "File_DocumentType_companyId_name_key" ON "File_DocumentType"("companyId", "name");

ALTER TABLE "File_Item"
    ADD COLUMN "typeId" INTEGER,
    ADD COLUMN "issueDate" DATE,
    ADD COLUMN "expiryDate" DATE,
    ADD COLUMN "warnDays" INTEGER,
    ADD COLUMN "versionGroup" VARCHAR(36),
    ADD COLUMN "replacedAt" TIMESTAMP(3);
CREATE INDEX "File_Item_companyId_expiryDate_idx" ON "File_Item"("companyId", "expiryDate");
CREATE INDEX "File_Item_versionGroup_idx" ON "File_Item"("versionGroup");
ALTER TABLE "File_Item" ADD CONSTRAINT "File_Item_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "File_DocumentType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
