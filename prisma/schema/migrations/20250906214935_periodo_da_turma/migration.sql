-- CreateEnum
CREATE TYPE "public"."periodClassTypes" AS ENUM ('LIMITED', 'UNLIMITED');

-- AlterTable
ALTER TABLE "public"."CourseClass" ADD COLUMN     "periodClass" "public"."periodClassTypes" NOT NULL DEFAULT 'LIMITED';
