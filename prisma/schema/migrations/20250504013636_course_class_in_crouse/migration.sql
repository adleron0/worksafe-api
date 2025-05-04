/*
  Warnings:

  - Made the column `courseId` on table `CourseClass` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "CourseClass" ALTER COLUMN "courseId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "CourseClass" ADD CONSTRAINT "CourseClass_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
