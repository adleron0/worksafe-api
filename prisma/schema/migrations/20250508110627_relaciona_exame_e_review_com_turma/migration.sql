/*
  Warnings:

  - You are about to drop the `CourseExam` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `classId` to the `CourseReview` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "CourseExam" DROP CONSTRAINT "CourseExam_classId_fkey";

-- DropForeignKey
ALTER TABLE "CourseExam" DROP CONSTRAINT "CourseExam_courseId_fkey";

-- DropForeignKey
ALTER TABLE "CourseExam" DROP CONSTRAINT "CourseExam_traineeId_fkey";

-- AlterTable
ALTER TABLE "CourseReview" ADD COLUMN     "classId" INTEGER NOT NULL;

-- DropTable
DROP TABLE "CourseExam";

-- CreateTable
CREATE TABLE "CourseClassExam" (
    "id" SERIAL NOT NULL,
    "traineeId" INTEGER NOT NULL,
    "courseId" INTEGER NOT NULL,
    "classId" INTEGER NOT NULL,
    "examResponses" JSONB NOT NULL,
    "result" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CourseClassExam_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CourseClassExam" ADD CONSTRAINT "CourseClassExam_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "Trainee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseClassExam" ADD CONSTRAINT "CourseClassExam_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseClassExam" ADD CONSTRAINT "CourseClassExam_classId_fkey" FOREIGN KEY ("classId") REFERENCES "CourseClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseReview" ADD CONSTRAINT "CourseReview_classId_fkey" FOREIGN KEY ("classId") REFERENCES "CourseClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
