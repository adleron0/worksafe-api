-- RH, fase 8: locais da empresa (CTs, bases) e o ponto no mapa de clientes, obras e atividades.
CREATE TABLE "Company_Place" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(12) NOT NULL DEFAULT 'ct',
    "street" VARCHAR(200),
    "number" VARCHAR(20),
    "neighborhood" VARCHAR(120),
    "city" VARCHAR(120),
    "state" VARCHAR(2),
    "zipCode" VARCHAR(10),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "startDate" DATE,
    "endDate" DATE,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Company_Place_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Company_Place_companyId_kind_idx" ON "Company_Place"("companyId", "kind");

ALTER TABLE "Customer" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Customer" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "Customer" ADD COLUMN "geocodedAt" TIMESTAMP(3);

ALTER TABLE "Service_Order" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Service_Order" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "Service_Order" ADD COLUMN "placeId" INTEGER;

ALTER TABLE "Hr_Activity" ADD COLUMN "placeId" INTEGER;

-- Permissões dos locais: ver (para escolher o local numa atividade ou numa obra) e alterar.
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('view_locais', 'Ver os locais da empresa (centros de treinamento, bases) e os pontos no mapa', 'rh'),
  ('update_locais', 'Cadastrar locais da empresa e ajustar pontos no mapa', 'rh')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."name" IN ('view_locais', 'update_locais')
WHERE p."name" IN ('super', 'RH', 'Gestão', 'Operação - gestor') AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
