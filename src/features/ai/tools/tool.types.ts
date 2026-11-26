import type { JsonSchema } from '../providers/provider.types';
import type { ToolDeps } from './tool.deps';

/**
 * Nível de risco de uma ferramenta:
 * - read: só consulta;
 * - draft: cria ou altera algo que ainda não saiu para fora (nasce como rascunho);
 * - sensitive: sai para fora, mexe em dinheiro ou publica. Nunca executa direto:
 *   vira uma ação pendente que só o clique da pessoa confirma.
 */
export type ToolRisk = 'read' | 'draft' | 'sensitive';

export type ToolOrigin = 'bots' | 'mcp' | 'schedule';

export interface ToolContext {
  userId: number;
  companyId: number;
  permissions: string[];
  origin: ToolOrigin;
  botId?: number | null;
  runId?: number | null;
  conversationId?: number | null;
  mcpTokenId?: number | null;
  /** Execução feita a pedido de outro bot (pedir_ao_colega): não pode pedir a um terceiro. */
  delegated?: boolean;
  /** Resposta automática do Direct: o bot só pode responder a esta conversa (id do cliente). */
  instagramConversation?: string;
  /** Atendimento das Conversas (triagem/atende): o bot só fala nesta conversa (Chat_Conversation.id). */
  chatConversation?: number;
}

/** O que a ferramenta sensível mostra no cartão de confirmação. */
export interface PreparedAction {
  summary: string;
  details?: { label: string; value: string }[];
  /** O que será executado no clique (já validado). */
  payload: Record<string, unknown>;
  /**
   * Só para ferramentas com autoMode: a empresa configurou esta ação no modo
   * automático, então o catálogo executa na hora (sem cartão), com o mesmo
   * payload e o mesmo execute do clique. Decidido a cada chamada pelo prepare.
   */
  auto?: boolean;
}

export interface ActionResult {
  message: string;
  link?: string | null;
  data?: unknown;
}

export interface ToolDefinition {
  name: string;
  /** Rótulo do passo na tela: "Consultando propostas". */
  title: string;
  /** Para o modelo: quando usar, o que devolve, o que não faz. */
  description: string;
  inputSchema: JsonSchema;
  /** A pessoa precisa de TODAS estas permissões. */
  permissions: string[];
  /** E, se houver, de PELO MENOS UMA destas. */
  anyPermissions?: string[];
  risk: ToolRisk;
  /**
   * sensitive que a empresa pode configurar para sair direto (modo automático
   * do Instagram): o prepare devolve auto=true quando for o caso.
   */
  autoMode?: boolean;
  /** Rótulo do passo conforme a entrada ("Perguntando ao Otávio"); sem ele, vale o title. */
  label?: (input: Record<string, any>) => string;
  /** Só na área de Bots e nos agendamentos: não aparece para apps de IA pelo MCP. */
  botsOnly?: boolean;
  /** read e draft: executa e devolve o resultado (JSON). */
  run?: (ctx: ToolContext, input: Record<string, any>, deps: ToolDeps) => Promise<unknown>;
  /** sensitive: valida e descreve, sem efeito nenhum. */
  prepare?: (ctx: ToolContext, input: Record<string, any>, deps: ToolDeps) => Promise<PreparedAction>;
  /** sensitive: executa depois do clique, com as permissões atuais da pessoa. */
  execute?: (ctx: ToolContext, payload: Record<string, any>, deps: ToolDeps) => Promise<ActionResult>;
}

/**
 * Recusa de regra de negócio: volta para o modelo como resultado (com o
 * motivo), para ele corrigir ou perguntar à pessoa. Não é erro do sistema.
 */
export class ToolRefusal extends Error {}
