/*
  Warnings:

  - Added the required column `companyId` to the `CourseClassExam` table without a default value. This is not possible if the table is not empty.
  - Added the required column `companyId` to the `CourseClassInstructor` table without a default value. This is not possible if the table is not empty.
  - Added the required column `companyId` to the `CourseReview` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "CourseClassExam" ADD COLUMN     "companyId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "CourseClassInstructor" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "companyId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "CourseReview" ADD COLUMN     "companyId" INTEGER NOT NULL;
