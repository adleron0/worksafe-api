-- AlterTable
ALTER TABLE "Commercial_TaxProfile" ADD COLUMN     "rentalOutsideRate" DECIMAL(7,6),
ADD COLUMN     "rentalRate" DECIMAL(7,6);

-- AlterTable
ALTER TABLE "Stock_Item" ADD COLUMN     "calibrationCost" DECIMAL(12,2),
ADD COLUMN     "economicLifeMonths" INTEGER,
ADD COLUMN     "handlingCost" DECIMAL(12,2),
ADD COLUMN     "inspectionCost" DECIMAL(12,2),
ADD COLUMN     "lossRate" DECIMAL(7,6),
ADD COLUMN     "maintenanceRate" DECIMAL(7,6),
ADD COLUMN     "minRentPeriod" VARCHAR(8),
ADD COLUMN     "occupancy" DECIMAL(7,6),
ADD COLUMN     "rentMode" VARCHAR(12) NOT NULL DEFAULT 'ambos',
ADD COLUMN     "rentPriceMode" VARCHAR(10) NOT NULL DEFAULT 'calculado',
ADD COLUMN     "residualRate" DECIMAL(7,6);

-- CreateTable
CREATE TABLE "Stock_KitComponent" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "kitItemId" INTEGER NOT NULL,
    "componentId" INTEGER NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Stock_KitComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Stock_KitComponent_componentId_idx" ON "Stock_KitComponent"("componentId");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_KitComponent_kitItemId_componentId_key" ON "Stock_KitComponent"("kitItemId", "componentId");

-- AddForeignKey
ALTER TABLE "Stock_KitComponent" ADD CONSTRAINT "Stock_KitComponent_kitItemId_fkey" FOREIGN KEY ("kitItemId") REFERENCES "Stock_Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_KitComponent" ADD CONSTRAINT "Stock_KitComponent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Stock_Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Base de cálculo: parâmetros da locação e margem padrão da seção de
-- locação ao cliente nas versões que ainda não têm (valores do plano 09).
UPDATE "Commercial_CostBase"
SET "defaults" = jsonb_set(
  CASE WHEN ("defaults"::jsonb) ? 'rental' THEN "defaults"::jsonb
       ELSE ("defaults"::jsonb) || jsonb_build_object('rental', jsonb_build_object(
         'capitalRate', 0.01, 'insuranceRate', 0.03, 'residualRate', 0.1, 'maintenanceRate', 0.05, 'occupancy', 0.45,
         'lossRate', 0.005, 'handlingCost', 50, 'inspectionMonths', 6, 'calibrationMonths', 6, 'weekFactor', 0.45, 'dayFactor', 0.15,
         'longDiscounts', jsonb_build_array(
           jsonb_build_object('fromMonths', 3, 'rate', 0.05), jsonb_build_object('fromMonths', 6, 'rate', 0.1), jsonb_build_object('fromMonths', 12, 'rate', 0.15)),
         'marketBand', jsonb_build_object('min', 0.08, 'max', 0.2), 'depositRate', 0))
  END,
  '{margins,locacao_cliente}',
  COALESCE(("defaults"::jsonb) #> '{margins,locacao_cliente}', '0.25'::jsonb)
);
