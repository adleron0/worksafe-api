/*
  Warnings:

  - The `onlineLessonId` column on the `CourseClass` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `OnlineLesson` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `OnlineLesson` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `OnlineLessonStep` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `OnlineLessonStep` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `OnlineQuizResponse` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `OnlineQuizResponse` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `OnlineStudentLessonProgress` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `onlineLessonStepId` on the `OnlineStudentLessonProgress` table. All the data in the column will be lost.
  - The `id` column on the `OnlineStudentLessonProgress` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `OnlineStudentStepProgress` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `OnlineStudentStepProgress` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `lessonId` on the `OnlineLessonStep` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `stepId` on the `OnlineQuizResponse` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `lessonId` on the `OnlineStudentLessonProgress` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `stepId` on the `OnlineStudentStepProgress` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `lessonId` on the `OnlineStudentStepProgress` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "public"."CourseClass" DROP CONSTRAINT "CourseClass_onlineLessonId_fkey";

-- DropForeignKey
ALTER TABLE "public"."OnlineLessonStep" DROP CONSTRAINT "OnlineLessonStep_lessonId_fkey";

-- DropForeignKey
ALTER TABLE "public"."OnlineQuizResponse" DROP CONSTRAINT "OnlineQuizResponse_stepId_fkey";

-- DropForeignKey
ALTER TABLE "public"."OnlineStudentLessonProgress" DROP CONSTRAINT "OnlineStudentLessonProgress_lessonId_fkey";

-- DropForeignKey
ALTER TABLE "public"."OnlineStudentLessonProgress" DROP CONSTRAINT "OnlineStudentLessonProgress_onlineLessonStepId_fkey";

-- DropForeignKey
ALTER TABLE "public"."OnlineStudentStepProgress" DROP CONSTRAINT "OnlineStudentStepProgress_lessonId_fkey";

-- DropForeignKey
ALTER TABLE "public"."OnlineStudentStepProgress" DROP CONSTRAINT "OnlineStudentStepProgress_stepId_fkey";

-- AlterTable
ALTER TABLE "public"."CourseClass" DROP COLUMN "onlineLessonId",
ADD COLUMN     "onlineLessonId" INTEGER;

-- AlterTable
ALTER TABLE "public"."OnlineLesson" DROP CONSTRAINT "OnlineLesson_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "OnlineLesson_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."OnlineLessonStep" DROP CONSTRAINT "OnlineLessonStep_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "lessonId",
ADD COLUMN     "lessonId" INTEGER NOT NULL,
ADD CONSTRAINT "OnlineLessonStep_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."OnlineQuizResponse" DROP CONSTRAINT "OnlineQuizResponse_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "stepId",
ADD COLUMN     "stepId" INTEGER NOT NULL,
ADD CONSTRAINT "OnlineQuizResponse_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."OnlineStudentLessonProgress" DROP CONSTRAINT "OnlineStudentLessonProgress_pkey",
DROP COLUMN "onlineLessonStepId",
ADD COLUMN     "lessonStepId" INTEGER,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "lessonId",
ADD COLUMN     "lessonId" INTEGER NOT NULL,
ADD CONSTRAINT "OnlineStudentLessonProgress_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."OnlineStudentStepProgress" DROP CONSTRAINT "OnlineStudentStepProgress_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "stepId",
ADD COLUMN     "stepId" INTEGER NOT NULL,
DROP COLUMN "lessonId",
ADD COLUMN     "lessonId" INTEGER NOT NULL,
ADD CONSTRAINT "OnlineStudentStepProgress_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE INDEX "OnlineLessonStep_lessonId_order_idx" ON "public"."OnlineLessonStep"("lessonId", "order");

-- CreateIndex
CREATE INDEX "OnlineQuizResponse_stepId_idx" ON "public"."OnlineQuizResponse"("stepId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineQuizResponse_traineeId_stepId_key" ON "public"."OnlineQuizResponse"("traineeId", "stepId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineStudentLessonProgress_traineeId_lessonId_key" ON "public"."OnlineStudentLessonProgress"("traineeId", "lessonId");

-- CreateIndex
CREATE INDEX "OnlineStudentStepProgress_stepId_idx" ON "public"."OnlineStudentStepProgress"("stepId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineStudentStepProgress_traineeId_stepId_key" ON "public"."OnlineStudentStepProgress"("traineeId", "stepId");

-- AddForeignKey
ALTER TABLE "public"."CourseClass" ADD CONSTRAINT "CourseClass_onlineLessonId_fkey" FOREIGN KEY ("onlineLessonId") REFERENCES "public"."OnlineLesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineLessonStep" ADD CONSTRAINT "OnlineLessonStep_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "public"."OnlineLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineQuizResponse" ADD CONSTRAINT "OnlineQuizResponse_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "public"."OnlineLessonStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineStudentLessonProgress" ADD CONSTRAINT "OnlineStudentLessonProgress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "public"."OnlineLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineStudentLessonProgress" ADD CONSTRAINT "OnlineStudentLessonProgress_lessonStepId_fkey" FOREIGN KEY ("lessonStepId") REFERENCES "public"."OnlineLessonStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineStudentStepProgress" ADD CONSTRAINT "OnlineStudentStepProgress_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "public"."OnlineLessonStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineStudentStepProgress" ADD CONSTRAINT "OnlineStudentStepProgress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "public"."OnlineLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
