-- AlterTable
ALTER TABLE "CourseClass" ADD COLUMN     "companyGatewayId" INTEGER;

-- AddForeignKey
ALTER TABLE "CourseClass" ADD CONSTRAINT "CourseClass_companyGatewayId_fkey" FOREIGN KEY ("companyGatewayId") REFERENCES "CompanyGateWays"("id") ON DELETE SET NULL ON UPDATE CASCADE;
