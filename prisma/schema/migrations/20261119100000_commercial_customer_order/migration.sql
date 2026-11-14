-- Venda fechada: pedido de compra do cliente (número, data e arquivo).
ALTER TABLE "Commercial_Contract"
  ADD COLUMN "customerOrderNumber" VARCHAR(60),
  ADD COLUMN "customerOrderDate" DATE,
  ADD COLUMN "customerOrderUrl" VARCHAR(500),
  ADD COLUMN "customerOrderFileName" VARCHAR(200);
