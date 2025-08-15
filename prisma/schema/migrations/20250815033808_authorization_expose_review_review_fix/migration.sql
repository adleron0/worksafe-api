/*
  Warnings:

  - You are about to drop the column `autorizationExposeReview` on the `CourseReview` table. All the data in the column will be lost.
  - Added the required column `authorizationExposeReview` to the `CourseReview` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."CourseReview" DROP COLUMN "autorizationExposeReview",
ADD COLUMN     "authorizationExposeReview" BOOLEAN NOT NULL;
