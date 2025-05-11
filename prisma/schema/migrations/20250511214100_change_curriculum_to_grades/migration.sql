/*
  Warnings:

  - You are about to drop the column `curriculum` on the `CourseClass` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "CourseClass" DROP COLUMN "curriculum",
ADD COLUMN     "gradePracticle" TEXT,
ADD COLUMN     "gradeTheory" TEXT;
