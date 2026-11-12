-- Categoria/marca deixam de ser texto livre e passam a ter cadastro próprio.
-- As colunas de texto foram criadas no mesmo dia e nunca receberam dados.
ALTER TABLE "Site_Products" DROP COLUMN "category";
ALTER TABLE "Site_Products" DROP COLUMN "brand";

CREATE TABLE "Site_ProductCategory" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),
    CONSTRAINT "Site_ProductCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Site_ProductBrand" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),
    CONSTRAINT "Site_ProductBrand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Site_ProductCategory_companyId_name_key" ON "Site_ProductCategory"("companyId", "name");
CREATE UNIQUE INDEX "Site_ProductBrand_companyId_name_key" ON "Site_ProductBrand"("companyId", "name");

ALTER TABLE "Site_Products" ADD COLUMN "categoryId" INTEGER;
ALTER TABLE "Site_Products" ADD COLUMN "brandId" INTEGER;

ALTER TABLE "Site_Products" ADD CONSTRAINT "Site_Products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Site_ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Site_Products" ADD CONSTRAINT "Site_Products_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Site_ProductBrand"("id") ON DELETE SET NULL ON UPDATE CASCADE;
