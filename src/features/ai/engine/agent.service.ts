import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Ai_Bot, Ai_Message, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrivateStorageService } from 'src/common/storage/private-storage.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { BASE_RULES } from '../bots/bot.defaults';
import { personalityPrompt } from '../bots/personality';
import { BotActor, BotService } from '../bots/bot.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { ChatImage, ChatMessage, ChatResponse, ChatToolResult } from '../providers/provider.types';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { TeamPort, ToolDeps } from '../tools/tool.deps';
import { ToolContext, ToolRefusal } from '../tools/tool.types';
import { TEAM_TOOL_NAMES } from '../tools/team.tools';
import { UsageService } from './usage.service';
import { MemoryService } from '../memory/memory.service';
import { MEMORY_TOOL_NAMES } from '../tools/memory.tools';

export interface RunStep { at: string; kind: 'tool' | 'notice'; label: string; tool?: string; status: 'running' | 'ok' | 'refused' | 'denied' | 'error' | 'pending'; pendingActionId?: number }
export interface Attachment { name: string; mediaType: string; size: number; key: string }
export interface UploadedImage { buffer: Buffer; originalname: string; mimetype: string; size: number }

/** Quantas idas ao modelo numa resposta (cada ida pode chamar várias ferramentas). */
const MAX_TURNS = 12;
/** Teto de segurança de mensagens no contexto (o resumo rolante mantém bem abaixo disso). */
const HISTORY_LIMIT = 40;
/** Resumo rolante: passou disto de mensagens não resumidas, resume as antigas... */
export const SUMMARY_TRIGGER = 30;
/** ...e deixa as últimas tantas inteiras para o modelo. */
export const SUMMARY_KEEP = 20;
const SUMMARY_MAX = 4000;
/** Resultado de ferramenta de turnos antigos entra cortado (o completo só na última pergunta). */
const OLD_TOOL_RESULT_MAX = 1500;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const IMAGE_MAX = 5 * 1024 * 1024;
/** PDF (extrato, nota, boleto): o modelo lê direto. 10 MB cabem no limite de envio inline do Gemini. */
const PDF_TYPE = 'application/pdf';
const PDF_MAX = 10 * 1024 * 1024;

const nowBr = () => new Date(Date.now() - 3 * 3600 * 1000);

export const botsEnabled = () => process.env.AI_BOTS_ENABLED !== 'false';

/**
 * O motor: recebe a mensagem, chama o modelo com as ferramentas do bot
 * (filtradas pelas permissões da pessoa), executa as chamadas e repete até a
 * resposta final. Roda fora da requisição; a tela acompanha pelos passos
 * gravados em Ai_Run.
 */
/** Idas ao modelo do colega num pedido (ele só consulta). */
const COLLEAGUE_TURNS = 6;

