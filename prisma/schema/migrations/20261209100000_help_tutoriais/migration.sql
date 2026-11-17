-- CreateTable
CREATE TABLE "Help_State" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "tourId" VARCHAR(80) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Help_State_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Help_Event" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "event" VARCHAR(30) NOT NULL,
    "tourId" VARCHAR(80),
    "step" INTEGER,
    "target" VARCHAR(120),
    "route" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Help_Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Help_State_userId_tourId_key" ON "Help_State"("userId", "tourId");

-- CreateIndex
CREATE INDEX "Help_State_companyId_idx" ON "Help_State"("companyId");

-- CreateIndex
CREATE INDEX "Help_Event_companyId_createdAt_idx" ON "Help_Event"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Help_Event_tourId_event_idx" ON "Help_Event"("tourId", "event");
