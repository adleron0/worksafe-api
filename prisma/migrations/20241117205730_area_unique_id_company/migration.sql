-- DropIndex
DROP INDEX "Area_name_key";

-- CreateIndex
CREATE INDEX "Area_id_companyId_idx" ON "Area"("id", "companyId");