@Injectable()
export class AgentService implements TeamPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: BotService,
    private readonly catalog: ToolCatalogService,
    private readonly providers: ProviderRegistry,
    private readonly usage: UsageService,
    private readonly storage: PrivateStorageService,
    private readonly memory: MemoryService,
    deps: ToolDeps,
  ) {
    deps.team = this;
  }

  // ---------------------------------------------------------------- equipe

  /**
   * A equipe de bots como funcionários: quem está trabalhando agora (na
   * empresa toda), quem espera a sua confirmação, o que fez hoje e o que você
   * conversou por último. A atividade recente mostra só o que é seu, salvo
   * para quem pode ver a auditoria.
   */
  async team(actor: BotActor) {
    const bots = await this.bots.listFor(actor);
    const ids = bots.map((bot) => bot.id);
    const dayStart = new Date(`${nowBr().toISOString().slice(0, 10)}T03:00:00.000Z`);
    const seesAll = this.seesAllRequests(actor);
    const admin = actor.permissions.includes('update_bots');
    const scope = seesAll ? {} : { userId: actor.userId };
    const schedules = await this.prisma.ai_Schedule.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, active: true, kind: 'ai', botId: { in: ids }, ...(admin ? {} : { ownerUserId: actor.userId }) },
      orderBy: { nextRunAt: 'asc' }, select: { id: true, botId: true, name: true, nextRunAt: true, frequency: true, eventType: true },
    });
    const [running, mineRunning, pending, todayRuns, todayCalls, lastCalls, lastMine, activity, users] = await Promise.all([
      this.prisma.ai_Run.findMany({ where: { status: 'running', conversation: { companyId: actor.companyId, botId: { in: ids } } }, select: { userId: true, conversation: { select: { botId: true } } } }),
      this.prisma.ai_Run.findMany({ where: { status: 'running', userId: actor.userId, conversation: { companyId: actor.companyId, botId: { in: ids } } }, select: { conversation: { select: { id: true, botId: true, title: true } } } }),
      this.prisma.ai_PendingAction.findMany({ where: { companyId: actor.companyId, userId: actor.userId, confirmedAt: null, cancelledAt: null, expiresAt: { gt: new Date() } }, select: { toolCall: { select: { botId: true } } } }),
      this.prisma.ai_Run.findMany({ where: { ...scope, startedAt: { gte: dayStart }, conversation: { companyId: actor.companyId, botId: { in: ids } } }, select: { conversation: { select: { botId: true } } } }),
      this.prisma.ai_ToolCall.groupBy({ by: ['botId'], where: { ...scope, companyId: actor.companyId, botId: { in: ids }, createdAt: { gte: dayStart }, status: { in: ['ok', 'pending'] } }, _count: { _all: true } }),
      this.prisma.ai_ToolCall.groupBy({ by: ['botId'], where: { ...scope, companyId: actor.companyId, botId: { in: ids } }, _max: { createdAt: true } }),
      this.prisma.ai_Conversation.findMany({ where: { companyId: actor.companyId, userId: actor.userId, botId: { in: ids }, archivedAt: null, origin: 'bots' }, orderBy: { lastMessageAt: 'desc' }, take: 50, select: { id: true, botId: true, title: true, lastMessageAt: true } }),
      this.prisma.ai_ToolCall.findMany({ where: { companyId: actor.companyId, botId: { in: ids }, ...(seesAll ? {} : { userId: actor.userId }) }, orderBy: { id: 'desc' }, take: 20, select: { id: true, botId: true, userId: true, tool: true, status: true, createdAt: true, origin: true } }),
      seesAll ? this.prisma.user.findMany({ where: { companyId: actor.companyId }, select: { id: true, name: true } }) : Promise.resolve([] as { id: number; name: string }[]),
    ]);
    const count = <T,>(rows: T[], pick: (row: T) => number | null | undefined) => rows.reduce((map, row) => map.set(pick(row) ?? 0, (map.get(pick(row) ?? 0) ?? 0) + 1), new Map<number, number>());
    const runningBy = count(running, (row) => row.conversation.botId);
    const pendingBy = count(pending, (row) => row.toolCall.botId);
    const runsBy = count(todayRuns, (row) => row.conversation.botId);
    const callsBy = new Map(todayCalls.map((row) => [row.botId ?? 0, row._count._all]));
    const lastConversations = await this.prisma.ai_Conversation.groupBy({ by: ['botId'], where: { ...scope, companyId: actor.companyId, botId: { in: ids } }, _max: { lastMessageAt: true } });
    const lastBy = new Map<number, Date | null>(lastCalls.map((row) => [row.botId ?? 0, row._max.createdAt]));
    for (const row of lastConversations) {
      const current = lastBy.get(row.botId);
      if (row._max.lastMessageAt && (!current || row._max.lastMessageAt > current)) lastBy.set(row.botId, row._max.lastMessageAt);
    }
    const userName = new Map(users.map((user) => [user.id, user.name]));
    const botName = new Map(bots.map((bot) => [bot.id, bot]));
    return {
      members: bots.map((bot) => {
        const mine = mineRunning.find((row) => row.conversation.botId === bot.id)?.conversation;
        const people = new Set(running.filter((row) => row.conversation.botId === bot.id).map((row) => row.userId)).size;
        const status = !bot.providerReady ? 'sem_chave' : (runningBy.get(bot.id) ?? 0) > 0 ? 'trabalhando' : (pendingBy.get(bot.id) ?? 0) > 0 ? 'aguardando' : 'disponivel';
        const recent = lastMine.find((row) => row.botId === bot.id);
        return {
          ...bot, status,
          working: { people, mine: mine ? { conversationId: mine.id, title: mine.title } : null },
          pendingForMe: pendingBy.get(bot.id) ?? 0,
          today: { conversations: runsBy.get(bot.id) ?? 0, actions: callsBy.get(bot.id) ?? 0 },
          lastActivityAt: lastBy.get(bot.id) ?? null,
          lastConversation: recent ? { id: recent.id, title: recent.title, at: recent.lastMessageAt } : null,
          agenda: (() => {
            const mine = schedules.filter((row) => row.botId === bot.id);
            const timed = mine.filter((row) => row.frequency !== 'event' && row.nextRunAt);
            return {
              count: mine.length,
              watching: mine.filter((row) => row.frequency === 'event').length,
              next: timed[0] ? { id: timed[0].id, name: timed[0].name, at: timed[0].nextRunAt } : null,
            };
          })(),
        };
      }),
      seesAll,
      activity: activity.map((row) => ({
        id: row.id, botId: row.botId, persona: botName.get(row.botId ?? 0)?.persona ?? null, avatar: botName.get(row.botId ?? 0)?.avatar ?? null,
        title: this.catalog.get(row.tool)?.title ?? row.tool, status: row.status, at: row.createdAt, origin: row.origin,
        user: seesAll ? userName.get(row.userId) ?? null : null,
      })),
    };
  }

  /** Quem vê os pedidos de todo mundo aos bots (com o nome de quem pediu). */
  private seesAllRequests(actor: BotActor) {
    return actor.permissions.includes('view_pedidos_bots') || actor.permissions.includes('view_auditoria_bots');
  }

  /**
   * Pedidos (cada mensagem que pôs o bot para trabalhar) e tarefas (ferramentas que
   * deram certo ou esperam confirmação) de um bot no período. Sem permissão de ver
   * tudo, só os da própria pessoa.
   */
  async botActivity(actor: BotActor, botId: number, days: number) {
    const bot = await this.bots.usable(actor, botId);
    const span = Math.min(30, Math.max(1, Math.floor(days) || 1));
    const today = nowBr().toISOString().slice(0, 10);
    const since = new Date(new Date(`${today}T03:00:00.000Z`).getTime() - (span - 1) * 86400000);
    const seesAll = this.seesAllRequests(actor);
    const scope = seesAll ? {} : { userId: actor.userId };
    const [runs, calls] = await Promise.all([
      this.prisma.ai_Run.findMany({
        where: { ...scope, startedAt: { gte: since }, conversation: { companyId: actor.companyId, botId } }, orderBy: { id: 'desc' }, take: 200,
        select: { id: true, userId: true, status: true, startedAt: true, endedAt: true, error: true, steps: true, conversation: { select: { id: true, title: true, origin: true, userId: true } } },
      }),
      this.prisma.ai_ToolCall.findMany({
        where: { ...scope, companyId: actor.companyId, botId, createdAt: { gte: since }, status: { in: ['ok', 'pending'] } }, orderBy: { id: 'desc' }, take: 300,
        select: { id: true, userId: true, tool: true, status: true, origin: true, outputSummary: true, createdAt: true, runId: true },
      }),
    ]);
    const messages = await this.prisma.ai_Message.findMany({ where: { runId: { in: runs.map((run) => run.id) }, role: 'user' }, select: { runId: true, content: true } });
    const askOf = new Map(messages.map((message) => [message.runId, String((message.content as { text?: string })?.text ?? '')]));
    const userIds = [...new Set([...runs.map((run) => run.userId), ...calls.map((call) => call.userId)])];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds }, companyId: actor.companyId }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((user) => [user.id, user.name]));
    const who = (userId: number) => ({ mine: userId === actor.userId, user: userId === actor.userId ? 'Você' : nameOf.get(userId) ?? 'Alguém' });
    const runConversation = new Map(runs.map((run) => [run.id, run.conversation]));
    // a conversa só abre para o dono (a tela de conversas é pessoal)
    const link = (conversation?: { id: number; userId: number; origin: string }) => (conversation && conversation.userId === actor.userId && conversation.origin === 'bots' ? conversation.id : null);
    return {
      bot: { id: bot.id, persona: (bot as { persona?: string | null }).persona ?? bot.name },
      days: span, seesAll,
      requests: runs.map((run) => ({
        id: run.id, at: run.startedAt, endedAt: run.endedAt, status: run.status, ...who(run.userId),
        origin: run.conversation.origin, title: run.conversation.title,
        ask: (askOf.get(run.id) ?? '').replace(/^\[aviso do sistema\]\s*/, '').slice(0, 400),
        tools: Array.isArray(run.steps) ? (run.steps as Array<{ kind?: string }>).filter((step) => step.kind === 'tool').length : 0,
        error: run.status === 'error' ? run.error : null,
        conversationId: link(run.conversation),
      })),
      tasks: calls.map((call) => ({
        id: call.id, at: call.createdAt, status: call.status, origin: call.origin, ...who(call.userId),
        tool: call.tool, title: this.catalog.get(call.tool)?.title ?? call.tool, summary: call.outputSummary,
        conversationId: link(call.runId ? runConversation.get(call.runId) : undefined),
      })),
    };
  }

  // ---------------------------------------------------------------- conversas

  async conversations(actor: BotActor, botId: number) {
    await this.bots.usable(actor, botId);
    const rows = await this.prisma.ai_Conversation.findMany({
      where: { companyId: actor.companyId, userId: actor.userId, botId, archivedAt: null, origin: 'bots' },
      orderBy: { lastMessageAt: 'desc' }, take: 100, select: { id: true, title: true, lastMessageAt: true, createdAt: true },
    });
    return rows;
  }

  async createConversation(actor: BotActor, botId: number) {
    await this.bots.usable(actor, botId);
    return this.prisma.ai_Conversation.create({ data: { companyId: actor.companyId, userId: actor.userId, botId }, select: { id: true, title: true, lastMessageAt: true, createdAt: true } });
  }

  private async own(actor: BotActor, conversationId: number) {
    const row = await this.prisma.ai_Conversation.findFirst({ where: { id: conversationId, companyId: actor.companyId, userId: actor.userId } });
    if (!row) throw new NotFoundException('Conversa não encontrada');
    return row;
  }

  async conversation(actor: BotActor, conversationId: number) {
    const row = await this.own(actor, conversationId);
    const [messages, run, pending] = await Promise.all([
      this.prisma.ai_Message.findMany({ where: { conversationId }, orderBy: { id: 'asc' }, take: 500 }),
      this.prisma.ai_Run.findFirst({ where: { conversationId }, orderBy: { id: 'desc' } }),
      this.catalog.pending(actor, conversationId),
    ]);
    return {
      id: row.id, title: row.title, botId: row.botId, archived: !!row.archivedAt,
      messages: messages.map((message) => this.presentMessage(message)).filter(Boolean),
      run: run ? this.presentRun(run) : null,
      pendingActions: pending,
    };
  }

  async rename(actor: BotActor, conversationId: number, title: unknown) {
    await this.own(actor, conversationId);
    const value = String(title ?? '').trim().slice(0, 160);
    if (!value) throw new BadRequestException('Informe o título');
    return this.prisma.ai_Conversation.update({ where: { id: conversationId }, data: { title: value }, select: { id: true, title: true } });
  }

  async archive(actor: BotActor, conversationId: number) {
    await this.own(actor, conversationId);
    await this.prisma.ai_Conversation.update({ where: { id: conversationId }, data: { archivedAt: new Date() } });
    return { archived: true };
  }

  /** Para a tela: só o que a pessoa lê (texto, passos de ferramenta resumidos, avisos). */
  private presentMessage(message: Ai_Message) {
    const content = (message.content ?? {}) as Record<string, any>;
    if (content.system) return null; // registro interno para o modelo (aviso de ação confirmada)
    if (message.role === 'tool') {
      return { id: message.id, role: 'tool', results: (content.results ?? []).map((result: any) => ({ name: result.name, status: result.status ?? (result.isError ? 'error' : 'ok'), pendingActionId: result.pendingActionId ?? null, handoff: this.handoffOf(result) })), createdAt: message.createdAt };
    }
    return {
      id: message.id, role: message.role, text: content.text ?? '', attachments: (content.attachments ?? []).map((item: Attachment) => ({ name: item.name, mediaType: item.mediaType, size: item.size })),
      toolCalls: (content.toolCalls ?? []).map((call: any) => ({ name: call.name, title: this.catalog.get(call.name)?.title ?? call.name })),
      createdAt: message.createdAt,
    };
  }

  /** Resultado de passar_para_colega: o botão que abre a conversa com o colega. */
  private handoffOf(result: any): { conversationId: number; botId: number; persona: string } | null {
    if (result?.name !== 'passar_para_colega' || (result.status ?? 'ok') !== 'ok') return null;
    try {
      const data = JSON.parse(result.content);
      return data?.conversaId ? { conversationId: Number(data.conversaId), botId: Number(data.botId), persona: String(data.colega ?? '') } : null;
    } catch { return null; }
  }

  private presentRun(run: { id: number; status: string; steps: Prisma.JsonValue; error: string | null; startedAt: Date; endedAt: Date | null; costUsd: Prisma.Decimal }) {
    return { id: run.id, status: run.status, steps: (run.steps as unknown as RunStep[]) ?? [], error: run.error, startedAt: run.startedAt, endedAt: run.endedAt };
  }

  async run(actor: BotActor, runId: number) {
    const run = await this.prisma.ai_Run.findFirst({ where: { id: runId, userId: actor.userId, conversation: { companyId: actor.companyId } } });
    if (!run) throw new NotFoundException('Execução não encontrada');
    return this.presentRun(run);
  }

  async stop(actor: BotActor, runId: number) {
    const run = await this.prisma.ai_Run.findFirst({ where: { id: runId, userId: actor.userId, conversation: { companyId: actor.companyId } } });
    if (!run) throw new NotFoundException('Execução não encontrada');
    if (run.status === 'running') await this.prisma.ai_Run.update({ where: { id: runId }, data: { status: 'stopped', endedAt: new Date() } });
    return { stopped: true };
  }

  // ---------------------------------------------------------------- envio

  async send(actor: BotActor, conversationId: number, rawText: unknown, files: UploadedImage[] = []) {
    if (!botsEnabled()) throw new ServiceUnavailableException('Os bots estão desligados no momento');
    const conversation = await this.own(actor, conversationId);
    if (conversation.archivedAt) throw new ConflictException('Conversa arquivada');
    const bot = await this.bots.usable(actor, conversation.botId);
    const text = String(rawText ?? '').trim().slice(0, 8000);
    if (!text && !files.length) throw new BadRequestException('Escreva a mensagem');
    if (files.length > 3) throw new BadRequestException('Até 3 arquivos por mensagem');
    for (const file of files) {
      if (file.mimetype === PDF_TYPE) {
        if (file.size > PDF_MAX) throw new BadRequestException('PDF maior que 10 MB. Divida o extrato em partes menores (por quinzena, por exemplo)');
        if (!file.buffer.subarray(0, 5).toString('latin1').startsWith('%PDF')) throw new BadRequestException(`"${file.originalname}" não é um PDF válido`);
        continue;
      }
      if (!IMAGE_TYPES.includes(file.mimetype)) throw new BadRequestException('Anexe imagens (PNG, JPG ou WEBP) ou PDF');
      if (file.size > IMAGE_MAX) throw new BadRequestException('Imagem maior que 5 MB');
    }
    const provider = this.providers.get(bot.provider);
    if (files.some((file) => file.mimetype === PDF_TYPE) && provider && !provider.readsPdf) {
      throw new BadRequestException(`${bot.persona ?? bot.name} usa um modelo que não lê PDF. Troque o fornecedor dele para Gemini ou Claude em Configurar bots, ou mande o extrato em OFX`);
    }
    if (!provider?.available()) throw new ServiceUnavailableException(`O bot ${bot.name} usa ${bot.provider}, que ainda não tem chave configurada. Peça ao administrador para configurar.`);
    if (await this.usage.overBudget(actor.companyId)) throw new ForbiddenException('O teto mensal de gasto com IA foi atingido. Peça ao administrador para aumentar o teto.');
    const running = await this.prisma.ai_Run.findFirst({ where: { conversationId, status: 'running' }, select: { id: true } });
    if (running) throw new ConflictException('O bot ainda está respondendo a mensagem anterior');

    const attachments: Attachment[] = [];
    for (const file of files) {
      const key = `ai/${actor.companyId}/${conversationId}/${randomUUID()}`;
      await this.storage.put(key, file.buffer, file.mimetype);
      attachments.push({ name: file.originalname.slice(0, 200), mediaType: file.mimetype, size: file.size, key });
    }
    const run = await this.prisma.ai_Run.create({ data: { conversationId, userId: actor.userId, status: 'running', steps: [] } });
    await this.prisma.ai_Message.create({ data: { conversationId, runId: run.id, role: 'user', content: { text, attachments } as unknown as Prisma.InputJsonValue } });
    const first = (await this.prisma.ai_Message.count({ where: { conversationId, role: 'user' } })) === 1;
    await this.prisma.ai_Conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), ...(first && conversation.title === 'Nova conversa' ? { title: (text || attachments[0]?.name || 'Conversa').replace(/\s+/g, ' ').slice(0, 80) } : {}) },
    });
    // roda fora da requisição; a tela acompanha pelo GET da execução
    void this.loop({ ...actor, origin: 'bots', botId: bot.id, runId: run.id, conversationId }, bot).catch((error) => console.error('[ai] execução falhou', error));
    return { runId: run.id };
  }

  /** Usado pelos testes e pelos relatórios agendados: espera a execução terminar. */
  async sendAndWait(ctx: ToolContext, bot: Ai_Bot, conversationId: number, text: string, options: { maxTurns?: number } = {}): Promise<{ text: string; costUsd: number; runId: number }> {
    const run = await this.prisma.ai_Run.create({ data: { conversationId, userId: ctx.userId, status: 'running', steps: [] } });
    await this.prisma.ai_Message.create({ data: { conversationId, runId: run.id, role: 'user', content: { text } } });
    await this.loop({ ...ctx, runId: run.id, conversationId, botId: bot.id }, bot, options.maxTurns);
    const [last, done] = await Promise.all([
      this.prisma.ai_Message.findFirst({ where: { conversationId, role: 'assistant' }, orderBy: { id: 'desc' } }),
      this.prisma.ai_Run.findUnique({ where: { id: run.id } }),
    ]);
    if (done?.status === 'error') throw new Error(done.error ?? 'Falha na execução');
    return { text: String((last?.content as any)?.text ?? ''), costUsd: Number(done?.costUsd ?? 0), runId: run.id };
  }

  // ---------------------------------------------------------------- o loop

  private async loop(ctx: ToolContext & { runId: number; conversationId: number; botId: number }, bot: Ai_Bot, maxTurns = MAX_TURNS): Promise<void> {
    const steps: RunStep[] = [];
    const saveSteps = () => this.prisma.ai_Run.update({ where: { id: ctx.runId }, data: { steps: steps as unknown as Prisma.InputJsonValue } });
    let cost = 0;
    try {
      const tools = this.catalog.visible((bot.tools as string[]) ?? [], ctx.permissions);
      const allowedNames = tools.map((tool) => tool.name);
      const definitions = this.catalog.definitions(tools);
      const conversation = await this.prisma.ai_Conversation.findUnique({ where: { id: ctx.conversationId }, select: { summary: true, summaryUntilId: true } });
      const system = await this.systemPrompt(ctx, bot, tools.map((tool) => tool.title), allowedNames.some((name) => TEAM_TOOL_NAMES.includes(name)), {
        summary: conversation?.summary ?? null,
        canRemember: allowedNames.some((name) => MEMORY_TOOL_NAMES.includes(name)),
      });
      const history = await this.history(ctx.conversationId, conversation?.summaryUntilId ?? 0);

      for (let turn = 0; turn < maxTurns; turn++) {
        const current = await this.prisma.ai_Run.findUnique({ where: { id: ctx.runId }, select: { status: true } });
        if (current?.status !== 'running') return; // a pessoa parou
        if (turn > 0 && (await this.usage.overBudget(ctx.companyId))) {
          await this.notice(ctx, 'Parei aqui: o teto mensal de gasto com IA foi atingido.');
          break;
        }

        const { response, provider, model } = await this.callModel(bot, { model: bot.model, system, messages: history, tools: definitions });
        const callCost = this.providers.cost(provider, model, response.usage);
        cost += callCost;
        await this.usage.record(ctx.companyId, provider, model, response.usage, callCost);
        const assistant: ChatMessage = { role: 'assistant', text: response.text || undefined, toolCalls: response.toolCalls.length ? response.toolCalls : undefined, raw: response.raw === undefined ? undefined : { provider, model, content: response.raw } };
        history.push(assistant);
        await this.prisma.ai_Message.create({
          data: {
            conversationId: ctx.conversationId, runId: ctx.runId, role: 'assistant', provider, model,
            inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, cachedTokens: response.usage.cachedTokens, costUsd: callCost,
            content: { text: response.text, toolCalls: response.toolCalls, raw: assistant.raw } as unknown as Prisma.InputJsonValue,
          },
        });

        if (!response.toolCalls.length) {
          if (response.stopReason === 'refusal' && !response.text) await this.notice(ctx, 'O modelo se recusou a responder este pedido.');
          if (response.stopReason === 'max_tokens') await this.notice(ctx, 'A resposta ficou longa demais e foi cortada. Peça em partes.');
          break;
        }

        const results: (ChatToolResult & { status: string; pendingActionId?: number })[] = [];
        for (const call of response.toolCalls) {
          const tool = this.catalog.get(call.name);
          const step: RunStep = { at: new Date().toISOString(), kind: 'tool', label: (tool?.label ? tool.label(call.input ?? {}) : tool?.title) ?? call.name, tool: call.name, status: 'running' };
          steps.push(step);
          await saveSteps();
          const outcome = await this.catalog.call(ctx, call.name, call.input, allowedNames);
          step.status = outcome.status;
          if (outcome.pendingActionId) step.pendingActionId = outcome.pendingActionId;
          await saveSteps();
          results.push({ toolCallId: call.id, name: call.name, content: outcome.content, isError: outcome.isError, status: outcome.status, pendingActionId: outcome.pendingActionId });
        }
        history.push({ role: 'tool', results });
        await this.prisma.ai_Message.create({ data: { conversationId: ctx.conversationId, runId: ctx.runId, role: 'tool', content: { results } as unknown as Prisma.InputJsonValue } });
        if (turn === maxTurns - 1) await this.notice(ctx, 'Parei por segurança: foram passos demais nesta resposta. Peça em partes menores.');
      }
      await this.prisma.ai_Run.updateMany({ where: { id: ctx.runId, status: 'running' }, data: { status: 'done', endedAt: new Date(), costUsd: cost, steps: steps as unknown as Prisma.InputJsonValue } });
    } catch (error) {
      console.error('[ai] falha na execução', error);
      const done = steps.filter((step) => step.status === 'ok' || step.status === 'pending').length;
      const message = done
        ? `Fiz os passos acima, mas não consegui escrever a resposta final: ${this.friendly(error).charAt(0).toLowerCase()}${this.friendly(error).slice(1)}`
        : this.friendly(error);
      await this.notice(ctx, message).catch(() => undefined);
      await this.prisma.ai_Run.update({ where: { id: ctx.runId }, data: { status: 'error', error: message.slice(0, 1000), endedAt: new Date(), costUsd: cost, steps: steps as unknown as Prisma.InputJsonValue } });
    } finally {
      await this.prisma.ai_Conversation.update({ where: { id: ctx.conversationId }, data: { lastMessageAt: new Date() } }).catch(() => undefined);
    }
    // depois da resposta (não atrasa a pessoa): resume a conversa se ela cresceu
    await this.summarize(ctx, bot).catch((error) => console.error('[ai] resumo da conversa falhou', error));
  }

  // ---------------------------------------------------------------- resumo rolante

  private summarizing = new Set<number>();

  /**
   * Conversa longa: quando passa de SUMMARY_TRIGGER mensagens não resumidas,
   * resume as antigas (junto com o resumo anterior) e deixa as últimas
   * SUMMARY_KEEP inteiras. Refeito em bloco, não a cada mensagem.
   */
  async summarize(ctx: { companyId: number; conversationId: number }, bot: Ai_Bot): Promise<boolean> {
    if (this.summarizing.has(ctx.conversationId)) return false;
    this.summarizing.add(ctx.conversationId);
    try {
      const conversation = await this.prisma.ai_Conversation.findUnique({ where: { id: ctx.conversationId }, select: { summary: true, summaryUntilId: true } });
      if (!conversation) return false;
      const rows = await this.prisma.ai_Message.findMany({
        where: { conversationId: ctx.conversationId, role: { in: ['user', 'assistant', 'tool'] }, id: { gt: conversation.summaryUntilId ?? 0 } },
        orderBy: { id: 'asc' }, select: { id: true, role: true, content: true },
      });
      if (rows.length <= SUMMARY_TRIGGER) return false;
      // o corte cai numa mensagem da pessoa, para não separar chamada e resultado
      let cut = rows.length - SUMMARY_KEEP;
      while (cut < rows.length && rows[cut].role !== 'user') cut++;
      if (cut >= rows.length) {
        cut = rows.length - SUMMARY_KEEP;
        while (cut > 0 && rows[cut].role !== 'user') cut--;
      }
      if (cut <= 0) return false;
      const transcript = this.transcript(rows.slice(0, cut));
      const prompt = [
        conversation.summary ? `Resumo anterior da conversa:\n${conversation.summary}` : '',
        `Mensagens a incluir no resumo:\n${transcript}`,
      ].filter(Boolean).join('\n\n');
      const { response, provider, model } = await this.callModel(bot, {
        model: bot.model, tools: [],
        system: 'Você resume conversas entre uma pessoa e um assistente interno de uma empresa, para o assistente continuar a conversa sem reler tudo. Escreva em português do Brasil, em tópicos curtos: o que a pessoa pediu, o que foi feito (com números, nomes, datas e códigos que importam), decisões, preferências que ela disse e o que ficou pendente. Junte o resumo anterior com as mensagens novas num resumo só. Não invente nada e não inclua cumprimentos. Máximo de 3000 caracteres.',
        messages: [{ role: 'user', text: prompt }],
      });
      const callCost = this.providers.cost(provider, model, response.usage);
      await this.usage.record(ctx.companyId, provider, model, response.usage, callCost);
      const summary = String(response.text ?? '').trim().slice(0, SUMMARY_MAX);
      if (!summary) return false;
      await this.prisma.ai_Conversation.update({ where: { id: ctx.conversationId }, data: { summary, summaryUntilId: rows[cut - 1].id, summaryAt: new Date() } });
      return true;
    } finally {
      this.summarizing.delete(ctx.conversationId);
    }
  }

  /** As mensagens em texto corrido para o resumo (resultados de ferramenta bem cortados). */
  private transcript(rows: { role: string; content: Prisma.JsonValue }[]): string {
    const lines: string[] = [];
    for (const row of rows) {
      const content = (row.content ?? {}) as Record<string, any>;
      if (row.role === 'user') {
        const names = ((content.attachments ?? []) as Attachment[]).map((item) => item.name);
        lines.push(`Pessoa: ${String(content.text ?? '').slice(0, 2000)}${names.length ? ` [anexos: ${names.join(', ')}]` : ''}`);
      } else if (row.role === 'assistant') {
        const tools = ((content.toolCalls ?? []) as { name: string; input?: unknown }[]).map((call) => `${call.name}(${JSON.stringify(call.input ?? {}).slice(0, 200)})`);
        if (content.text) lines.push(`Assistente: ${String(content.text).slice(0, 2000)}`);
        if (tools.length) lines.push(`Assistente usou: ${tools.join(', ')}`);
      } else {
        for (const result of (content.results ?? []) as { name: string; content?: string; isError?: boolean }[]) {
          lines.push(`Resultado de ${result.name}${result.isError ? ' (erro)' : ''}: ${String(result.content ?? '').slice(0, 400)}`);
        }
      }
    }
    return lines.join('\n').slice(-40000);
  }

  /** Chama o modelo do bot; se ele falhar e houver reserva configurada, tenta a reserva. */
  private async callModel(bot: Ai_Bot, request: { model: string; system: string; messages: ChatMessage[]; tools: ReturnType<ToolCatalogService['definitions']> }): Promise<{ response: ChatResponse; provider: string; model: string }> {
    const primary = this.providers.get(bot.provider);
    try {
      if (!primary?.available()) throw new Error(`Fornecedor ${bot.provider} sem chave`);
      return { response: await this.withRetry(() => primary.chat({ ...request, model: bot.model })), provider: bot.provider, model: bot.model };
    } catch (error) {
      const fallback = bot.fallbackProvider ? this.providers.get(bot.fallbackProvider) : undefined;
      if (!fallback?.available() || !bot.fallbackModel) throw error;
      console.warn(`[ai] ${bot.provider}/${bot.model} falhou; usando a reserva ${bot.fallbackProvider}/${bot.fallbackModel}`, (error as Error)?.message);
      return { response: await fallback.chat({ ...request, model: bot.fallbackModel }), provider: bot.fallbackProvider!, model: bot.fallbackModel };
    }
  }

  /**
   * Limite de uso por minuto (429): espera o tempo que o fornecedor pede (até
   * 30 s) e tenta de novo, no máximo duas vezes. Acima disso, desiste e avisa.
   */
  private async withRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (status !== 429 || attempt >= 2) throw error;
        const text = String((error as Error)?.message ?? '');
        // limite zero (modelo fora do plano) não adianta esperar
        if (/limit: 0\b/.test(text)) throw error;
        // "retryDelay":"42033s" (Gemini) ou retry-after em segundos
        const hint = Number(/"retryDelay"\s*:\s*"(\d+)s"/.exec(text)?.[1] ?? NaN);
        if (Number.isFinite(hint) && hint > 30) throw error;
        const wait = Number.isFinite(hint) ? Math.max(2, hint + 1) : 10 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      }
    }
  }

  private friendly(error: unknown): string {
    const status = (error as { status?: number })?.status;
    const text = String((error as Error)?.message ?? '');
    if (status === 429 && /free_tier/i.test(text) && /limit: 0\b/.test(text)) return 'A chave de IA está no plano gratuito, que não inclui o modelo deste bot. Ative o faturamento da chave no Google AI Studio ou troque o modelo do bot em Configurar bots.';
    if (status === 429 && /free_tier/i.test(text)) return 'A chave de IA está no plano gratuito e passou do limite de uso. Ative o faturamento da chave no Google AI Studio ou tente de novo mais tarde.';
    if (status === 429) return 'O fornecedor de IA está com limite de uso no momento. Tente de novo em alguns minutos.';
    if (status === 401 || status === 403) return 'A chave do fornecedor de IA foi recusada. Avise o administrador.';
    if (status && status >= 500) return 'O fornecedor de IA está fora do ar no momento. Tente de novo em alguns minutos.';
    return 'Não consegui terminar a resposta por uma falha interna. Tente de novo.';
  }

  private async notice(ctx: { conversationId: number; runId: number }, text: string) {
    await this.prisma.ai_Message.create({ data: { conversationId: ctx.conversationId, runId: ctx.runId, role: 'notice', content: { text } } });
  }

  private async systemPrompt(ctx: ToolContext, bot: Ai_Bot, capabilities: string[], withTeam = false, extra: { summary?: string | null; canRemember?: boolean } = {}): Promise<string> {
    const [user, company, team, memories] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }),
      this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { comercial_name: true } }),
      withTeam ? this.bots.listFor(ctx) : Promise.resolve([]),
      this.memory.forPrompt(ctx, bot.id),
    ]);
    const colleagues = team.filter((item) => item.id !== bot.id);
    const now = nowBr();
    const weekday = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'][now.getUTCDay()];
    return [
      BASE_RULES,
      `\n## Quem você é\nVocê é ${bot.persona ?? bot.name}, ${bot.role ?? `assistente de ${bot.name}`} da equipe de assistentes da empresa. Na primeira resposta de uma conversa nova, pode se apresentar em uma frase curta; depois, vá direto ao ponto.`,
      `\n## Seu papel\n${bot.instructions}`,
      personalityPrompt(bot.avatar),
      `\n## O que você consegue fazer para esta pessoa\n${capabilities.length ? capabilities.map((item) => `- ${item}`).join('\n') : '- Nenhuma ferramenta liberada para esta pessoa: só converse e oriente.'}`,
      ...(colleagues.length ? [`\n## Sua equipe\nColegas que esta pessoa pode usar (área: nome, cargo — o que faz):\n${colleagues.map((item) => `- ${item.key}: ${item.persona}, ${item.role} — ${item.description}`).join('\n')}\n- Precisa de um dado da área de um colega para responder? Use pedir_ao_colega (ele só consulta). A pessoa quer fazer algo que é da área de outro? Use passar_para_colega com um resumo completo. Não faça os dois para a mesma coisa e não peça ao colega o que você mesmo consegue consultar.`] : []),
      ctx.delegated ? `\n## Pedido de um colega\nQuem pede agora é outro assistente da equipe, ajudando a mesma pessoa. Responda só o que foi pedido, com números e nomes, sem cumprimentos. Você só consulta: não crie nem altere nada.` : '',
      `\n## Contexto\n- Empresa: ${company?.comercial_name ?? '—'}\n- Pessoa: ${user?.name ?? '—'}\n- Hoje: ${weekday}, ${now.toISOString().slice(0, 10)}, ${now.toISOString().slice(11, 16)} (horário de Brasília)`,
      this.memory.promptSection(memories, user?.name ?? 'a pessoa', !!extra.canRemember && !ctx.delegated),
      extra.summary ? `\n## Resumo do começo desta conversa\nAs mensagens mais antigas desta conversa foram resumidas abaixo; as recentes vêm a seguir, inteiras.\n${extra.summary}` : '',
    ].filter(Boolean).join('\n');
  }

  /** A conversa no formato neutro, com as últimas mensagens (e imagens das mensagens recentes). */
  private async history(conversationId: number, afterId = 0): Promise<ChatMessage[]> {
    const rows = (await this.prisma.ai_Message.findMany({ where: { conversationId, role: { in: ['user', 'assistant', 'tool'] }, id: { gt: afterId } }, orderBy: { id: 'desc' }, take: HISTORY_LIMIT })).reverse();
    // não começa no meio de um par chamada → resultado
    while (rows.length && rows[0].role !== 'user') rows.shift();
    const lastUserIndex = rows.map((row) => row.role).lastIndexOf('user');
    const out: ChatMessage[] = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const content = (row.content ?? {}) as Record<string, any>;
      if (row.role === 'user') {
        const images: ChatImage[] = [];
        // imagem só da última mensagem da pessoa: as antigas já foram lidas e custariam de novo
        if (index === lastUserIndex) {
          for (const item of (content.attachments ?? []) as Attachment[]) {
            const buffer = await this.storage.get(item.key).catch(() => null);
            if (buffer) images.push({ mediaType: item.mediaType, base64: buffer.toString('base64') });
          }
        }
        const names = ((content.attachments ?? []) as Attachment[]).map((item) => item.name);
        const text = [content.text ?? '', index !== lastUserIndex && names.length ? `[anexos: ${names.join(', ')}]` : ''].filter(Boolean).join('\n');
        out.push({ role: 'user', text, images: images.length ? images : undefined });
      } else if (row.role === 'assistant') {
        out.push({ role: 'assistant', text: content.text || undefined, toolCalls: content.toolCalls?.length ? content.toolCalls : undefined, raw: content.raw });
      } else {
        // resultado antigo (antes da última pergunta) entra cortado: o modelo já o leu
        const old = index < lastUserIndex;
        const cutResult = (text: unknown) => {
          const value = String(text ?? '');
          return old && value.length > OLD_TOOL_RESULT_MAX ? `${value.slice(0, OLD_TOOL_RESULT_MAX)}… [resultado antigo cortado; consulte de novo se precisar]` : value;
        };
        out.push({ role: 'tool', results: (content.results ?? []).map((result: any) => ({ toolCallId: result.toolCallId, name: result.name, content: cutResult(result.content), isError: result.isError })) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- equipe conversando

  /** O colega pela área (key), se a pessoa pode usá-lo. Recusa (não erro) para o modelo corrigir. */
  private async colleague(ctx: ToolContext, rawKey: unknown): Promise<Ai_Bot> {
    const key = String(rawKey ?? '').trim().toLowerCase();
    const bot = key ? await this.prisma.ai_Bot.findFirst({ where: { companyId: ctx.companyId, key, inactiveAt: null } }) : null;
    if (!bot) {
      const team = await this.bots.listFor(ctx);
      throw new ToolRefusal(`Colega "${key}" não encontrado. Use uma destas áreas: ${team.map((item) => `${item.key} (${item.persona})`).join(', ')}`);
    }
    if (bot.id === ctx.botId) throw new ToolRefusal('Este colega é você mesmo');
    if (!bot.active) throw new ToolRefusal(`${bot.persona ?? bot.name} está desligado`);
    if (!ctx.permissions.includes(bot.permissionKey)) throw new ToolRefusal(`A pessoa não tem acesso a ${bot.persona ?? bot.name}`);
    return bot;
  }

  private async callerName(ctx: ToolContext) {
    const bot = ctx.botId ? await this.prisma.ai_Bot.findUnique({ where: { id: ctx.botId }, select: { persona: true, name: true } }) : null;
    return bot?.persona ?? bot?.name ?? 'Um colega';
  }

  /** pedir_ao_colega: o colega responde numa conversa à parte, só com as ferramentas de consulta dele. */
  async askColleague(ctx: ToolContext, input: Record<string, any>) {
    if (ctx.delegated) throw new ToolRefusal('Você está respondendo a um colega e não pode pedir a um terceiro. Responda com o que tem.');
    const request = String(input?.pedido ?? '').trim().slice(0, 2000);
    if (!request) throw new ToolRefusal('Escreva o pedido para o colega');
    const colleague = await this.colleague(ctx, input?.colega);
    const persona = colleague.persona ?? colleague.name;
    if (!this.providers.get(colleague.provider)?.available()) throw new ToolRefusal(`${persona} está sem chave de IA configurada`);
    const readTools = ((colleague.tools as string[]) ?? []).filter((name) => this.catalog.get(name)?.risk === 'read' && !TEAM_TOOL_NAMES.includes(name));
    const caller = await this.callerName(ctx);
    const conversation = await this.prisma.ai_Conversation.create({
      data: { companyId: ctx.companyId, userId: ctx.userId, botId: colleague.id, origin: 'colega', title: `${caller} perguntou: ${request.replace(/\s+/g, ' ')}`.slice(0, 160) },
    });
    try {
      const out = await this.sendAndWait({ ...ctx, origin: ctx.origin, botId: colleague.id, delegated: true }, { ...colleague, tools: readTools }, conversation.id, `[${caller} pergunta]\n${request}`, { maxTurns: COLLEAGUE_TURNS });
      return { colega: persona, resposta: out.text || '(sem resposta)', observacao: `Monte a sua resposta com isto e diga que consultou ${persona}.` };
    } catch (error) {
      throw new ToolRefusal(`${persona} não conseguiu responder: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
    }
  }

  /** passar_para_colega: abre a conversa com o colega já com o resumo (sem chamar o modelo). */
  async handOff(ctx: ToolContext, input: Record<string, any>) {
    if (ctx.delegated) throw new ToolRefusal('Você está respondendo a um colega: não passe a conversa adiante.');
    if (ctx.origin !== 'bots') throw new ToolRefusal('Passar a conversa só funciona na área de Bots, com a pessoa conversando');
    const summary = String(input?.resumo ?? '').trim().slice(0, 3000);
    if (!summary) throw new ToolRefusal('Escreva o resumo para o colega');
    const colleague = await this.colleague(ctx, input?.colega);
    const persona = colleague.persona ?? colleague.name;
    const caller = await this.callerName(ctx);
    const title = String(input?.titulo ?? '').trim() || summary.replace(/\s+/g, ' ');
    const conversation = await this.prisma.ai_Conversation.create({ data: { companyId: ctx.companyId, userId: ctx.userId, botId: colleague.id, title: title.slice(0, 80) } });
    // para o modelo do colega: quem passou e o resumo; para a pessoa: um aviso
    await this.prisma.ai_Message.create({ data: { conversationId: conversation.id, role: 'user', content: { text: `[aviso do sistema] ${caller} passou esta conversa para você. Resumo do que a pessoa quer:\n${summary}\nNa próxima mensagem da pessoa, continue a partir daqui sem pedir de novo o que já está no resumo.`, system: true } } });
    await this.prisma.ai_Message.create({ data: { conversationId: conversation.id, role: 'assistant', content: { text: 'Entendido.', system: true } } });
    await this.prisma.ai_Message.create({ data: { conversationId: conversation.id, role: 'notice', content: { text: `${caller} passou esta conversa para ${persona}. Resumo: ${summary}` } } });
    return {
      conversaId: conversation.id, botId: colleague.id, colega: persona,
      instrucao: `Pronto: a conversa com ${persona} já está aberta com o resumo. Diga à pessoa, em uma frase, para continuar por lá pelo botão logo abaixo.`,
    };
  }

  // ---------------------------------------------------------------- confirmação na conversa

  /** Depois do clique no cartão, registra na conversa o que aconteceu (sem chamar o modelo). */
  async afterAction(actor: BotActor, conversationId: number | null, text: string) {
    if (!conversationId) return;
    const conversation = await this.prisma.ai_Conversation.findFirst({ where: { id: conversationId, companyId: actor.companyId, userId: actor.userId } });
    if (!conversation) return;
    await this.prisma.ai_Message.create({ data: { conversationId, role: 'notice', content: { text } } });
    // e conta para o modelo na próxima mensagem
    await this.prisma.ai_Message.create({ data: { conversationId, role: 'user', content: { text: `[aviso do sistema] ${text}`, system: true } } });
    await this.prisma.ai_Message.create({ data: { conversationId, role: 'assistant', content: { text: 'Entendido.', system: true } } });
  }
}
