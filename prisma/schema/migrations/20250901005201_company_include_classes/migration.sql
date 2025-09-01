-- AddForeignKey
ALTER TABLE "public"."CourseClass" ADD CONSTRAINT "CourseClass_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
