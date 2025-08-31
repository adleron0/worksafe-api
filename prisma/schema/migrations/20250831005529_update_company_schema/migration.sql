/*
  Warnings:

  - You are about to drop the column `region` on the `Company` table. All the data in the column will be lost.
  - You are about to drop the column `state` on the `Company` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."Company" DROP COLUMN "region",
DROP COLUMN "state",
ADD COLUMN     "address" VARCHAR(255),
ADD COLUMN     "addressComplement" VARCHAR(255),
ADD COLUMN     "addressNumber" VARCHAR(255),
ADD COLUMN     "cityId" INTEGER,
ADD COLUMN     "description" VARCHAR(355),
ADD COLUMN     "email_conection" JSONB,
ADD COLUMN     "facebookUrl" VARCHAR(255),
ADD COLUMN     "financial_contact" VARCHAR(50),
ADD COLUMN     "financial_email" VARCHAR(255),
ADD COLUMN     "instagramUrl" VARCHAR(255),
ADD COLUMN     "linkedinUrl" VARCHAR(255),
ADD COLUMN     "logoUrl" VARCHAR(255),
ADD COLUMN     "lp_domain" VARCHAR(255),
ADD COLUMN     "neighborhood" VARCHAR(255),
ADD COLUMN     "operational_contact" VARCHAR(50),
ADD COLUMN     "operational_email" VARCHAR(255),
ADD COLUMN     "primary_color" VARCHAR(7),
ADD COLUMN     "representative_contact" VARCHAR(50),
ADD COLUMN     "secondary_color" VARCHAR(7),
ADD COLUMN     "stateId" INTEGER,
ADD COLUMN     "system_domain" VARCHAR(255),
ADD COLUMN     "websiteUrl" VARCHAR(255),
ADD COLUMN     "zipCode" VARCHAR(255),
ALTER COLUMN "representative_email" DROP NOT NULL,
ALTER COLUMN "segment" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."Company" ADD CONSTRAINT "Company_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "public"."DOM_States"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Company" ADD CONSTRAINT "Company_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "public"."DOM_Cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
