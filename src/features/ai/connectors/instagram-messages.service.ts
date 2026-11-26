import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { InstagramError, InstagramService, graph, metaMessage } from './instagram.service';
import { InstagramSettings, spDayRange } from './instagram-settings';
import { chatHooks } from 'src/features/chat/chat.hooks';

/**
 * Direct e comentários do Instagram (Messaging API da Meta).
 *
 * - O webhook grava as mensagens recebidas e os ecos das enviadas
 *   (Ai_SocialMessage, idempotente pelo id da Meta) e, com a resposta
 *   automática ligada, dentro do horário e do limite, chama a Nina no servidor
 *   para decidir se responde ou deixa para humano.
 * - A Meta só aceita resposta no Direct até 24 horas depois da última
 *   mensagem do cliente: validado aqui, antes de chamar a Meta.
 * - A tela sincroniza as conversas pela API ao abrir (o webhook pode não ter
 *   pego as antigas).
 */

const WINDOW_MS = 24 * 3600000;
const MAX_DM_BYTES = 1000;
const MAX_COMMENT = 2200;

export interface MessageActor { companyId: number; userId?: number | null; botId?: number | null }

const brDateTime = (date: Date) => date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const toDate = (value: unknown): Date => {
  if (typeof value === 'number' || /^\d+$/.test(String(value ?? ''))) {
    const n = Number(value);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const date = new Date(String(value ?? '').replace(/\+0000$/, 'Z'));
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

@Injectable()
export class InstagramMessagesService {
  private readonly logger = new Logger(InstagramMessagesService.name);

  constructor(private readonly prisma: PrismaService, private readonly instagram: InstagramService) {}

  /** Para os testes (a resposta automática do Direct agora é do bot das Conversas). */
  async idle() {}

  // ---------------------------------------------------------------- regras

  private async rules(companyId: number): Promise<InstagramSettings> {
    return this.instagram.settings(companyId);
  }

  async assertCanRead(companyId: number) {
    const settings = await this.rules(companyId);
    if (!settings.ler_mensagens.enabled) throw new BadRequestException('Ler mensagens do Direct está desligado nas configurações do Instagram (Bots → Conectores).');
    return settings;
  }

  async assertComments(companyId: number) {
    const settings = await this.rules(companyId);
    if (!settings.comentarios.enabled) throw new BadRequestException('Comentários estão desligados nas configurações do Instagram (Bots → Conectores).');
    return settings;
  }

  /** Chamada à Meta com erro legível (e conexão marcada como expirada se a chave caiu). */
  private async meta<T>(companyId: number, work: (ctx: { accountId: string; token: string }) => Promise<T>): Promise<T> {
    let conn: Awaited<ReturnType<InstagramService['connection']>>;
    try { conn = await this.instagram.connection(companyId); } catch (error) { throw new BadRequestException((error as Error).message); }
    try {
      return await work({ accountId: conn.row.accountId, token: conn.token });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      const info = error instanceof InstagramError ? { message: error.message, tokenInvalid: error.tokenInvalid } : metaMessage(error);
      if (info.tokenInvalid) {
        await this.instagram.markExpired(companyId, info.message);
        throw new BadRequestException('A conexão com o Instagram expirou. Conecte de novo em Bots → Conectores.');
      }
      throw new BadRequestException(`A Meta recusou: ${info.message}`);
    }
  }

  // ---------------------------------------------------------------- webhook

  /** Verificação da assinatura X-Hub-Signature-256 (HMAC-SHA256 do corpo bruto com a chave secreta do app). */
  validSignature(raw: Buffer | undefined, header: unknown): boolean {
    const secret = process.env.INSTAGRAM_APP_SECRET?.trim();
    if (!secret || !Buffer.isBuffer(raw) || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
    const got = Buffer.from(header.slice(7));
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /** Verificação do endereço pela Meta (hub.challenge). */
  challenge(query: Record<string, unknown>): string {
    const token = process.env.INSTAGRAM_WEBHOOK_TOKEN?.trim();
    const got = String(query['hub.verify_token'] ?? '');
    if (query['hub.mode'] !== 'subscribe' || !token || got.length !== token.length || !timingSafeEqual(Buffer.from(got), Buffer.from(token))) {
      throw new ForbiddenException('Verificação do webhook recusada');
    }
    return String(query['hub.challenge'] ?? '');
  }

  /** Grava o que chegou (rápido) e deixa a resposta automática rodando em segundo plano. */
  async receive(body: any): Promise<{ stored: number }> {
    if (body?.object !== 'instagram' || !Array.isArray(body.entry)) return { stored: 0 };
    let stored = 0;
    for (const entry of body.entry) {
      const accountId = String(entry?.id ?? '');
      if (!accountId) continue;
      const connectors = await this.prisma.ai_Connector.findMany({ where: { provider: 'instagram', accountId }, select: { companyId: true } });
      for (const { companyId } of connectors) {
        const events: { kind: 'message' | 'comment'; value: any }[] = [];
        for (const item of Array.isArray(entry.messaging) ? entry.messaging : []) events.push({ kind: 'message', value: item });
        for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
          if (change?.field === 'messages') events.push({ kind: 'message', value: change.value });
          if (change?.field === 'comments' || change?.field === 'live_comments') events.push({ kind: 'comment', value: change.value });
        }
        if (entry.field === 'comments' && entry.value) events.push({ kind: 'comment', value: entry.value });
        for (const event of events) {
          const ok = event.kind === 'message' ? await this.storeMessaging(companyId, accountId, event.value) : await this.storeComment(companyId, accountId, event.value);
          if (ok) stored++;
        }
      }
    }
    return { stored };
  }

  /** Insere sem duplicar (o id da Meta é único). Devolve a linha ou null se já existia. */
  private async insert(data: Prisma.Ai_SocialMessageUncheckedCreateInput) {
    try {
      const row = await this.prisma.ai_SocialMessage.create({ data });
      // a caixa de entrada (Conversas) espelha o Direct
      if (row.channel === 'direct') {
        try { chatHooks.instagramMessage?.(row); } catch (error) { this.logger.warn(`Conversas: espelho do Direct falhou: ${(error as Error).message}`); }
      }
      return row;
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return null;
      throw error;
    }
  }

  private async storeMessaging(companyId: number, accountId: string, event: any): Promise<boolean> {
    const message = event?.message;
    if (!message?.mid || message.is_deleted || message.is_unsupported) return false;
    const echo = !!message.is_echo || String(event.sender?.id ?? '') === accountId;
    const customer = String((echo ? event.recipient?.id : event.sender?.id) ?? '');
    if (!customer) return false;
    const known = await this.prisma.ai_SocialMessage.findFirst({ where: { companyId, channel: 'direct', conversationId: customer, fromUsername: { not: null }, direction: 'in' }, select: { fromUsername: true } });
    const attachments = Array.isArray(message.attachments) ? message.attachments.map((item: any) => ({ type: String(item?.type ?? 'file'), url: item?.payload?.url ? String(item.payload.url) : null })) : null;
    const row = await this.insert({
      companyId, channel: 'direct', conversationId: customer, externalId: String(message.mid), direction: echo ? 'out' : 'in',
      fromId: String(event.sender?.id ?? '') || null, fromUsername: echo ? null : known?.fromUsername ?? null,
      text: String(message.text ?? ''), attachments: attachments ?? undefined, sentAt: toDate(event.timestamp ?? Date.now()),
      origin: 'webhook', status: echo ? 'sent' : 'received',
    });
    if (!row) return false;
    return true;
  }

  private async storeComment(companyId: number, accountId: string, value: any): Promise<boolean> {
    const id = String(value?.id ?? value?.comment_id ?? '');
    const mediaId = String(value?.media?.id ?? value?.media_id ?? '');
    if (!id || !mediaId) return false;
    const fromId = String(value?.from?.id ?? '');
    const row = await this.insert({
      companyId, channel: 'comment', conversationId: mediaId, externalId: `comment:${id}`, direction: fromId === accountId ? 'out' : 'in',
      fromId: fromId || null, fromUsername: value?.from?.username ? String(value.from.username) : null, text: String(value?.text ?? ''),
      parentId: value?.parent_id ? String(value.parent_id) : null, sentAt: new Date(), origin: 'webhook', status: 'received',
    });
    return !!row;
  }

  // ---------------------------------------------------------------- conversas

  /** Busca as conversas recentes na Meta e grava o que faltar. */
  async sync(companyId: number): Promise<{ conversations: number; messages: number }> {
    return this.meta(companyId, async ({ accountId, token }) => {
      const res = await axios.get(graph(`/${accountId}/conversations`), {
        params: { platform: 'instagram', fields: 'participants,updated_time,messages{id,from,to,message,created_time}', limit: 25, access_token: token }, timeout: 20000,
      });
      const list: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
      let messages = 0;
      for (const conv of list) {
        const participants: any[] = Array.isArray(conv?.participants?.data) ? conv.participants.data : [];
        const customer = participants.find((p) => String(p?.id) !== accountId);
        if (!customer?.id) continue;
        const customerId = String(customer.id);
        const items: any[] = Array.isArray(conv?.messages?.data) ? conv.messages.data : [];
        const outTimes = items.filter((m) => String(m?.from?.id) === accountId).map((m) => toDate(m.created_time).getTime());
        const lastOut = outTimes.length ? Math.max(...outTimes) : 0;
        for (const item of items) {
          if (!item?.id) continue;
          const out = String(item?.from?.id) === accountId;
          const sentAt = toDate(item.created_time);
          const unread = !out && sentAt.getTime() > lastOut && Date.now() - sentAt.getTime() < 7 * 86400000;
          const row = await this.insert({
            companyId, channel: 'direct', conversationId: customerId, externalId: String(item.id), direction: out ? 'out' : 'in',
            fromId: item?.from?.id ? String(item.from.id) : null, fromUsername: out ? null : (item?.from?.username ?? customer.username ?? null),
            text: String(item.message ?? ''), sentAt, readAt: unread || out ? null : sentAt, origin: 'sync', status: out ? 'sent' : 'received',
          });
          if (row) messages++;
        }
        if (customer.username) {
          await this.prisma.ai_SocialMessage.updateMany({ where: { companyId, channel: 'direct', conversationId: customerId, direction: 'in', fromUsername: null }, data: { fromUsername: String(customer.username) } });
        }
      }
      return { conversations: list.length, messages };
    });
  }

  private window(lastInboundAt: Date | null) {
    const until = lastInboundAt ? new Date(lastInboundAt.getTime() + WINDOW_MS) : null;
    return { lastInboundAt, replyUntil: until, canReply: !!until && until.getTime() > Date.now() };
  }

  /** Lista de conversas: última mensagem, não lidas e se ainda dá para responder (24 h). */
  async conversations(companyId: number, options: { sync?: boolean } = {}) {
    await this.assertCanRead(companyId);
    let syncError: string | null = null;
    if (options.sync) {
      try { await this.sync(companyId); } catch (error) { syncError = (error as Error).message; }
    }
    const rows = await this.prisma.ai_SocialMessage.findMany({ where: { companyId, channel: 'direct' }, orderBy: { sentAt: 'desc' }, take: 3000 });
    const map = new Map<string, any>();
    for (const row of rows) {
      let conv = map.get(row.conversationId);
      if (!conv) {
        conv = { id: row.conversationId, username: null as string | null, lastMessage: { text: row.text, direction: row.direction, sentAt: row.sentAt, status: row.status, hasAttachments: !!row.attachments }, unread: 0, lastInboundAt: null as Date | null };
        map.set(row.conversationId, conv);
      }
      if (row.direction === 'in') {
        conv.username ??= row.fromUsername;
        conv.lastInboundAt ??= row.sentAt;
        if (!row.readAt) conv.unread++;
      }
    }
    const conversations = [...map.values()].map((conv) => ({ ...conv, ...this.window(conv.lastInboundAt) }));
    return { conversations, syncError };
  }

  /** Mensagens de uma conversa (mais antiga primeiro). */
  async conversation(companyId: number, conversationId: string, options: { sync?: boolean } = {}) {
    await this.assertCanRead(companyId);
    let syncError: string | null = null;
    if (options.sync) {
      try { await this.sync(companyId); } catch (error) { syncError = (error as Error).message; }
    }
    const rows = await this.prisma.ai_SocialMessage.findMany({ where: { companyId, channel: 'direct', conversationId }, orderBy: { sentAt: 'desc' }, take: 100 });
    if (!rows.length) throw new NotFoundException('Conversa não encontrada');
    const lastIn = rows.find((row) => row.direction === 'in');
    return {
      id: conversationId,
      username: rows.find((row) => row.fromUsername)?.fromUsername ?? null,
      ...this.window(lastIn?.sentAt ?? null),
      messages: rows.reverse().map((row) => ({
        id: row.id, direction: row.direction, text: row.text, attachments: row.attachments ?? [], sentAt: row.sentAt, readAt: row.readAt,
        origin: row.origin, status: row.status, note: row.note, repliedByBotId: row.repliedByBotId, repliedByUserId: row.repliedByUserId,
      })),
      syncError,
    };
  }

  async markRead(companyId: number, conversationId: string) {
    await this.assertCanRead(companyId);
    const done = await this.prisma.ai_SocialMessage.updateMany({ where: { companyId, channel: 'direct', conversationId, direction: 'in', readAt: null }, data: { readAt: new Date() } });
    return { ok: true, marked: done.count };
  }

  private async sentToday(companyId: number, channel: 'direct' | 'comment') {
    const { start, end } = spDayRange();
    return this.prisma.ai_SocialMessage.count({ where: { companyId, channel, direction: 'out', origin: 'system', sentAt: { gte: start, lt: end } } });
  }

  /**
   * Confere tudo antes de responder no Direct (sem enviar): ação ligada, limite
   * do dia, tamanho do texto e a janela de 24 horas da Meta.
   */
  async checkReply(companyId: number, conversationId: string, rawText: unknown) {
    const settings = await this.rules(companyId);
    const rule = settings.responder_mensagens;
    if (!rule.enabled) throw new BadRequestException('Responder mensagens do Direct está desligado nas configurações do Instagram (Bots → Conectores).');
    const text = String(rawText ?? '').trim();
    if (!text) throw new BadRequestException('Escreva a resposta');
    if (Buffer.byteLength(text, 'utf8') > MAX_DM_BYTES) throw new BadRequestException('A resposta passa do tamanho que o Instagram aceita (cerca de 1.000 caracteres). Encurte o texto.');
    const { id, lastIn } = await this.assertWindow(companyId, conversationId);
    const used = await this.sentToday(companyId, 'direct');
    if (used >= rule.limitePorDia) throw new BadRequestException(`Limite do dia atingido: ${rule.limitePorDia} respostas no Direct por dia. Aumente o limite em Bots → Conectores ou responda pelo app.`);
    return { text, conversationId: id, username: lastIn.fromUsername, lastInboundAt: lastIn.sentAt, lastInboundText: lastIn.text, settings };
  }

  /** A conversa existe e ainda está dentro das 24 h da Meta. */
  private async assertWindow(companyId: number, conversationId: string) {
    const id = String(conversationId ?? '').trim();
    if (!id) throw new BadRequestException('Conversa não informada');
    let lastIn = await this.prisma.ai_SocialMessage.findFirst({ where: { companyId, channel: 'direct', conversationId: id, direction: 'in' }, orderBy: { sentAt: 'desc' } });
    if (!lastIn) {
      // a conversa pode ser anterior ao webhook: tenta buscar na Meta
      await this.sync(companyId).catch(() => undefined);
      lastIn = await this.prisma.ai_SocialMessage.findFirst({ where: { companyId, channel: 'direct', conversationId: id, direction: 'in' }, orderBy: { sentAt: 'desc' } });
    }
    if (!lastIn) throw new NotFoundException('Conversa não encontrada (o cliente precisa ter mandado mensagem antes)');
    if (Date.now() - lastIn.sentAt.getTime() > WINDOW_MS) {
      throw new BadRequestException(`A Meta só permite responder no Direct até 24 horas depois da última mensagem do cliente (a última foi em ${brDateTime(lastIn.sentAt)}). Responda pelo app do Instagram ou espere o cliente escrever de novo.`);
    }
    return { id, lastIn };
  }

  /** Manda foto, vídeo, áudio ou arquivo no Direct (a Meta baixa pelo endereço, que precisa ser público por alguns minutos). */
  async replyMedia(actor: MessageActor, conversationId: string, file: { type: 'image' | 'video' | 'audio' | 'file'; url: string }) {
    const settings = await this.rules(actor.companyId);
    const rule = settings.responder_mensagens;
    if (!rule.enabled) throw new BadRequestException('Responder mensagens do Direct está desligado nas configurações do Instagram (Bots → Conectores).');
    const { id } = await this.assertWindow(actor.companyId, conversationId);
    const used = await this.sentToday(actor.companyId, 'direct');
    if (used >= rule.limitePorDia) throw new BadRequestException(`Limite do dia atingido: ${rule.limitePorDia} respostas no Direct por dia. Aumente o limite em Bots → Conectores ou responda pelo app.`);
    const sent = await this.meta(actor.companyId, async ({ accountId, token }) => {
      const res = await axios.post(graph(`/${accountId}/messages`), { recipient: { id }, message: { attachment: { type: file.type, payload: { url: file.url } } } }, { params: { access_token: token }, timeout: 30000 });
      return res.data ?? {};
    });
    const row = await this.insert({
      companyId: actor.companyId, channel: 'direct', conversationId: id, externalId: String(sent.message_id ?? `sent:${randomUUID()}`),
      direction: 'out', text: '', attachments: [{ type: file.type, url: null }], sentAt: new Date(), origin: 'system', status: 'sent',
      repliedByBotId: actor.botId ?? null, repliedByUserId: actor.botId ? null : actor.userId ?? null,
    });
    return { ok: true, id: row?.id ?? null, conversationId: id };
  }

  /** Responde no Direct (tela, ferramenta ou resposta automática). */
  async reply(actor: MessageActor, conversationId: string, text: unknown) {
    const checked = await this.checkReply(actor.companyId, conversationId, text);
    const sent = await this.meta(actor.companyId, async ({ accountId, token }) => {
      const res = await axios.post(graph(`/${accountId}/messages`), { recipient: { id: checked.conversationId }, message: { text: checked.text } }, { params: { access_token: token }, timeout: 20000 });
      return res.data ?? {};
    });
    const row = await this.insert({
      companyId: actor.companyId, channel: 'direct', conversationId: checked.conversationId, externalId: String(sent.message_id ?? `sent:${randomUUID()}`),
      direction: 'out', text: checked.text, sentAt: new Date(), origin: 'system', status: 'sent', repliedByBotId: actor.botId ?? null, repliedByUserId: actor.botId ? null : actor.userId ?? null,
    });
    await this.prisma.ai_SocialMessage.updateMany({ where: { companyId: actor.companyId, channel: 'direct', conversationId: checked.conversationId, direction: 'in', readAt: null }, data: { readAt: new Date() } });
    return { ok: true, id: row?.id ?? null, conversationId: checked.conversationId, username: checked.username, text: checked.text };
  }

  // ---------------------------------------------------------------- comentários

  private presentComment(item: any) {
    return {
      id: String(item.id), text: String(item.text ?? ''), username: item.username ?? item.from?.username ?? null, timestamp: item.timestamp ?? null, hidden: !!item.hidden,
      replies: Array.isArray(item.replies?.data) ? item.replies.data.map((reply: any) => ({ id: String(reply.id), text: String(reply.text ?? ''), username: reply.username ?? null, timestamp: reply.timestamp ?? null })) : [],
    };
  }

  /** Comentários recentes dos últimos posts (ou de um post). */
  async comments(companyId: number, options: { mediaId?: string; posts?: number } = {}) {
    await this.assertComments(companyId);
    const fields = 'id,text,username,timestamp,hidden,replies{id,text,username,timestamp}';
    return this.meta(companyId, async ({ accountId, token }) => {
      const load = async (mediaId: string) => {
        const res = await axios.get(graph(`/${mediaId}/comments`), { params: { fields, limit: 50, access_token: token }, timeout: 20000 });
        return (Array.isArray(res.data?.data) ? res.data.data : []).map((item: any) => this.presentComment(item));
      };
      if (options.mediaId) return { posts: [{ id: options.mediaId, caption: null, permalink: null, timestamp: null, comments: await load(options.mediaId) }] };
      const media = await axios.get(graph(`/${accountId}/media`), { params: { fields: 'id,caption,permalink,timestamp,comments_count', limit: Math.min(25, Math.max(1, options.posts ?? 10)), access_token: token }, timeout: 20000 });
      const list: any[] = Array.isArray(media.data?.data) ? media.data.data : [];
      const posts: any[] = [];
      for (const item of list.filter((m) => Number(m?.comments_count) > 0).slice(0, 5)) {
        posts.push({ id: String(item.id), caption: item.caption ? String(item.caption).slice(0, 200) : null, permalink: item.permalink ?? null, timestamp: item.timestamp ?? null, comments: await load(String(item.id)) });
      }
      return { posts };
    });
  }

  /** Lê um comentário na Meta (para o cartão e para gravar a resposta no post certo). */
  async comment(companyId: number, commentId: string) {
    const id = String(commentId ?? '').trim();
    if (!/^\d{3,40}$/.test(id)) throw new BadRequestException('Comentário inválido');
    return this.meta(companyId, async ({ token }) => {
      const res = await axios.get(graph(`/${id}`), { params: { fields: 'id,text,username,timestamp,hidden,media{id}', access_token: token }, timeout: 20000 });
      return { id, text: String(res.data?.text ?? ''), username: res.data?.username ?? null, hidden: !!res.data?.hidden, mediaId: res.data?.media?.id ? String(res.data.media.id) : null };
    });
  }

  async checkCommentReply(companyId: number, commentId: string, rawText: unknown, known?: { id: string; text: string; username: string | null; hidden: boolean; mediaId: string | null }) {
    const settings = await this.assertComments(companyId);
    const text = String(rawText ?? '').trim();
    if (!text) throw new BadRequestException('Escreva a resposta');
    if (text.length > MAX_COMMENT) throw new BadRequestException(`A resposta passa de ${MAX_COMMENT} caracteres`);
    const used = await this.sentToday(companyId, 'comment');
    if (used >= settings.comentarios.limitePorDia) throw new BadRequestException(`Limite do dia atingido: ${settings.comentarios.limitePorDia} respostas a comentários por dia. Aumente o limite em Bots → Conectores.`);
    const comment = known && known.id === String(commentId) ? known : await this.comment(companyId, commentId);
    return { text, comment, settings };
  }

  /** known: o comentário já lido no cartão (não busca de novo na Meta). */
  async replyComment(actor: MessageActor, commentId: string, text: unknown, known?: { username: string | null; mediaId: string | null }) {
    const checked = await this.checkCommentReply(actor.companyId, commentId, text, known ? { id: String(commentId), text: '', hidden: false, ...known } : undefined);
    const sent = await this.meta(actor.companyId, async ({ token }) => {
      const res = await axios.post(graph(`/${checked.comment.id}/replies`), null, { params: { message: checked.text, access_token: token }, timeout: 20000 });
      return res.data ?? {};
    });
    await this.insert({
      companyId: actor.companyId, channel: 'comment', conversationId: checked.comment.mediaId ?? 'desconhecido', externalId: `comment:${sent.id ?? randomUUID()}`, direction: 'out',
      text: checked.text, parentId: checked.comment.id, sentAt: new Date(), origin: 'system', status: 'sent', repliedByBotId: actor.botId ?? null, repliedByUserId: actor.botId ? null : actor.userId ?? null,
    });
    return { ok: true, id: sent.id ? String(sent.id) : null, commentId: checked.comment.id, username: checked.comment.username, text: checked.text };
  }

  async hideComment(companyId: number, commentId: string, hide = true) {
    await this.assertComments(companyId);
    const id = String(commentId ?? '').trim();
    if (!/^\d{3,40}$/.test(id)) throw new BadRequestException('Comentário inválido');
    await this.meta(companyId, async ({ token }) => {
      await axios.post(graph(`/${id}`), null, { params: { hide: hide ? 'true' : 'false', access_token: token }, timeout: 20000 });
    });
    return { ok: true, commentId: id, hidden: hide };
  }
}
