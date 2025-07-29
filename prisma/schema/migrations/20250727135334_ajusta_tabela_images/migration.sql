/*
  Warnings:

  - You are about to drop the `images` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "images";

-- CreateTable
CREATE TABLE "Image" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER,
    "name" VARCHAR(255) NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "type" VARCHAR(50) NOT NULL DEFAULT 'certificate',
    "width" INTEGER,
    "height" INTEGER,
    "file_size" INTEGER,
    "mime_type" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Image_imageUrl_idx" ON "Image"("imageUrl");

-- CreateIndex
CREATE INDEX "Image_type_idx" ON "Image"("type");

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
