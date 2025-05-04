/*
  Warnings:

  - You are about to drop the column `flag` on the `Course` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Course" DROP COLUMN "flag",
ADD COLUMN     "flags" VARCHAR(255);

-- CreateTable
CREATE TABLE "CourseClassInstructor" (
    "id" SERIAL NOT NULL,
    "classId" INTEGER NOT NULL,
    "instructorId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CourseClassInstructor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trainees" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "cpf" VARCHAR(20) NOT NULL,
    "customerId" INTEGER,
    "subscriptionId" INTEGER,
    "imageUrl" VARCHAR(255),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Trainees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourseClassInstructor_classId_instructorId_key" ON "CourseClassInstructor"("classId", "instructorId");

-- AddForeignKey
ALTER TABLE "CourseClassInstructor" ADD CONSTRAINT "CourseClassInstructor_instructorId_fkey" FOREIGN KEY ("instructorId") REFERENCES "Instructor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseClassInstructor" ADD CONSTRAINT "CourseClassInstructor_classId_fkey" FOREIGN KEY ("classId") REFERENCES "CourseClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
