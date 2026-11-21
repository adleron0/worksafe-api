-- Dados fiscais e segundo telefone do cliente
ALTER TABLE "Customer" ADD COLUMN "stateRegistration" VARCHAR(30),
ADD COLUMN "municipalRegistration" VARCHAR(30),
ADD COLUMN "icmsContributor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "activityType" VARCHAR(60),
ADD COLUMN "cnae" VARCHAR(255),
ADD COLUMN "simplesNacional" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "phone2" VARCHAR(100);
