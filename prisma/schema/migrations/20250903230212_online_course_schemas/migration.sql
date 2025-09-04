-- CreateEnum
CREATE TYPE "public"."ContentType" AS ENUM ('VIDEO', 'TEXT', 'QUIZ');

-- CreateEnum
CREATE TYPE "public"."LessonProgressStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

-- AlterTable
ALTER TABLE "public"."CourseClass" ADD COLUMN     "onlineLessonId" TEXT;

-- CreateTable
CREATE TABLE "public"."OnlineLesson" (
    "id" TEXT NOT NULL,
    "courseId" INTEGER NOT NULL,
    "companyId" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "version" VARCHAR(50),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "progressConfig" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "OnlineLesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OnlineLessonStep" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "order" INTEGER NOT NULL,
    "contentType" "public"."ContentType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "OnlineLessonStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OnlineQuizResponse" (
    "id" TEXT NOT NULL,
    "traineeId" INTEGER NOT NULL,
    "stepId" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "responses" JSONB NOT NULL,
    "score" INTEGER NOT NULL,
    "maxScore" INTEGER NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "timeSpent" INTEGER,
    "deviceType" VARCHAR(50),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnlineQuizResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OnlineStudentLessonProgress" (
    "id" TEXT NOT NULL,
    "traineeId" INTEGER NOT NULL,
    "lessonId" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "status" "public"."LessonProgressStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "currentStepOrder" INTEGER NOT NULL DEFAULT 1,
    "maxStepReached" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastAccessAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),
    "onlineLessonStepId" TEXT,

    CONSTRAINT "OnlineStudentLessonProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OnlineStudentStepProgress" (
    "id" TEXT NOT NULL,
    "traineeId" INTEGER NOT NULL,
    "stepId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "progressData" JSONB NOT NULL DEFAULT '{}',
    "firstAccessAt" TIMESTAMP(3),
    "lastAccessAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "OnlineStudentStepProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnlineLesson_courseId_isActive_idx" ON "public"."OnlineLesson"("courseId", "isActive");

-- CreateIndex
CREATE INDEX "OnlineLessonStep_lessonId_order_idx" ON "public"."OnlineLessonStep"("lessonId", "order");

-- CreateIndex
CREATE INDEX "OnlineQuizResponse_stepId_idx" ON "public"."OnlineQuizResponse"("stepId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineQuizResponse_traineeId_stepId_key" ON "public"."OnlineQuizResponse"("traineeId", "stepId");

-- CreateIndex
CREATE INDEX "OnlineStudentLessonProgress_traineeId_idx" ON "public"."OnlineStudentLessonProgress"("traineeId");

-- CreateIndex
CREATE INDEX "OnlineStudentLessonProgress_status_idx" ON "public"."OnlineStudentLessonProgress"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineStudentLessonProgress_traineeId_lessonId_key" ON "public"."OnlineStudentLessonProgress"("traineeId", "lessonId");

-- CreateIndex
CREATE INDEX "OnlineStudentStepProgress_traineeId_idx" ON "public"."OnlineStudentStepProgress"("traineeId");

-- CreateIndex
CREATE INDEX "OnlineStudentStepProgress_stepId_idx" ON "public"."OnlineStudentStepProgress"("stepId");

-- CreateIndex
CREATE INDEX "OnlineStudentStepProgress_progressPercent_idx" ON "public"."OnlineStudentStepProgress"("progressPercent");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineStudentStepProgress_traineeId_stepId_key" ON "public"."OnlineStudentStepProgress"("traineeId", "stepId");

-- AddForeignKey
ALTER TABLE "public"."CourseClass" ADD CONSTRAINT "CourseClass_onlineLessonId_fkey" FOREIGN KEY ("onlineLessonId") REFERENCES "public"."OnlineLesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineLesson" ADD CONSTRAINT "OnlineLesson_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "public"."Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineLessonStep" ADD CONSTRAINT "OnlineLessonStep_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "public"."OnlineLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineQuizResponse" ADD CONSTRAINT "OnlineQuizResponse_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "public"."Trainee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineQuizResponse" ADD CONSTRAINT "OnlineQuizResponse_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "public"."OnlineLessonStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineStudentLessonProgress" ADD CONSTRAINT "OnlineStudentLessonProgress_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "public"."Trainee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineStudentLessonProgress" ADD CONSTRAINT "OnlineStudentLessonProgress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "public"."OnlineLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineStudentLessonProgress" ADD CONSTRAINT "OnlineStudentLessonProgress_onlineLessonStepId_fkey" FOREIGN KEY ("onlineLessonStepId") REFERENCES "public"."OnlineLessonStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineStudentStepProgress" ADD CONSTRAINT "OnlineStudentStepProgress_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "public"."Trainee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineStudentStepProgress" ADD CONSTRAINT "OnlineStudentStepProgress_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "public"."OnlineLessonStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineStudentStepProgress" ADD CONSTRAINT "OnlineStudentStepProgress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "public"."OnlineLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
