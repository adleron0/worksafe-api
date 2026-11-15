-- Bots de IA e MCP: configuração dos bots, conversas, execuções, auditoria,
-- ações pendentes, relatórios agendados, gasto mensal e OAuth do MCP.

-- CreateTable
CREATE TABLE "Ai_Bot" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "icon" VARCHAR(40) NOT NULL DEFAULT 'bot',
    "instructions" TEXT NOT NULL,
    "tools" JSONB NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "fallbackProvider" VARCHAR(20),
    "fallbackModel" VARCHAR(80),
    "permissionKey" VARCHAR(80) NOT NULL,
    "shortcuts" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Ai_Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ai_BotVersion" (
    "id" SERIAL NOT NULL,
    "botId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "instructions" TEXT NOT NULL,
    "tools" JSONB NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ai_BotVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ai_Conversation" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "botId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" VARCHAR(160) NOT NULL DEFAULT 'Nova conversa',
    "origin" VARCHAR(20) NOT NULL DEFAULT 'bots',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Ai_Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ai_Message" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "runId" INTEGER,
    "role" VARCHAR(12) NOT NULL,
    "content" JSONB NOT NULL,
    "provider" VARCHAR(20),
    "model" VARCHAR(80),
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ai_Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ai_Run" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'running',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "error" VARCHAR(1000),
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Ai_Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ai_ToolCall" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "origin" VARCHAR(12) NOT NULL,
    "botId" INTEGER,
    "runId" INTEGER,
    "mcpTokenId" INTEGER,
    "tool" VARCHAR(80) NOT NULL,
    "input" JSONB NOT NULL,
    "outputSummary" VARCHAR(1000),
    "status" VARCHAR(12) NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ai_ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ai_PendingAction" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "toolCallId" INTEGER NOT NULL,
    "conversationId" INTEGER,
    "tool" VARCHAR(80) NOT NULL,
    "payload" JSONB NOT NULL,
    "summary" VARCHAR(1000) NOT NULL,
    "details" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "result" JSONB,
    "error" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ai_PendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ai_Schedule" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "report" VARCHAR(40),
    "botId" INTEGER,
    "prompt" TEXT,
    "frequency" VARCHAR(10) NOT NULL,
    "time" VARCHAR(5) NOT NULL DEFAULT '07:00',
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "channels" JSONB NOT NULL,
    "recipients" JSONB NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveAt" TIMESTAMP(3),

    CONSTRAINT "Ai_Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ai_Report" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "scheduleId" INTEGER,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "deliveries" JSONB NOT NULL DEFAULT '[]',
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ai_Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ai_Usage" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ai_Usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mcp_Client" (
    "id" SERIAL NOT NULL,
    "clientId" VARCHAR(80) NOT NULL,
    "clientSecretHash" VARCHAR(128),
    "name" VARCHAR(200),
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mcp_Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mcp_AuthRequest" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "clientId" VARCHAR(80) NOT NULL,
    "redirectUri" VARCHAR(1000) NOT NULL,
    "codeChallenge" VARCHAR(200) NOT NULL,
    "state" VARCHAR(500),
    "scopes" JSONB,
    "resource" VARCHAR(500),
    "userId" INTEGER,
    "companyId" INTEGER,
    "codeHash" VARCHAR(128),
    "approvedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mcp_AuthRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mcp_Token" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "clientId" VARCHAR(80) NOT NULL,
    "clientName" VARCHAR(200),
    "accessTokenHash" VARCHAR(128) NOT NULL,
    "refreshTokenHash" VARCHAR(128),
    "scopes" JSONB,
    "accessExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mcp_Token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ai_Bot_companyId_key_key" ON "Ai_Bot"("companyId", "key");

-- CreateIndex
CREATE INDEX "Ai_BotVersion_botId_version_idx" ON "Ai_BotVersion"("botId", "version");

-- CreateIndex
CREATE INDEX "Ai_Conversation_companyId_userId_botId_idx" ON "Ai_Conversation"("companyId", "userId", "botId");

-- CreateIndex
CREATE INDEX "Ai_Message_conversationId_id_idx" ON "Ai_Message"("conversationId", "id");

-- CreateIndex
CREATE INDEX "Ai_Run_conversationId_id_idx" ON "Ai_Run"("conversationId", "id");

-- CreateIndex
CREATE INDEX "Ai_Run_status_idx" ON "Ai_Run"("status");

-- CreateIndex
CREATE INDEX "Ai_ToolCall_companyId_createdAt_idx" ON "Ai_ToolCall"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Ai_ToolCall_companyId_userId_createdAt_idx" ON "Ai_ToolCall"("companyId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "Ai_PendingAction_companyId_userId_confirmedAt_idx" ON "Ai_PendingAction"("companyId", "userId", "confirmedAt");

-- CreateIndex
CREATE INDEX "Ai_PendingAction_conversationId_idx" ON "Ai_PendingAction"("conversationId");

-- CreateIndex
CREATE INDEX "Ai_Schedule_active_nextRunAt_idx" ON "Ai_Schedule"("active", "nextRunAt");

-- CreateIndex
CREATE INDEX "Ai_Schedule_companyId_idx" ON "Ai_Schedule"("companyId");

-- CreateIndex
CREATE INDEX "Ai_Report_companyId_createdAt_idx" ON "Ai_Report"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Ai_Usage_companyId_month_provider_model_key" ON "Ai_Usage"("companyId", "month", "provider", "model");

-- CreateIndex
CREATE UNIQUE INDEX "Mcp_Client_clientId_key" ON "Mcp_Client"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Mcp_AuthRequest_key_key" ON "Mcp_AuthRequest"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Mcp_AuthRequest_codeHash_key" ON "Mcp_AuthRequest"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "Mcp_Token_accessTokenHash_key" ON "Mcp_Token"("accessTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Mcp_Token_refreshTokenHash_key" ON "Mcp_Token"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Mcp_Token_companyId_userId_idx" ON "Mcp_Token"("companyId", "userId");

-- AddForeignKey
ALTER TABLE "Ai_BotVersion" ADD CONSTRAINT "Ai_BotVersion_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Ai_Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ai_Conversation" ADD CONSTRAINT "Ai_Conversation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Ai_Bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ai_Message" ADD CONSTRAINT "Ai_Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Ai_Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ai_Run" ADD CONSTRAINT "Ai_Run_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Ai_Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ai_PendingAction" ADD CONSTRAINT "Ai_PendingAction_toolCallId_fkey" FOREIGN KEY ("toolCallId") REFERENCES "Ai_ToolCall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ai_Report" ADD CONSTRAINT "Ai_Report_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Ai_Schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Permissões dos Bots e do MCP. Nascem só no perfil super (decisão do dono):
-- os outros perfis recebem pela tela de Perfis.
INSERT INTO "Permission" ("name", "description", "group") VALUES
  ('usar_bots', 'Entrar na área de Bots e conversar com os bots liberados', 'bots'),
  ('update_bots', 'Configurar os bots: instruções, modelo, ferramentas e relatórios agendados', 'bots'),
  ('view_auditoria_bots', 'Ver o registro de tudo que os bots e o MCP fizeram e o gasto com IA', 'bots'),
  ('usar_mcp', 'Conectar apps de IA (Claude, ChatGPT…) ao sistema pelo MCP', 'bots'),
  ('usar_bot_gestao', 'Conversar com o Bot de Gestão (indicadores e relatórios)', 'bots'),
  ('usar_bot_comercial', 'Conversar com o Bot Comercial (clientes, propostas e acompanhamento)', 'bots'),
  ('usar_bot_operacao', 'Conversar com o Bot de Operação e RH (OS, RDO, escala e documentos)', 'bots'),
  ('usar_bot_treinamentos', 'Conversar com o Bot de Treinamentos (turmas, inscrições e certificados)', 'bots'),
  ('usar_bot_marketing', 'Conversar com o Bot de Marketing (blog e divulgação)', 'bots'),
  ('usar_bot_financeiro', 'Conversar com o Bot Financeiro (contas a receber e a pagar)', 'bots')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "ProfilePermission" ("profileId", "permissionId")
SELECT p."id", pm."id"
FROM "Profile" p
JOIN "Permission" pm ON pm."group" = 'bots'
WHERE p."name" = 'super' AND p."inactiveAt" IS NULL
ON CONFLICT ("profileId", "permissionId") DO NOTHING;
