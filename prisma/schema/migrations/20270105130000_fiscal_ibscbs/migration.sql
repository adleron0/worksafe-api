-- Área fiscal: grupo IBS/CBS (reforma tributária) e data da NFS-e de locação
ALTER TABLE "Fiscal_Settings" ADD COLUMN "ibsCbsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Fiscal_Settings" ADD COLUMN "rentalNfseFrom" DATE;
ALTER TABLE "Fiscal_ServiceCode" ADD COLUMN "ibsCbsIndOp" VARCHAR(6);
ALTER TABLE "Fiscal_ServiceCode" ADD COLUMN "ibsCbsClassTrib" VARCHAR(6);
