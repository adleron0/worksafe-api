-- AlterTable
ALTER TABLE "public"."TraineeCourseCertificate" ADD COLUMN     "fabric_json_back" JSONB,
ADD COLUMN     "fabric_json_front" JSONB,
ADD COLUMN     "variable_to_replace" JSONB;
