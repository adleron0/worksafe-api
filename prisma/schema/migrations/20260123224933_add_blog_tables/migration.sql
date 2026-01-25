-- CreateEnum
CREATE TYPE "public"."BlogPostStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "public"."BlogCommentStatus" AS ENUM ('published', 'hidden', 'spam');

-- CreateTable
CREATE TABLE "public"."Blog_Category" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "description" VARCHAR(500),
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Blog_Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Blog_Comment" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "postId" INTEGER NOT NULL,
    "parentId" INTEGER,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "visitorId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "rating" INTEGER,
    "status" "public"."BlogCommentStatus" NOT NULL DEFAULT 'published',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Blog_Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Blog_Post" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "authorId" INTEGER NOT NULL,
    "categoryId" INTEGER,
    "title" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "excerpt" VARCHAR(500),
    "content" TEXT NOT NULL,
    "coverImage" VARCHAR(500),
    "status" "public"."BlogPostStatus" NOT NULL DEFAULT 'draft',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Blog_Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Blog_PostTag" (
    "postId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Blog_PostTag_pkey" PRIMARY KEY ("postId","tagId")
);

-- CreateTable
CREATE TABLE "public"."Blog_Tag" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Blog_Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Blog_Visitor" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "avatarUrl" VARCHAR(500),
    "googleId" VARCHAR(255) NOT NULL,
    "userId" INTEGER,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Blog_Visitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Blog_Category_companyId_slug_key" ON "public"."Blog_Category"("companyId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Blog_Post_companyId_slug_key" ON "public"."Blog_Post"("companyId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Blog_Tag_companyId_slug_key" ON "public"."Blog_Tag"("companyId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Blog_Visitor_companyId_email_key" ON "public"."Blog_Visitor"("companyId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Blog_Visitor_companyId_googleId_key" ON "public"."Blog_Visitor"("companyId", "googleId");

-- AddForeignKey
ALTER TABLE "public"."Blog_Category" ADD CONSTRAINT "Blog_Category_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_Comment" ADD CONSTRAINT "Blog_Comment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_Comment" ADD CONSTRAINT "Blog_Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "public"."Blog_Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_Comment" ADD CONSTRAINT "Blog_Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."Blog_Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_Comment" ADD CONSTRAINT "Blog_Comment_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "public"."Blog_Visitor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_Post" ADD CONSTRAINT "Blog_Post_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_Post" ADD CONSTRAINT "Blog_Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_Post" ADD CONSTRAINT "Blog_Post_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."Blog_Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_PostTag" ADD CONSTRAINT "Blog_PostTag_postId_fkey" FOREIGN KEY ("postId") REFERENCES "public"."Blog_Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_PostTag" ADD CONSTRAINT "Blog_PostTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "public"."Blog_Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_Tag" ADD CONSTRAINT "Blog_Tag_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_Visitor" ADD CONSTRAINT "Blog_Visitor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Blog_Visitor" ADD CONSTRAINT "Blog_Visitor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
