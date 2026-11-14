-- Acompanhamento comercial: contatos feitos e retornos marcados com o cliente.
CREATE TABLE "Commercial_Activity" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "proposalId" INTEGER,
    "type" VARCHAR(20) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "notes" TEXT,
    "contactName" VARCHAR(160),
    "dueDate" DATE,
    "dueTime" VARCHAR(5),
    "doneAt" TIMESTAMP(3),
    "result" VARCHAR(2000),
    "userId" INTEGER,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Commercial_Activity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Commercial_Activity_companyId_proposalId_idx" ON "Commercial_Activity"("companyId", "proposalId");
CREATE INDEX "Commercial_Activity_companyId_customerId_idx" ON "Commercial_Activity"("companyId", "customerId");
CREATE INDEX "Commercial_Activity_companyId_doneAt_dueDate_idx" ON "Commercial_Activity"("companyId", "doneAt", "dueDate");
