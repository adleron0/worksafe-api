/*
  Warnings:

  - You are about to drop the `CourseClassExamAttendanceList` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."CourseClassExamAttendanceList" DROP CONSTRAINT "CourseClassExamAttendanceList_classId_fkey";

-- DropForeignKey
ALTER TABLE "public"."CourseClassExamAttendanceList" DROP CONSTRAINT "CourseClassExamAttendanceList_traineeId_fkey";

-- DropTable
DROP TABLE "public"."CourseClassExamAttendanceList";

-- CreateTable
CREATE TABLE "public"."CourseClassAttendanceList" (
    "id" SERIAL NOT NULL,
    "day" INTEGER NOT NULL,
    "IsPresent" BOOLEAN NOT NULL DEFAULT false,
    "traineeId" INTEGER NOT NULL,
    "classId" INTEGER NOT NULL,
    "companyId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CourseClassAttendanceList_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."CourseClassAttendanceList" ADD CONSTRAINT "CourseClassAttendanceList_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "public"."Trainee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CourseClassAttendanceList" ADD CONSTRAINT "CourseClassAttendanceList_classId_fkey" FOREIGN KEY ("classId") REFERENCES "public"."CourseClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
