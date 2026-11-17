-- Extrato lido pelo assistente (PDF) ou enviado por ele: fica em rascunho até a pessoa revisar e lançar.
CREATE TABLE "Financial_StatementDraft" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "bankAccountId" INTEGER NOT NULL,
    "source" VARCHAR(10) NOT NULL DEFAULT 'pdf',
    "status" VARCHAR(20) NOT NULL DEFAULT 'rascunho',
    "fileName" VARCHAR(200),
    "periodFrom" VARCHAR(10) NOT NULL,
    "periodTo" VARCHAR(10) NOT NULL,
    "openingBalance" DECIMAL(18,2) NOT NULL,
    "closingBalance" DECIMAL(18,2) NOT NULL,
    "difference" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL,
    "applyResult" JSONB,
    "botId" INTEGER,
    "createdByUserId" INTEGER,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Financial_StatementDraft_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Financial_StatementDraft_companyId_status_idx" ON "Financial_StatementDraft"("companyId", "status");
CREATE INDEX "Financial_StatementDraft_bankAccountId_idx" ON "Financial_StatementDraft"("bankAccountId");
ALTER TABLE "Financial_StatementDraft" ADD CONSTRAINT "Financial_StatementDraft_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "Financial_BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Permissão: pedir aos bots para ler e lançar extratos (só no perfil super por enquanto)
INSERT INTO "Permission" ("name", "description", "group")
SELECT 'importar_extrato_bots', 'Pedir aos bots para ler extratos (PDF) e lançar no financeiro', 'bots'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "name" = 'importar_extrato_bots');
INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", perm."id" FROM "Profile" p, "Permission" perm
WHERE p."name" = 'super' AND perm."name" = 'importar_extrato_bots'
AND NOT EXISTS (SELECT 1 FROM "ProfilePermission" pp WHERE pp."profileId" = p."id" AND pp."permissionId" = perm."id");

-- Otávio (financeiro): ferramentas de extrato e o roteiro de organização, nos bots que já existem
UPDATE "Ai_Bot"
SET "tools" = "tools" || '["fin_situacao_inicial", "fin_ler_extrato", "fin_ver_rascunho_extrato", "fin_sugerir_classificacao_extrato", "fin_lancar_extrato"]'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'financeiro' AND NOT ("tools" @> '["fin_ler_extrato"]'::jsonb);

UPDATE "Ai_Bot"
SET "instructions" = "instructions" || $roteiro$

ORGANIZAR O FINANCEIRO A PARTIR DOS EXTRATOS
Quando a pessoa quiser organizar o financeiro (ou o financeiro estiver vazio), chame fin_situacao_inicial e siga a "etapa" que ela devolve, uma de cada vez, retomando de onde parou:
1. cadastrar_contas: pergunte quais contas a empresa tem (banco, agência, conta; e se há caixa físico) e cadastre cada uma com fin_salvar_conta_bancaria.
2. definir_saldo_inicial: para cada conta, pergunte "a partir de qual mês vamos controlar?" e o saldo no último dia do mês anterior (está no extrato). Grave saldoInicial e dataSaldoInicial = último dia do mês anterior.
3. pedir_extratos: peça o extrato do primeiro mês de cada conta, de preferência em OFX (importa direto na tela Conciliação); se não houver, em PDF anexado aqui na conversa. Um mês por vez.
4. Ao receber um PDF de extrato: leia TODAS as linhas de movimento (ignore linhas de "saldo do dia"), saída negativa e entrada positiva, e chame fin_ler_extrato com o saldo anterior e o saldo final do período. Se a soma não conferir, releia e mande de novo com substituiRascunhoId; não siga com diferença.
5. Com a soma conferindo: consulte fin_plano_de_contas e fin_cadastros, sugira para cada linha sem par a conta do plano (e fornecedor/cliente quando claro) com fin_sugerir_classificacao_extrato. Tarifas bancárias vão na conta de despesas financeiras/bancárias do plano; transferência entre contas da própria empresa é "transferir"; rendimento vai em outras receitas. Na dúvida, deixe sem categoria e pergunte depois em lote.
6. Mostre um resumo curto (entradas, saídas, quantas linhas novas, quantas baixas, dúvidas) e prepare fin_lancar_extrato. A pessoa confirma no cartão ou revisa linha a linha pelo link da Conciliação.
7. Depois de lançar, compare o saldo do sistema com o saldo final do extrato e peça o mês seguinte.
8. categorizar: liste o que ficou sem categoria em blocos e sugira a categoria de cada um.
Nunca lance extrato cuja soma não confere e nunca invente linha que não está no documento.$roteiro$,
    "shortcuts" = '[{"label":"Organizar o financeiro","prompt":"Quero organizar o financeiro da empresa a partir dos extratos. Por onde começamos?"}]'::jsonb || COALESCE("shortcuts", '[]'::jsonb),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'financeiro' AND "instructions" NOT LIKE '%ORGANIZAR O FINANCEIRO A PARTIR DOS EXTRATOS%';
