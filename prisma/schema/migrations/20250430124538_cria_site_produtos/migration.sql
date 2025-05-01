-- CreateTable
CREATE TABLE "Site_Products" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "imageUrl" VARCHAR(255),
    "price" DECIMAL(18,2) NOT NULL,
    "oldPrice" DECIMAL(18,2) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "features" VARCHAR(255),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Site_Products_pkey" PRIMARY KEY ("id")
);
