-- AlterTable
ALTER TABLE "CourseClass" ADD COLUMN     "customerId" INTEGER;

-- AddForeignKey
ALTER TABLE "CourseClass" ADD CONSTRAINT "CourseClass_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
