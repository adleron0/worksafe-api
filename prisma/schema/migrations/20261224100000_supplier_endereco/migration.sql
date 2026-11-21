-- Endereço do fornecedor (texto livre)
ALTER TABLE "Financial_Supplier" ADD COLUMN "zipcode" VARCHAR(10),
ADD COLUMN "street" VARCHAR(255),
ADD COLUMN "number" VARCHAR(20),
ADD COLUMN "complement" VARCHAR(255),
ADD COLUMN "neighborhood" VARCHAR(120),
ADD COLUMN "city" VARCHAR(120),
ADD COLUMN "state" VARCHAR(2);
