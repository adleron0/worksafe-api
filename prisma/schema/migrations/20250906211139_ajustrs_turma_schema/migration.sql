-- CreateEnum
CREATE TYPE "public"."periodSubscriptionsTypes" AS ENUM ('LIMITED', 'UNLIMITED');

-- AlterTable
ALTER TABLE "public"."CourseClass" ADD COLUMN     "allowSubsctiptions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "periodSubscriptionsFinalDate" TIMESTAMP(3),
ADD COLUMN     "periodSubscriptionsInitialDate" TIMESTAMP(3),
ADD COLUMN     "periodSubscriptionsType" "public"."periodSubscriptionsTypes" NOT NULL DEFAULT 'LIMITED',
ADD COLUMN     "unlimitedSubscriptions" BOOLEAN NOT NULL DEFAULT false;
