-- AlterTable
ALTER TABLE "CourseClass" ADD COLUMN     "landingAbLayouts" JSONB,
ADD COLUMN     "landingAbTest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "landingContent" JSONB,
ADD COLUMN     "landingLayout" VARCHAR(20);

-- AlterTable
ALTER TABLE "CourseClassSubscription" ADD COLUMN     "landingLayout" VARCHAR(20),
ADD COLUMN     "landingOption" VARCHAR(120),
ADD COLUMN     "landingVisitor" VARCHAR(40),
ADD COLUMN     "referrer" VARCHAR(255),
ADD COLUMN     "utmCampaign" VARCHAR(120),
ADD COLUMN     "utmMedium" VARCHAR(120),
ADD COLUMN     "utmSource" VARCHAR(120);

-- CreateTable
CREATE TABLE "CourseClass_LandingEvent" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "classId" INTEGER NOT NULL,
    "visitorId" VARCHAR(40) NOT NULL,
    "layout" VARCHAR(20) NOT NULL,
    "event" VARCHAR(30) NOT NULL,
    "block" VARCHAR(30),
    "source" VARCHAR(120),
    "medium" VARCHAR(120),
    "campaign" VARCHAR(120),
    "device" VARCHAR(10),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseClass_LandingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourseClass_LandingEvent_classId_layout_event_idx" ON "CourseClass_LandingEvent"("classId", "layout", "event");

-- CreateIndex
CREATE INDEX "CourseClass_LandingEvent_companyId_createdAt_idx" ON "CourseClass_LandingEvent"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "CourseClass_LandingEvent_classId_visitorId_idx" ON "CourseClass_LandingEvent"("classId", "visitorId");

-- CreateIndex
CREATE INDEX "CourseClassSubscription_classId_landingLayout_idx" ON "CourseClassSubscription"("classId", "landingLayout");

-- AddForeignKey
ALTER TABLE "CourseClass_LandingEvent" ADD CONSTRAINT "CourseClass_LandingEvent_classId_fkey" FOREIGN KEY ("classId") REFERENCES "CourseClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;
