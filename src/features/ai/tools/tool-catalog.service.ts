import { ForbiddenException, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import type { ChatToolDef } from '../providers/provider.types';
import { READ_TOOLS } from './read.tools';
import { ToolDeps } from './tool.deps';
import { ActionResult, ToolContext, ToolDefinition, ToolRefusal } from './tool.types';
import { WRITE_TOOLS } from './write.tools';
import { IMAGE_TOOLS } from './image.tools';
import { INSTAGRAM_TOOLS } from './instagram.tools';
import { FINANCE_TOOLS } from './finance.tools';
import { SCHEDULE_TOOLS } from './schedule.tools';
import { STATEMENT_TOOLS } from './statement.tools';
import { TEAM_TOOLS } from './team.tools';
import { MEMORY_TOOLS } from './memory.tools';
import { RDO_TOOLS } from './rdo.tools';
import { TRAINING_TOOLS } from './training.tools';

/** Resultado de uma chamada, como volta para o modelo. */
export interface ToolOutcome {
  status: 'ok' | 'refused' | 'denied' | 'error' | 'pending';
  /** O que vai para o modelo (JSON em texto, já resumido). */
  content: string;
  isError: boolean;
  /** Para a tela: ação pendente criada. */
  pendingActionId?: number;
  toolCallId: number;
}

const MAX_RESULT_CHARS = 14000;
const PENDING_MINUTES = 30;

/** Campos que nunca vão para o modelo, em qualquer ferramenta. */
const SENSITIVE_KEYS = /^(cpf|rg|password|senha|sellerConfig|bankAccount|token|apiKey|pix(Number)?|cnh)$/i;

function mask(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => mask(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[key] = SENSITIVE_KEYS.test(key) ? '***' : mask(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function compact(value: unknown): string {
  const json = JSON.stringify(mask(value));
  if (json.length <= MAX_RESULT_CHARS) return json;
  return `${json.slice(0, MAX_RESULT_CHARS)}… [resultado cortado: peça um filtro mais específico]`;
}

/**
 * Catálogo único de ferramentas: serve à área de Bots e ao MCP. Aqui ficam as
 * três garantias que valem para qualquer cliente: permissão da pessoa,
 * auditoria de toda chamada e ação sensível só com confirmação.
 */
@Injectable()
export class ToolCatalogService {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly prisma: PrismaService, private readonly deps: ToolDeps) {
    for (const tool of [...READ_TOOLS, ...WRITE_TOOLS, ...IMAGE_TOOLS, ...INSTAGRAM_TOOLS, ...FINANCE_TOOLS, ...STATEMENT_TOOLS, ...SCHEDULE_TOOLS, ...RDO_TOOLS, ...TRAINING_TOOLS, ...TEAM_TOOLS, ...MEMORY_TOOLS]) this.tools.set(tool.name, tool);
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  allowed(tool: ToolDefinition, permissions: string[]): boolean {
    return tool.permissions.every((permission) => permissions.includes(permission))
      && (!tool.anyPermissions?.length || tool.anyPermissions.some((permission) => permissions.includes(permission)));
  }

  /** As ferramentas que a pessoa pode usar, dentro de uma lista (a do bot). O modelo nem vê as outras. */
  visible(names: string[] | null, permissions: string[]): ToolDefinition[] {
    // sem lista = MCP: as ferramentas só da área de Bots ficam de fora
    const list = names ? names.map((name) => this.tools.get(name)).filter((tool): tool is ToolDefinition => !!tool) : this.all().filter((tool) => !tool.botsOnly);
    return list.filter((tool) => this.allowed(tool, permissions));
  }

  definitions(tools: ToolDefinition[]): ChatToolDef[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.risk === 'sensitive' ? `${tool.description} [Ação com confirmação: a ferramenta só prepara; a pessoa confirma no cartão.]` : tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /** Executa uma chamada do modelo, com auditoria. Nunca lança: o erro volta como resultado. */
  async call(ctx: ToolContext, name: string, input: Record<string, unknown>, allowedNames: string[] | null): Promise<ToolOutcome> {
    const started = Date.now();
    const tool = this.tools.get(name);
    const safeInput = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
    const audit = async (status: ToolOutcome['status'], summary: string) =>
      this.prisma.ai_ToolCall.create({
        data: {
          companyId: ctx.companyId, userId: ctx.userId, origin: ctx.origin, botId: ctx.botId ?? null, runId: ctx.runId ?? null, mcpTokenId: ctx.mcpTokenId ?? null,
          tool: name.slice(0, 80), input: mask(safeInput) as Prisma.InputJsonValue, outputSummary: summary.slice(0, 1000), status, durationMs: Date.now() - started,
        },
      });

    if (!tool || (allowedNames && !allowedNames.includes(name))) {
      const row = await audit('denied', 'Ferramenta fora da lista deste bot');
      return { status: 'denied', content: JSON.stringify({ erro: `A ferramenta "${name}" não existe para este bot.` }), isError: true, toolCallId: row.id };
    }
    if (!this.allowed(tool, ctx.permissions)) {
      const row = await audit('denied', `Sem permissão: ${[...tool.permissions, ...(tool.anyPermissions?.length ? [`uma de ${tool.anyPermissions.join('/')}`] : [])].join(', ')}`);
      return { status: 'denied', content: JSON.stringify({ erro: 'A pessoa não tem permissão para isso. Diga que ela precisa pedir a permissão ao administrador.' }), isError: true, toolCallId: row.id };
    }

    try {
      if (tool.risk === 'sensitive') {
        const prepared = await tool.prepare!(ctx, safeInput, this.deps);
        const row = await audit('pending', prepared.summary);
        const pending = await this.prisma.ai_PendingAction.create({
          data: {
            companyId: ctx.companyId, userId: ctx.userId, toolCallId: row.id, conversationId: ctx.conversationId ?? null, tool: tool.name,
            payload: prepared.payload as Prisma.InputJsonValue, summary: prepared.summary.slice(0, 1000), details: (prepared.details ?? []) as Prisma.InputJsonValue,
            // tarefa agendada roda sem ninguém olhando: a confirmação vale 24 horas
            expiresAt: new Date(Date.now() + (ctx.origin === 'schedule' ? 24 * 60 : PENDING_MINUTES) * 60000),
          },
        });
        return {
          status: 'pending', isError: false, toolCallId: row.id, pendingActionId: pending.id,
          content: JSON.stringify({
            situacao: 'aguardando_confirmacao', acaoPendenteId: pending.id, resumo: prepared.summary,
            instrucao: ctx.origin === 'mcp'
              ? 'Nada foi feito ainda. Diga à pessoa para confirmar em Bots → Ações pendentes, no sistema WorkSafe (vale por 30 minutos).'
              : 'Nada foi feito ainda. A pessoa vê um cartão com Confirmar/Cancelar logo abaixo da sua resposta: diga isso em uma frase e não afirme que a ação foi feita.',
          }),
        };
      }
      const result = await tool.run!(ctx, safeInput, this.deps);
      const content = compact(result);
      const row = await audit('ok', content.slice(0, 300));
      return { status: 'ok', content, isError: false, toolCallId: row.id };
    } catch (error) {
      if (error instanceof ToolRefusal) {
        const row = await audit('refused', error.message);
        return { status: 'refused', content: JSON.stringify({ recusado: error.message }), isError: true, toolCallId: row.id };
      }
      console.error(`[ai] ferramenta ${name} falhou`, error);
      const row = await audit('error', String((error as Error)?.message ?? error));
      return { status: 'error', content: JSON.stringify({ erro: 'Falha interna ao executar. Não tente de novo; avise a pessoa.' }), isError: true, toolCallId: row.id };
    }
  }

  // ---------------------------------------------------------------- ações pendentes

  async pending(ctx: { userId: number; companyId: number }, conversationId?: number) {
    const rows = await this.prisma.ai_PendingAction.findMany({
      where: { companyId: ctx.companyId, userId: ctx.userId, ...(conversationId ? { conversationId } : { confirmedAt: null, cancelledAt: null, expiresAt: { gt: new Date() } }) },
      orderBy: { id: 'desc' }, take: 50,
    });
    return rows.map((row) => this.presentPending(row));
  }

  presentPending(row: { id: number; tool: string; summary: string; details: Prisma.JsonValue; expiresAt: Date; confirmedAt: Date | null; cancelledAt: Date | null; result: Prisma.JsonValue; error: string | null; conversationId: number | null; createdAt: Date }) {
    const now = new Date();
    const status = row.confirmedAt ? (row.error ? 'falhou' : 'confirmada') : row.cancelledAt ? 'cancelada' : row.expiresAt <= now ? 'expirada' : 'pendente';
    return {
      id: row.id, tool: row.tool, title: this.tools.get(row.tool)?.title ?? row.tool, summary: row.summary, details: row.details ?? [], status,
      expiresAt: row.expiresAt, result: row.result ?? null, error: row.error, conversationId: row.conversationId, createdAt: row.createdAt,
    };
  }

  /**
   * O clique da pessoa. Confere dono, validade e a permissão ATUAL (do token
   * de quem clica), executa e registra. O modelo não tem rota para isto.
   */
  async confirm(ctx: { userId: number; companyId: number; permissions: string[] }, id: number): Promise<{ action: ReturnType<ToolCatalogService['presentPending']>; result: ActionResult | null }> {
    const row = await this.prisma.ai_PendingAction.findFirst({ where: { id, companyId: ctx.companyId, userId: ctx.userId } });
    if (!row) throw new NotFoundException('Ação não encontrada');
    if (row.confirmedAt || row.cancelledAt) throw new ConflictException('Esta ação já foi resolvida');
    if (row.expiresAt <= new Date()) throw new ConflictException('A ação expirou: peça de novo ao bot');
    const tool = this.tools.get(row.tool);
    if (!tool?.execute) throw new NotFoundException('Ação desconhecida');
    if (!this.allowed(tool, ctx.permissions)) throw new ForbiddenException('Você não tem mais permissão para esta ação');
    // marca antes de executar: dois cliques não executam duas vezes
    const claimed = await this.prisma.ai_PendingAction.updateMany({ where: { id, confirmedAt: null, cancelledAt: null }, data: { confirmedAt: new Date() } });
    if (!claimed.count) throw new ConflictException('Esta ação já foi resolvida');
    const toolCall = await this.prisma.ai_ToolCall.findUnique({ where: { id: row.toolCallId } });
    const toolCtx: ToolContext = { userId: ctx.userId, companyId: ctx.companyId, permissions: ctx.permissions, origin: (toolCall?.origin as ToolContext['origin']) ?? 'bots', botId: toolCall?.botId, conversationId: row.conversationId };
    const started = Date.now();
    try {
      const result = await tool.execute(toolCtx, row.payload as Record<string, any>, this.deps);
      const updated = await this.prisma.ai_PendingAction.update({ where: { id }, data: { result: mask(result) as Prisma.InputJsonValue } });
      await this.prisma.ai_ToolCall.create({ data: { companyId: ctx.companyId, userId: ctx.userId, origin: toolCtx.origin, botId: toolCall?.botId ?? null, tool: row.tool, input: { confirmacao: id } as Prisma.InputJsonValue, outputSummary: result.message.slice(0, 1000), status: 'ok', durationMs: Date.now() - started } });
      return { action: this.presentPending(updated), result };
    } catch (error) {
      const message = error instanceof ToolRefusal ? error.message : 'Falha ao executar a ação';
      if (!(error instanceof ToolRefusal)) console.error(`[ai] confirmação ${id} falhou`, error);
      const updated = await this.prisma.ai_PendingAction.update({ where: { id }, data: { error: message.slice(0, 1000) } });
      await this.prisma.ai_ToolCall.create({ data: { companyId: ctx.companyId, userId: ctx.userId, origin: toolCtx.origin, botId: toolCall?.botId ?? null, tool: row.tool, input: { confirmacao: id } as Prisma.InputJsonValue, outputSummary: message.slice(0, 1000), status: error instanceof ToolRefusal ? 'refused' : 'error', durationMs: Date.now() - started } });
      return { action: this.presentPending(updated), result: null };
    }
  }

  async cancel(ctx: { userId: number; companyId: number }, id: number) {
    const row = await this.prisma.ai_PendingAction.findFirst({ where: { id, companyId: ctx.companyId, userId: ctx.userId } });
    if (!row) throw new NotFoundException('Ação não encontrada');
    if (row.confirmedAt || row.cancelledAt) throw new ConflictException('Esta ação já foi resolvida');
    return this.presentPending(await this.prisma.ai_PendingAction.update({ where: { id }, data: { cancelledAt: new Date() } }));
  }
}
