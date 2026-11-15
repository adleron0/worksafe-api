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
}

/** O que a ferramenta sensível mostra no cartão de confirmação. */
export interface PreparedAction {
  summary: string;
  details?: { label: string; value: string }[];
  /** O que será executado no clique (já validado). */
  payload: Record<string, unknown>;
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
