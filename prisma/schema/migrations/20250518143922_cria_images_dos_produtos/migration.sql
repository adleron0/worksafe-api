-- CreateTable
CREATE TABLE "Site_ProductsImages" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "imageUrl" VARCHAR(255),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Site_ProductsImages_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Site_ProductsImages" ADD CONSTRAINT "Site_ProductsImages_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Site_Products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
