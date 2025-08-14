-- AlterTable
ALTER TABLE "public"."CourseClass" ADD COLUMN     "categoryId" INTEGER,
ADD COLUMN     "certificateId" INTEGER;

-- AddForeignKey
ALTER TABLE "public"."CourseClass" ADD CONSTRAINT "CourseClass_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "public"."CouseCertificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
