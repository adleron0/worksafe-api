-- CreateEnum
CREATE TYPE "SubscribeStatus" AS ENUM ('pending', 'confirmed', 'declined');

-- CreateTable
CREATE TABLE "Course" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "hoursDuration" INTEGER,
    "flag" VARCHAR(100),
    "companyId" INTEGER NOT NULL,
    "description" TEXT,
    "gradeTheory" TEXT NOT NULL,
    "gradePracticle" TEXT NOT NULL,
    "imageUrl" VARCHAR(255),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "weekly" BOOLEAN DEFAULT false,
    "weekDays" VARCHAR(255),
    "faq" JSONB,
    "exam" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouseCertificate" (
    "id" SERIAL NOT NULL,
    "courseId" INTEGER NOT NULL,
    "conformity" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "yearsOfValidity" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CouseCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseClass" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "companyId" INTEGER,
    "courseId" INTEGER,
    "price" DECIMAL(18,2),
    "oldPrice" DECIMAL(18,2),
    "hoursDuration" INTEGER,
    "openClass" BOOLEAN DEFAULT false,
    "gifts" TEXT,
    "description" TEXT,
    "curriculum" TEXT,
    "imageUrl" VARCHAR(255),
    "videoUrl" VARCHAR(255),
    "videoTitle" TEXT,
    "videoSubtitle" TEXT,
    "videoDescription" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "faq" JSONB,
    "initialDate" TIMESTAMP(3),
    "finalDate" TIMESTAMP(3),
    "landingPagesDates" TEXT,
    "allowExam" BOOLEAN NOT NULL,
    "allowReview" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CourseClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseClassSubscription" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "cpf" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(255) NOT NULL,
    "workedAt" VARCHAR(255) NOT NULL,
    "occupation" VARCHAR(255) NOT NULL,
    "companyId" INTEGER,
    "classId" INTEGER,
    "traineeId" INTEGER,
    "subscribeStatus" "SubscribeStatus" NOT NULL DEFAULT 'pending',
    "confirmedAt" TIMESTAMP(3),
    "declinedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CourseClassSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseExam" (
    "id" SERIAL NOT NULL,
    "traineeId" INTEGER NOT NULL,
    "courseId" INTEGER NOT NULL,
    "classId" INTEGER NOT NULL,
    "examResponses" JSONB NOT NULL,
    "result" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CourseExam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseReview" (
    "id" SERIAL NOT NULL,
    "traineeId" INTEGER,
    "courseId" INTEGER,
    "courseReview" JSONB NOT NULL,
    "instructorReview" JSONB NOT NULL,
    "generalRating" INTEGER NOT NULL,
    "opinionRating" TEXT,
    "autorizationExposeReview" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "CourseReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instructor" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "companyId" INTEGER NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "cpf" VARCHAR(20) NOT NULL,
    "phone" VARCHAR(255),
    "imageUrl" VARCHAR(255),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "curriculum" TEXT NOT NULL,
    "highlight" TEXT,
    "formation" TEXT NOT NULL,
    "formationCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Instructor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trainee" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "cpf" VARCHAR(20) NOT NULL,
    "customerId" INTEGER,
    "imageUrl" VARCHAR(255),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Trainee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraineeCourseCertificate" (
    "id" SERIAL NOT NULL,
    "courseId" INTEGER NOT NULL,
    "traineeId" INTEGER NOT NULL,
    "classId" INTEGER NOT NULL,
    "conformity" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "yearsOfValidity" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "TraineeCourseCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CouseCertificate_courseId_key" ON "CouseCertificate"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "TraineeCourseCertificate_courseId_key" ON "TraineeCourseCertificate"("courseId");

-- AddForeignKey
ALTER TABLE "CouseCertificate" ADD CONSTRAINT "CouseCertificate_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseClassSubscription" ADD CONSTRAINT "CourseClassSubscription_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "Trainee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseExam" ADD CONSTRAINT "CourseExam_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "Trainee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseExam" ADD CONSTRAINT "CourseExam_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseExam" ADD CONSTRAINT "CourseExam_classId_fkey" FOREIGN KEY ("classId") REFERENCES "CourseClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseReview" ADD CONSTRAINT "CourseReview_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "Trainee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseReview" ADD CONSTRAINT "CourseReview_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraineeCourseCertificate" ADD CONSTRAINT "TraineeCourseCertificate_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraineeCourseCertificate" ADD CONSTRAINT "TraineeCourseCertificate_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "Trainee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraineeCourseCertificate" ADD CONSTRAINT "TraineeCourseCertificate_classId_fkey" FOREIGN KEY ("classId") REFERENCES "CourseClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
