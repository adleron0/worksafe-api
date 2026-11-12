-- Categoria e marca dos produtos do site (filtros da loja)
ALTER TABLE "Site_Products" ADD COLUMN "category" VARCHAR(100);
ALTER TABLE "Site_Products" ADD COLUMN "brand" VARCHAR(100);
