-- AddForeignKey
ALTER TABLE "public"."CourseClassSubscription" ADD CONSTRAINT "CourseClassSubscription_classId_fkey" FOREIGN KEY ("classId") REFERENCES "public"."CourseClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;
