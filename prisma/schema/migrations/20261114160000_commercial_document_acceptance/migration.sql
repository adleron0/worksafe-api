-- AlterTable
ALTER TABLE "Commercial_Proposal" ADD COLUMN     "acceptCodeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "acceptCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "acceptCodeHash" VARCHAR(64),
ADD COLUMN     "documentBody" TEXT,
ADD COLUMN     "frozenHash" VARCHAR(64),
ADD COLUMN     "frozenHtml" TEXT,
ADD COLUMN     "itemsMode" VARCHAR(20) NOT NULL DEFAULT 'detalhado',
ADD COLUMN     "publicKey" VARCHAR(40),
ADD COLUMN     "templateId" INTEGER,
ADD COLUMN     "termIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "viewedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Commercial_ProposalTemplate" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" "CommercialProposalKind",
    "body" TEXT NOT NULL,
    "itemsMode" VARCHAR(20) NOT NULL DEFAULT 'detalhado',
    "termIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Commercial_ProposalTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_Term" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "kind" VARCHAR(30) NOT NULL DEFAULT 'geral',
    "body" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Commercial_Term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_ProposalEvent" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "userId" INTEGER,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(400),
    "name" VARCHAR(160),
    "cpf" VARCHAR(14),
    "role" VARCHAR(120),
    "email" VARCHAR(255),
    "documentHash" VARCHAR(64),
    "codeVerified" BOOLEAN,
    "note" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commercial_ProposalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Commercial_ProposalTemplate_companyId_idx" ON "Commercial_ProposalTemplate"("companyId");

-- CreateIndex
CREATE INDEX "Commercial_Term_companyId_idx" ON "Commercial_Term"("companyId");

-- CreateIndex
CREATE INDEX "Commercial_ProposalEvent_proposalId_idx" ON "Commercial_ProposalEvent"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_Proposal_publicKey_key" ON "Commercial_Proposal"("publicKey");

-- AddForeignKey
ALTER TABLE "Commercial_ProposalEvent" ADD CONSTRAINT "Commercial_ProposalEvent_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Commercial_Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

