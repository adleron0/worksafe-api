/*
  Warnings:

  - You are about to drop the column `oldPrice` on the `CourseClass` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."CourseClass" DROP COLUMN "oldPrice",
ADD COLUMN     "discountPrice" DECIMAL(18,2);
