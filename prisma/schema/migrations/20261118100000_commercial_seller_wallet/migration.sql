-- CreateTable
CREATE TABLE "Commercial_SellerWallet" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commercial_SellerWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commercial_SellerWalletEntry" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "walletId" INTEGER NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "origin" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "baseValue" DECIMAL(18,2),
    "rate" DECIMAL(7,4),
    "description" VARCHAR(255) NOT NULL,
    "financialRecordId" INTEGER,
    "couponId" INTEGER,
    "classId" INTEGER,
    "subscriptionId" INTEGER,
    "proposalId" INTEGER,
    "contractId" INTEGER,
    "contractInstallmentId" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "paymentMethod" VARCHAR(30),
    "bankAccountId" INTEGER,
    "receiptUrl" VARCHAR(500),
    "note" VARCHAR(500),
    "createdByUserId" INTEGER,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" INTEGER,
    "reverseReason" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commercial_SellerWalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_SellerWallet_userId_key" ON "Commercial_SellerWallet"("userId");

-- CreateIndex
CREATE INDEX "Commercial_SellerWallet_companyId_idx" ON "Commercial_SellerWallet"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Commercial_SellerWalletEntry_financialRecordId_key" ON "Commercial_SellerWalletEntry"("financialRecordId");

-- CreateIndex
CREATE INDEX "Commercial_SellerWalletEntry_companyId_sellerId_type_status_idx" ON "Commercial_SellerWalletEntry"("companyId", "sellerId", "type", "status");

-- CreateIndex
CREATE INDEX "Commercial_SellerWalletEntry_walletId_occurredAt_idx" ON "Commercial_SellerWalletEntry"("walletId", "occurredAt");

-- CreateIndex
CREATE INDEX "Commercial_SellerWalletEntry_contractId_idx" ON "Commercial_SellerWalletEntry"("contractId");

-- AddForeignKey
ALTER TABLE "Commercial_SellerWalletEntry" ADD CONSTRAINT "Commercial_SellerWalletEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Commercial_SellerWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------- dados
-- 1. Carteira para quem já é vendedor ou já tem comissão registrada.
INSERT INTO "Commercial_SellerWallet" ("companyId", "userId")
SELECT u."companyId", u."id" FROM "User" u
WHERE u."isSeller" = true OR EXISTS (SELECT 1 FROM "SplitTransaction" st WHERE st."sellerId" = u."id")
ON CONFLICT ("userId") DO NOTHING;

-- 2. Cada comissão antiga (SplitTransaction) vira um lançamento na carteira. A situação sai
--    da conta a receber: paga → liberada; cancelada ou inativa → cancelada; o resto → prevista.
INSERT INTO "Commercial_SellerWalletEntry"
  ("companyId", "walletId", "sellerId", "type", "origin", "status", "amount", "baseValue", "rate", "description",
   "financialRecordId", "couponId", "classId", "subscriptionId", "occurredAt", "releasedAt")
SELECT st."companyId", w."id", st."sellerId", 'comissao', 'treinamento',
  CASE WHEN fr."inactiveAt" IS NOT NULL OR fr."status" IN ('cancelled', 'declined', 'chargeback') THEN 'cancelada'
       WHEN fr."status" = 'received' THEN 'liberada' ELSE 'prevista' END,
  st."splitValue", st."originalValue", st."splitPercentage",
  LEFT(COALESCE(NULLIF(st."splitDescription", ''), 'Comissão de cupom'), 255),
  st."financialRecordId", fr."couponId", sub."classId", fr."subscriptionId", st."createdAt",
  CASE WHEN fr."status" = 'received' AND fr."inactiveAt" IS NULL THEN COALESCE(fr."paidAt", st."createdAt") END
FROM "SplitTransaction" st
JOIN "Commercial_SellerWallet" w ON w."userId" = st."sellerId"
JOIN "FinancialRecords" fr ON fr."id" = st."financialRecordId"
LEFT JOIN "CourseClassSubscription" sub ON sub."id" = fr."subscriptionId"
ON CONFLICT ("financialRecordId") DO NOTHING;

-- 3. Comissão que o Asaas já repassou sozinho (tinha carteira de destino e o cliente pagou)
--    entra como paga, para a carteira não nascer devendo o que o vendedor já recebeu.
INSERT INTO "Commercial_SellerWalletEntry"
  ("companyId", "walletId", "sellerId", "type", "origin", "status", "amount", "description", "occurredAt", "paymentMethod", "note")
SELECT st."companyId", w."id", st."sellerId", 'pagamento', 'manual', 'efetivado', -st."splitValue",
  'Repasse automático do Asaas (histórico)', COALESCE(fr."paidAt", st."createdAt"), 'asaas',
  'Lançado na migração: comissão repassada pelo Asaas antes da carteira existir.'
FROM "SplitTransaction" st
JOIN "Commercial_SellerWallet" w ON w."userId" = st."sellerId"
JOIN "FinancialRecords" fr ON fr."id" = st."financialRecordId"
WHERE st."toWalletId" IS NOT NULL AND fr."status" = 'received' AND fr."inactiveAt" IS NULL;

-- 4. Os dados da subconta do Asaas guardados no usuário (incluíam chave de API) deixam de existir.
--    As subcontas continuam no Asaas; só não são mais usadas pelo sistema.
UPDATE "User" SET "sellerConfig" = NULL WHERE "sellerConfig" IS NOT NULL;
