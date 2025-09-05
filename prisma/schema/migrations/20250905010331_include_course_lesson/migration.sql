-- AddForeignKey
ALTER TABLE "public"."OnlineLesson" ADD CONSTRAINT "OnlineLesson_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "public"."Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;
