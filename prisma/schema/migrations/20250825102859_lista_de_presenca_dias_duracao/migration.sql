-- AlterTable
ALTER TABLE "public"."CourseClass" ADD COLUMN     "daysDuration" INTEGER;

-- CreateTable
CREATE TABLE "public"."CourseClassExamAttendanceList" (
    "id" SERIAL NOT NULL,
    "day" INTEGER NOT NULL,
    "IsPresent" BOOLEAN NOT NULL DEFAULT false,
    "traineeId" INTEGER NOT NULL,
    "classId" INTEGER NOT NULL,
    "companyId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CourseClassExamAttendanceList_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."CourseClassExamAttendanceList" ADD CONSTRAINT "CourseClassExamAttendanceList_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "public"."Trainee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CourseClassExamAttendanceList" ADD CONSTRAINT "CourseClassExamAttendanceList_classId_fkey" FOREIGN KEY ("classId") REFERENCES "public"."CourseClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
