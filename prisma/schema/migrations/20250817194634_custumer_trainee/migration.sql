-- AddForeignKey
ALTER TABLE "public"."Trainee" ADD CONSTRAINT "Trainee_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
