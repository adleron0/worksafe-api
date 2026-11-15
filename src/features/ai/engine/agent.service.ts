import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Ai_Bot, Ai_Message, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrivateStorageService } from 'src/common/storage/private-storage.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { BASE_RULES } from '../bots/bot.defaults';
import { BotActor, BotService } from '../bots/bot.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { ChatImage, ChatMessage, ChatResponse, ChatToolResult } from '../providers/provider.types';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { ToolContext } from '../tools/tool.types';
import { UsageService } from './usage.service';

export interface RunStep { at: string; kind: 'tool' | 'notice'; label: string; tool?: string; status: 'running' | 'ok' | 'refused' | 'denied' | 'error' | 'pending'; pendingActionId?: number }
export interface Attachment { name: string; mediaType: string; size: number; key: string }
export interface UploadedImage { buffer: Buffer; originalname: string; mimetype: string; size: number }

/** Quantas idas ao modelo numa resposta (cada ida pode chamar várias ferramentas). */
const MAX_TURNS = 12;
/** Quantas mensagens antigas entram no contexto. */
const HISTORY_LIMIT = 40;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const IMAGE_MAX = 5 * 1024 * 1024;

const nowBr = () => new Date(Date.now() - 3 * 3600 * 1000);

export const botsEnabled = () => process.env.AI_BOTS_ENABLED !== 'false';

/**
 * O motor: recebe a mensagem, chama o modelo com as ferramentas do bot
 * (filtradas pelas permissões da pessoa), executa as chamadas e repete até a
 * resposta final. Roda fora da requisição; a tela acompanha pelos passos
 * gravados em Ai_Run.
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: BotService,
    private readonly catalog: ToolCatalogService,
    private readonly providers: ProviderRegistry,
    private readonly usage: UsageService,
    private readonly storage: PrivateStorageService,
  ) {}

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
      return { id: message.id, role: 'tool', results: (content.results ?? []).map((result: any) => ({ name: result.name, status: result.status ?? (result.isError ? 'error' : 'ok'), pendingActionId: result.pendingActionId ?? null })), createdAt: message.createdAt };
    }
    return {
      id: message.id, role: message.role, text: content.text ?? '', attachments: (content.attachments ?? []).map((item: Attachment) => ({ name: item.name, mediaType: item.mediaType, size: item.size })),
      toolCalls: (content.toolCalls ?? []).map((call: any) => ({ name: call.name, title: this.catalog.get(call.name)?.title ?? call.name })),
      createdAt: message.createdAt,
    };
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
    if (files.length > 3) throw new BadRequestException('Até 3 imagens por mensagem');
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.mimetype)) throw new BadRequestException('Anexe imagens PNG, JPG ou WEBP');
      if (file.size > IMAGE_MAX) throw new BadRequestException('Imagem maior que 5 MB');
    }
    const provider = this.providers.get(bot.provider);
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
  async sendAndWait(ctx: ToolContext, bot: Ai_Bot, conversationId: number, text: string): Promise<{ text: string; costUsd: number; runId: number }> {
    const run = await this.prisma.ai_Run.create({ data: { conversationId, userId: ctx.userId, status: 'running', steps: [] } });
    await this.prisma.ai_Message.create({ data: { conversationId, runId: run.id, role: 'user', content: { text } } });
    await this.loop({ ...ctx, runId: run.id, conversationId, botId: bot.id }, bot);
    const [last, done] = await Promise.all([
      this.prisma.ai_Message.findFirst({ where: { conversationId, role: 'assistant' }, orderBy: { id: 'desc' } }),
      this.prisma.ai_Run.findUnique({ where: { id: run.id } }),
    ]);
    if (done?.status === 'error') throw new Error(done.error ?? 'Falha na execução');
    return { text: String((last?.content as any)?.text ?? ''), costUsd: Number(done?.costUsd ?? 0), runId: run.id };
  }

  // ---------------------------------------------------------------- o loop

  private async loop(ctx: ToolContext & { runId: number; conversationId: number; botId: number }, bot: Ai_Bot): Promise<void> {
    const steps: RunStep[] = [];
    const saveSteps = () => this.prisma.ai_Run.update({ where: { id: ctx.runId }, data: { steps: steps as unknown as Prisma.InputJsonValue } });
    let cost = 0;
    try {
      const tools = this.catalog.visible((bot.tools as string[]) ?? [], ctx.permissions);
      const allowedNames = tools.map((tool) => tool.name);
      const definitions = this.catalog.definitions(tools);
      const system = await this.systemPrompt(ctx, bot, tools.map((tool) => tool.title));
      const history = await this.history(ctx.conversationId);

      for (let turn = 0; turn < MAX_TURNS; turn++) {
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
          const step: RunStep = { at: new Date().toISOString(), kind: 'tool', label: tool?.title ?? call.name, tool: call.name, status: 'running' };
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
        if (turn === MAX_TURNS - 1) await this.notice(ctx, 'Parei por segurança: foram passos demais nesta resposta. Peça em partes menores.');
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

  private async systemPrompt(ctx: ToolContext, bot: Ai_Bot, capabilities: string[]): Promise<string> {
    const [user, company] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }),
      this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { comercial_name: true } }),
    ]);
    const now = nowBr();
    const weekday = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'][now.getUTCDay()];
    return [
      BASE_RULES,
      `\n## Seu papel\n${bot.instructions}`,
      `\n## O que você consegue fazer para esta pessoa\n${capabilities.length ? capabilities.map((item) => `- ${item}`).join('\n') : '- Nenhuma ferramenta liberada para esta pessoa: só converse e oriente.'}`,
      `\n## Contexto\n- Empresa: ${company?.comercial_name ?? '—'}\n- Pessoa: ${user?.name ?? '—'}\n- Hoje: ${weekday}, ${now.toISOString().slice(0, 10)}, ${now.toISOString().slice(11, 16)} (horário de Brasília)`,
    ].join('\n');
  }

  /** A conversa no formato neutro, com as últimas mensagens (e imagens das mensagens recentes). */
  private async history(conversationId: number): Promise<ChatMessage[]> {
    const rows = (await this.prisma.ai_Message.findMany({ where: { conversationId, role: { in: ['user', 'assistant', 'tool'] } }, orderBy: { id: 'desc' }, take: HISTORY_LIMIT })).reverse();
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
        out.push({ role: 'tool', results: (content.results ?? []).map((result: any) => ({ toolCallId: result.toolCallId, name: result.name, content: result.content, isError: result.isError })) });
      }
    }
    return out;
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
