-- Empresas do grupo: vários CNPJs (Treinamentos, Serviços...) num sistema só (worksafe/cnpj-planejamento)

-- DropIndex
DROP INDEX "Fiscal_Invoice_companyId_environment_dpsSeries_dpsNumber_key";

-- DropIndex
DROP INDEX "Fiscal_Settings_companyId_key";

-- AlterTable
ALTER TABLE "Commercial_Contract" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Commercial_Proposal" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "CompanyGateWays" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "CourseClass" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "FinancialRecords" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Financial_BankAccount" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Financial_Payable" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Financial_Recurrence" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Fiscal_Invoice" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Fiscal_ReceivedInvoice" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Fiscal_ServiceCode" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Fiscal_Settings" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Hr_Employee" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Service_Order" ADD COLUMN     "entityId" INTEGER;

-- AlterTable
ALTER TABLE "Stock_Rental" ADD COLUMN     "entityId" INTEGER;

-- CreateTable
CREATE TABLE "Company_Entity" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "cnpj" VARCHAR(14) NOT NULL,
    "corporateName" VARCHAR(255) NOT NULL,
    "tradeName" VARCHAR(120) NOT NULL,
    "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "color" VARCHAR(7),
    "logoUrl" VARCHAR(255),
    "stateId" INTEGER,
    "cityId" INTEGER,
    "zipCode" VARCHAR(9),
    "address" VARCHAR(255),
    "addressNumber" VARCHAR(20),
    "addressComplement" VARCHAR(120),
    "neighborhood" VARCHAR(120),
    "email" VARCHAR(255),
    "phone" VARCHAR(30),
    "municipalRegistration" VARCHAR(20),
    "stateRegistration" VARCHAR(20),
    "brand" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Company_Entity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Company_Entity_companyId_idx" ON "Company_Entity"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Company_Entity_companyId_cnpj_key" ON "Company_Entity"("companyId", "cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "Fiscal_Invoice_companyId_entityId_environment_dpsSeries_dps_key" ON "Fiscal_Invoice"("companyId", "entityId", "environment", "dpsSeries", "dpsNumber");

-- CreateIndex
CREATE INDEX "Fiscal_Settings_companyId_idx" ON "Fiscal_Settings"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Fiscal_Settings_entityId_key" ON "Fiscal_Settings"("entityId");

-- AddForeignKey
ALTER TABLE "Commercial_Proposal" ADD CONSTRAINT "Commercial_Proposal_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commercial_Contract" ADD CONSTRAINT "Commercial_Contract_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company_Entity" ADD CONSTRAINT "Company_Entity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company_Entity" ADD CONSTRAINT "Company_Entity_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "DOM_States"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company_Entity" ADD CONSTRAINT "Company_Entity_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "DOM_Cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyGateWays" ADD CONSTRAINT "CompanyGateWays_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseClass" ADD CONSTRAINT "CourseClass_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Financial_BankAccount" ADD CONSTRAINT "Financial_BankAccount_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Financial_Payable" ADD CONSTRAINT "Financial_Payable_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Financial_Recurrence" ADD CONSTRAINT "Financial_Recurrence_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialRecords" ADD CONSTRAINT "FinancialRecords_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fiscal_Settings" ADD CONSTRAINT "Fiscal_Settings_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fiscal_ServiceCode" ADD CONSTRAINT "Fiscal_ServiceCode_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fiscal_Invoice" ADD CONSTRAINT "Fiscal_Invoice_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fiscal_ReceivedInvoice" ADD CONSTRAINT "Fiscal_ReceivedInvoice_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hr_Employee" ADD CONSTRAINT "Hr_Employee_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service_Order" ADD CONSTRAINT "Service_Order_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_Rental" ADD CONSTRAINT "Stock_Rental_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Company_Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ------------------------------------------------------------------ dados de hoje
-- O CNPJ que está no cadastro da empresa vira o primeiro (e padrão) do grupo,
-- atendendo todas as frentes. Os outros são cadastrados na tela "Empresas do grupo".
INSERT INTO "Company_Entity" ("companyId", "cnpj", "corporateName", "tradeName", "kinds", "isDefault", "logoUrl", "stateId", "cityId",
  "zipCode", "address", "addressNumber", "addressComplement", "neighborhood", "email", "phone", "municipalRegistration", "updatedAt")
SELECT c."id", regexp_replace(c."cnpj", '\D', '', 'g'), c."corporate_name", left(c."comercial_name", 120), ARRAY['treinamento', 'servico', 'locacao'], true,
  c."logoUrl", c."stateId", c."cityId", left(c."zipCode", 9), c."address", left(c."addressNumber", 20), left(c."addressComplement", 120),
  left(c."neighborhood", 120), COALESCE(c."financial_email", c."representative_email"), left(COALESCE(c."financial_contact", c."representative_contact"), 30),
  fs."municipalRegistration", CURRENT_TIMESTAMP
FROM "Company" c
LEFT JOIN "Fiscal_Settings" fs ON fs."companyId" = c."id"
WHERE NOT EXISTS (SELECT 1 FROM "Company_Entity" e WHERE e."companyId" = c."id");

-- CNPJ que o sistema usa quando nada indica outro: o que atende a frente (kind),
-- senão o padrão, senão o mais antigo
CREATE OR REPLACE FUNCTION ws_entity_default(p_company INTEGER, p_kind TEXT) RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT e."id" FROM "Company_Entity" e
  WHERE e."companyId" = p_company AND e."inactiveAt" IS NULL
  ORDER BY (p_kind IS NOT NULL AND p_kind = ANY(e."kinds")) DESC, e."isDefault" DESC, e."id"
  LIMIT 1
$$;

-- tudo o que já existe fica com o CNPJ padrão
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['Commercial_Contract', 'Commercial_Proposal', 'CompanyGateWays', 'Course', 'CourseClass', 'FinancialRecords',
    'Financial_BankAccount', 'Financial_Payable', 'Financial_Recurrence', 'Fiscal_Invoice', 'Fiscal_ReceivedInvoice', 'Fiscal_Settings',
    'Hr_Employee', 'Service_Order', 'Stock_Rental'] LOOP
    EXECUTE format('UPDATE %I SET "entityId" = ws_entity_default("companyId", NULL) WHERE "entityId" IS NULL AND "companyId" IS NOT NULL', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ gatilhos
-- Registro criado sem CNPJ herda da origem; sem origem, o CNPJ da frente.
-- Assim nenhum caminho antigo (checkout, bots, recorrência...) fica sem CNPJ.

CREATE OR REPLACE FUNCTION ws_entity_fill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v INTEGER;
  j JSONB := to_jsonb(NEW);
  company INTEGER := NULLIF(j->>'companyId', '')::INTEGER;
BEGIN
  IF NEW."entityId" IS NOT NULL OR company IS NULL THEN RETURN NEW; END IF;
  CASE TG_TABLE_NAME
    WHEN 'Course' THEN
      v := ws_entity_default(company, 'treinamento');
    WHEN 'CourseClass' THEN
      SELECT c."entityId" INTO v FROM "Course" c WHERE c."id" = (j->>'courseId')::INTEGER;
      v := COALESCE(v, ws_entity_default(company, 'treinamento'));
    WHEN 'Commercial_Proposal' THEN
      v := ws_entity_default(company, j->>'kind');
    WHEN 'Commercial_Contract' THEN
      SELECT p."entityId" INTO v FROM "Commercial_Proposal" p WHERE p."id" = (j->>'proposalId')::INTEGER;
      v := COALESCE(v, ws_entity_default(company, j->>'kind'));
    WHEN 'Service_Order' THEN
      SELECT COALESCE(ct."entityId", p."entityId") INTO v FROM (SELECT 1) x
        LEFT JOIN "Commercial_Contract" ct ON ct."id" = (j->>'contractId')::INTEGER
        LEFT JOIN "Commercial_Proposal" p ON p."id" = (j->>'proposalId')::INTEGER;
      v := COALESCE(v, ws_entity_default(company, 'servico'));
    WHEN 'Stock_Rental' THEN
      SELECT COALESCE(ct."entityId", p."entityId", so."entityId") INTO v FROM (SELECT 1) x
        LEFT JOIN "Commercial_Contract" ct ON ct."id" = (j->>'contractId')::INTEGER
        LEFT JOIN "Commercial_Proposal" p ON p."id" = (j->>'proposalId')::INTEGER
        LEFT JOIN "Service_Order" so ON so."id" = (j->>'serviceOrderId')::INTEGER;
      v := COALESCE(v, ws_entity_default(company, 'locacao'));
    WHEN 'FinancialRecords' THEN
      SELECT COALESCE(ct."entityId", mct."entityId", cl."entityId", fi."entityId", rc."entityId", ba."entityId") INTO v FROM (SELECT 1) x
        LEFT JOIN "Commercial_Contract" ct ON ct."id" = (j->>'contractId')::INTEGER
        LEFT JOIN "Commercial_Measurement" m ON m."id" = (j->>'measurementId')::INTEGER
        LEFT JOIN "Commercial_Contract" mct ON mct."id" = m."contractId"
        LEFT JOIN "CourseClassSubscription" s ON s."id" = (j->>'subscriptionId')::INTEGER
        LEFT JOIN "CourseClass" cl ON cl."id" = s."classId"
        LEFT JOIN "Fiscal_Invoice" fi ON fi."id" = (j->>'fiscalInvoiceId')::INTEGER
        LEFT JOIN "Financial_Recurrence" rc ON rc."id" = (j->>'recurrenceId')::INTEGER
        LEFT JOIN "Financial_BankAccount" ba ON ba."id" = (j->>'bankAccountId')::INTEGER;
      v := COALESCE(v, ws_entity_default(company, CASE WHEN j->>'subscriptionId' IS NOT NULL THEN 'treinamento' END));
    WHEN 'Financial_Payable' THEN
      SELECT COALESCE(so."entityId", pso."entityId", pr."entityId", pcl."entityId", rc."entityId", ba."entityId") INTO v FROM (SELECT 1) x
        LEFT JOIN "Service_Order" so ON so."id" = (j->>'serviceOrderId')::INTEGER
        LEFT JOIN "Purchase_Order" po ON po."id" = (j->>'purchaseOrderId')::INTEGER
        LEFT JOIN "Service_Order" pso ON pso."id" = po."serviceOrderId"
        LEFT JOIN "Stock_Rental" pr ON pr."id" = po."rentalId"
        LEFT JOIN "CourseClass" pcl ON pcl."id" = po."classId"
        LEFT JOIN "Financial_Recurrence" rc ON rc."id" = (j->>'recurrenceId')::INTEGER
        LEFT JOIN "Financial_BankAccount" ba ON ba."id" = (j->>'bankAccountId')::INTEGER;
      v := COALESCE(v, ws_entity_default(company, NULL));
    WHEN 'Financial_Recurrence' THEN
      SELECT so."entityId" INTO v FROM "Service_Order" so WHERE so."id" = (j->>'serviceOrderId')::INTEGER;
      v := COALESCE(v, ws_entity_default(company, NULL));
    ELSE
      v := ws_entity_default(company, NULL);
  END CASE;
  NEW."entityId" := v;
  RETURN NEW;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['Commercial_Contract', 'Commercial_Proposal', 'CompanyGateWays', 'Course', 'CourseClass', 'FinancialRecords',
    'Financial_BankAccount', 'Financial_Payable', 'Financial_Recurrence', 'Fiscal_Invoice', 'Fiscal_ReceivedInvoice', 'Fiscal_Settings',
    'Hr_Employee', 'Service_Order', 'Stock_Rental'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS ws_entity_fill ON %I', t);
    EXECUTE format('CREATE TRIGGER ws_entity_fill BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION ws_entity_fill()', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ permissões
INSERT INTO "Permission" ("name", "description", "group")
SELECT v.name, v.description, 'empresa' FROM (VALUES
  ('config_empresas_grupo', 'Cadastrar os CNPJs do grupo e distribuir registros entre eles')
) AS v(name, description)
WHERE NOT EXISTS (SELECT 1 FROM "Permission" p WHERE p."name" = v.name);

-- super e quem já edita a empresa ou configura o fiscal
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT DISTINCT x."profileId", perm."id" FROM (
  SELECT p."id" AS "profileId" FROM "Profile" p WHERE p."name" = 'super'
  UNION
  SELECT pp."profileId" FROM "ProfilePermission" pp JOIN "Permission" base ON base."id" = pp."permissionId" AND base."name" IN ('update_company', 'config_fiscal')
) x CROSS JOIN "Permission" perm
WHERE perm."name" = 'config_empresas_grupo'
AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" y WHERE y."profileId" = x."profileId" AND y."permissionId" = perm."id");
