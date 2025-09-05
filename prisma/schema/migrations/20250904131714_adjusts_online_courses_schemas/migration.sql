/*
  Warnings:

  - You are about to drop the column `onlineLessonId` on the `CourseClass` table. All the data in the column will be lost.
  - You are about to drop the column `courseId` on the `OnlineLesson` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."CourseClass" DROP CONSTRAINT "CourseClass_onlineLessonId_fkey";

-- DropForeignKey
ALTER TABLE "public"."OnlineLesson" DROP CONSTRAINT "OnlineLesson_courseId_fkey";

-- DropIndex
DROP INDEX "public"."OnlineLesson_courseId_isActive_idx";

-- AlterTable
ALTER TABLE "public"."CourseClass" DROP COLUMN "onlineLessonId",
ADD COLUMN     "onlineCourseModelId" INTEGER;

-- AlterTable
ALTER TABLE "public"."OnlineLesson" DROP COLUMN "courseId";

-- CreateTable
CREATE TABLE "public"."OnlineCourseModel" (
    "id" SERIAL NOT NULL,
    "courseId" INTEGER NOT NULL,
    "companyId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnlineCourseModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OnlineModelLesson" (
    "id" SERIAL NOT NULL,
    "modelId" INTEGER NOT NULL,
    "lessonId" INTEGER NOT NULL,
    "companyId" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "OnlineModelLesson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnlineCourseModel_courseId_isActive_idx" ON "public"."OnlineCourseModel"("courseId", "isActive");

-- CreateIndex
CREATE INDEX "OnlineModelLesson_modelId_order_idx" ON "public"."OnlineModelLesson"("modelId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineModelLesson_modelId_lessonId_key" ON "public"."OnlineModelLesson"("modelId", "lessonId");

-- AddForeignKey
ALTER TABLE "public"."CourseClass" ADD CONSTRAINT "CourseClass_onlineCourseModelId_fkey" FOREIGN KEY ("onlineCourseModelId") REFERENCES "public"."OnlineCourseModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineCourseModel" ADD CONSTRAINT "OnlineCourseModel_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "public"."Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineModelLesson" ADD CONSTRAINT "OnlineModelLesson_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "public"."OnlineCourseModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OnlineModelLesson" ADD CONSTRAINT "OnlineModelLesson_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "public"."OnlineLesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
