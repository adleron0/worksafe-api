-- CreateTable
CREATE TABLE "images" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "type" VARCHAR(50) NOT NULL DEFAULT 'certificate',
    "width" INTEGER,
    "height" INTEGER,
    "file_size" INTEGER,
    "mime_type" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "images_imageUrl_idx" ON "images"("imageUrl");

-- CreateIndex
CREATE INDEX "images_type_idx" ON "images"("type");
