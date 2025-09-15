-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "address" VARCHAR(255),
ADD COLUMN     "addressComplement" VARCHAR(255),
ADD COLUMN     "addressNumber" VARCHAR(255),
ADD COLUMN     "birthDate" TIMESTAMP(3),
ADD COLUMN     "city" VARCHAR(255),
ADD COLUMN     "neighborhood" VARCHAR(255),
ADD COLUMN     "state" VARCHAR(255),
ADD COLUMN     "zipCode" VARCHAR(255);
