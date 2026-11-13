-- Páginas de serviço e de curso no site: slug, texto e SEO
ALTER TABLE "Site_Services" ADD COLUMN "slug" VARCHAR(120),
  ADD COLUMN "description" TEXT,
  ADD COLUMN "content" TEXT,
  ADD COLUMN "seoTitle" VARCHAR(70),
  ADD COLUMN "seoDescription" VARCHAR(170),
  ADD COLUMN "faq" JSONB;
CREATE UNIQUE INDEX "Site_Services_companyId_slug_key" ON "Site_Services"("companyId", "slug");

ALTER TABLE "Course" ADD COLUMN "slug" VARCHAR(120),
  ADD COLUMN "content" TEXT,
  ADD COLUMN "seoTitle" VARCHAR(70),
  ADD COLUMN "seoDescription" VARCHAR(170);
CREATE UNIQUE INDEX "Course_companyId_slug_key" ON "Course"("companyId", "slug");
