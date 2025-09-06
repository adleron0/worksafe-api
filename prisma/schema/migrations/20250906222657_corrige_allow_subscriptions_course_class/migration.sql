/*
  Warnings:

  - You are about to drop the column `allowSubsctiptions` on the `CourseClass` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."CourseClass" DROP COLUMN "allowSubsctiptions",
ADD COLUMN     "allowSubscriptions" BOOLEAN NOT NULL DEFAULT false;
