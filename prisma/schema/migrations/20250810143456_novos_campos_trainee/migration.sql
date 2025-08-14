-- AlterTable
ALTER TABLE "public"."Trainee" ADD COLUMN     "address" VARCHAR(255),
ADD COLUMN     "addressNumber" INTEGER,
ADD COLUMN     "birthDate" TIMESTAMP(3),
ADD COLUMN     "cityId" INTEGER,
ADD COLUMN     "complement" VARCHAR(100),
ADD COLUMN     "email" VARCHAR(100),
ADD COLUMN     "password" VARCHAR(255),
ADD COLUMN     "phone" VARCHAR(20),
ADD COLUMN     "stateId" INTEGER,
ADD COLUMN     "zipCode" VARCHAR(10);

-- AddForeignKey
ALTER TABLE "public"."Trainee" ADD CONSTRAINT "Trainee_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "public"."DOM_Cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Trainee" ADD CONSTRAINT "Trainee_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "public"."DOM_States"("id") ON DELETE SET NULL ON UPDATE CASCADE;
