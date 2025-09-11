-- CreateTable
CREATE TABLE "public"."password_code" (
    "id" SERIAL NOT NULL,
    "entityType" VARCHAR(20) NOT NULL,
    "entityId" INTEGER NOT NULL,
    "email" VARCHAR(100) NOT NULL,
    "code" VARCHAR(6) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "password_code_expires_at_idx" ON "public"."password_code"("expires_at");

-- CreateIndex
CREATE INDEX "password_code_entityType_entityId_idx" ON "public"."password_code"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "password_code_email_code_key" ON "public"."password_code"("email", "code");
