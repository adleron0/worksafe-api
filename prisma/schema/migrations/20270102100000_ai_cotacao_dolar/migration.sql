-- Cotação do dólar (R$) informada na tela; vazia usa a PTAX do Banco Central do dia.
ALTER TABLE "Ai_Settings" ADD COLUMN "usdBrlRate" DECIMAL(8,4);
