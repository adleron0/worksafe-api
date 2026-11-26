import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { EvolutionProvider } from './providers/evolution.provider';
import { ChatActor } from './chat-channels.service';
import { ChatInboundService } from './chat-inbound.service';
import { ChatSendService } from './chat-send.service';
import { SECTORS, phoneDigits } from './chat.settings';
import { ChatEventsService } from './chat-events.service';
import { ChatChannelsService } from './chat-channels.service';
import { ChatInstagramService } from './chat-instagram.service';
import { ChatMedia, ChatMediaService } from './chat-media.service';
import { signerOf } from './chat-signature';
import { ChatCustomerService } from './chat-customer.service';
import { ChatLibraryService } from './chat-library.service';
import { ChatBotService } from './chat-bot.service';

const PAGE = 60;

/** Caixa de entrada: lista, conversa, envio e ações simples (assumir, resolver). */
@Injectable()
export class ChatConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly send: ChatSendService,
    private readonly inbound: ChatInboundService,
    private readonly provider: EvolutionProvider,
    private readonly events: ChatEventsService,
    private readonly instagram: ChatInstagramService,
    private readonly media: ChatMediaService,
    private readonly channels: ChatChannelsService,
    private readonly customerCards: ChatCustomerService,
    private readonly library: ChatLibraryService,
    private readonly bot: ChatBotService,
  ) {}

  private static TAGS = { tags: { where: { tag: { inactiveAt: null } }, select: { tag: { select: { id: true, name: true, color: true } } }, orderBy: { createdAt: 'asc' as const } } };

  private changed(conversation: { companyId: number; channelId: number; id: number; assignedUserId?: number | null }, kind: 'message' | 'conversation' = 'conversation') {
    this.events.emit({ companyId: conversation.companyId, kind, channelId: conversation.channelId, conversationId: conversation.id, assignedUserId: conversation.assignedUserId ?? null });
  }

  private seesAll(actor: ChatActor) {
    return actor.permissions.includes('todas_conversas');
  }

  /** Quem não vê tudo enxerga as conversas dos números em que está na equipe e as atribuídas a ele. */
  private scope(actor: ChatActor): Prisma.Chat_ConversationWhereInput {
    const base: Prisma.Chat_ConversationWhereInput = { companyId: actor.companyId, channel: { active: true }, contact: { hidden: false } };
    if (this.seesAll(actor)) return base;
    return { ...base, OR: [{ channel: { members: { some: { userId: actor.userId } } } }, { assignedUserId: actor.userId }] };
  }

  async list(actor: ChatActor, query: Record<string, string | undefined>) {
    const where: Prisma.Chat_ConversationWhereInput = { AND: [this.scope(actor)] };
    const and = where.AND as Prisma.Chat_ConversationWhereInput[];
    const box = query.box ?? 'abertas';
    if (box === 'resolvidas') and.push({ status: 'resolvida' });
    else and.push({ status: { not: 'resolvida' } });
    if (box === 'minhas') and.push({ assignedUserId: actor.userId });
    if (box === 'sem_dono') and.push({ assignedUserId: null });
    if (box === 'nao_lidas') and.push({ unread: { gt: 0 } });
    if (query.channelId) and.push({ channelId: Number(query.channelId) });
    if (query.tagId) and.push({ tags: { some: { tagId: Number(query.tagId) } } });
    if (query.sector) and.push({ sector: query.sector });
    const search = String(query.search ?? '').trim();
    if (search) {
      const digits = search.replace(/\D/g, '');
      and.push({
        OR: [
          { contact: { name: { contains: search, mode: 'insensitive' } } },
          { contact: { pushName: { contains: search, mode: 'insensitive' } } },
          ...(digits.length >= 4 ? [{ contact: { phone: { contains: digits } } }] : []),
          { lastMessagePreview: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    const rows = await this.prisma.chat_Conversation.findMany({
      where,
      include: { contact: true, channel: { select: { id: true, name: true, color: true, type: true } }, ...ChatConversationsService.TAGS },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: Math.min(200, Number(query.limit) || 100),
    });
    const customers = await this.customers(rows.map((r) => r.contact.customerId));
    const users = await this.users(rows.map((r) => r.assignedUserId));
    const counts = await this.counts(actor);
    return { items: rows.map((r) => this.row(r, customers, users)), counts };
  }

  /** Contadores das abas (abertas, minhas, sem dono, não lidas). */
  async counts(actor: ChatActor) {
    const scope = this.scope(actor);
    const open = { AND: [scope, { status: { not: 'resolvida' } }] } as Prisma.Chat_ConversationWhereInput;
    const [abertas, minhas, sem_dono, nao_lidas] = await Promise.all([
      this.prisma.chat_Conversation.count({ where: open }),
      this.prisma.chat_Conversation.count({ where: { AND: [open, { assignedUserId: actor.userId }] } }),
      this.prisma.chat_Conversation.count({ where: { AND: [open, { assignedUserId: null }] } }),
      this.prisma.chat_Conversation.count({ where: { AND: [open, { unread: { gt: 0 } }] } }),
    ]);
    return { abertas, minhas, sem_dono, nao_lidas };
  }

  private async customers(ids: (number | null)[]) {
    const list = [...new Set(ids.filter((id): id is number => !!id))];
    if (!list.length) return new Map<number, { id: number; name: string }>();
    const rows = await this.prisma.customer.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async users(ids: (number | null)[]) {
    const list = [...new Set(ids.filter((id): id is number => !!id))];
    if (!list.length) return new Map<number, { id: number; name: string; imageUrl: string | null }>();
    const rows = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true, imageUrl: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private row(r: any, customers: Map<number, { id: number; name: string }>, users: Map<number, { id: number; name: string; imageUrl: string | null }>) {
    const customer = r.contact.customerId ? customers.get(r.contact.customerId) ?? null : null;
    return {
      id: r.id, status: r.status, sector: r.sector, unread: r.unread, lastMessageAt: r.lastMessageAt, lastMessagePreview: r.lastMessagePreview, lastDirection: r.lastDirection,
      channel: r.channel,
      contact: { id: r.contact.id, name: r.contact.name || r.contact.pushName || customer?.name || null, pushName: r.contact.pushName, phone: r.contact.phone, avatarUrl: r.contact.avatarUrl, optOut: r.contact.optOut, isNew: !r.contact.firstInboundAt },
      customer,
      assignedUser: r.assignedUserId ? users.get(r.assignedUserId) ?? { id: r.assignedUserId, name: 'Usuário', imageUrl: null } : null,
      tags: (r.tags ?? []).map((t: { tag: { id: number; name: string; color: string } }) => t.tag),
    };
  }

  /** Conversa conferida pelo escopo de quem pede (para as ações comerciais). */
  loadFor(actor: ChatActor, id: number) {
    return this.load(actor, id);
  }

  private async load(actor: ChatActor, id: number) {
    const conversation = await this.prisma.chat_Conversation.findFirst({ where: { AND: [this.scope(actor), { id }] }, include: { contact: true, channel: true, ...ChatConversationsService.TAGS } });
    if (!conversation) throw new NotFoundException('Conversa não encontrada');
    return conversation;
  }

  async get(actor: ChatActor, id: number, before?: number) {
    const conversation = await this.load(actor, id);
    const messages = await this.prisma.chat_Message.findMany({
      where: { conversationId: id, ...(before ? { id: { lt: before } } : {}) },
      orderBy: { id: 'desc' },
      take: PAGE,
    });
    const userIds = messages.map((m) => m.sentByUserId);
    const [customers, users] = await Promise.all([this.customers([conversation.contact.customerId]), this.users([...userIds, conversation.assignedUserId])]);
    const customer = conversation.contact.customerId ? customers.get(conversation.contact.customerId) ?? null : null;
    const { webhookTokenHash, termsAcceptedIp, settings, instanceName, ...channel } = conversation.channel as any;
    if (!conversation.contact.avatarUrl && conversation.channel.instanceName && conversation.channel.status === 'conectado' && !before) {
      // foto do perfil: busca uma vez, sem travar a tela
      void this.provider.profilePicture(conversation.channel.instanceName, conversation.contact.externalId).then((url) => url && this.prisma.chat_Contact.update({ where: { id: conversation.contact.id }, data: { avatarUrl: url } })).catch(() => undefined);
    }
    const instagram = conversation.channel.type === 'instagram';
    const links = await Promise.all(messages.map((m) => this.media.link(m.media as ChatMedia | null)));
    return {
      ...this.row({ ...conversation }, customers, users),
      channel: { id: channel.id, name: channel.name, color: channel.color, type: channel.type, status: channel.status, phone: channel.phone, sector: channel.sector, botMode: channel.botMode, defaultBotId: channel.defaultBotId },
      replyUntil: instagram ? await this.instagram.replyUntil(id) : null,
      /** bot no controle desta conversa (passar para bot / atende) */
      bot: conversation.botId ? await this.prisma.ai_Bot.findUnique({ where: { id: conversation.botId }, select: { id: true, name: true, persona: true, avatar: true } }) : null,
      /** rascunho do bot esperando alguém enviar, editar ou descartar */
      suggestion: before ? null : await this.bot.pending(id),
      /** como as mensagens desta pessoa saem assinadas neste número (null = sem assinatura) */
      signature: await signerOf(this.prisma, conversation.channel, { userId: actor.userId }),
      messages: messages.map((m, i) => {
        const { key, sourceUrl, raw, ...media } = (m.media as ChatMedia | null) ?? {};
        return {
          id: m.id, direction: m.direction, type: m.type, text: m.text, media: m.media ? { ...media, url: links[i] } : null, status: m.status, error: m.error, origin: m.origin, sentAt: m.sentAt,
          sentBy: m.sentByUserId ? users.get(m.sentByUserId)?.name ?? null : m.sentByBotId ? 'Bot' : m.origin === 'phone' ? (instagram ? 'Pelo app do Instagram' : 'Pelo celular') : null,
        };
      }).reverse(),
      hasMore: messages.length === PAGE,
    };
  }

  private assertReply(actor: ChatActor) {
    if (!actor.permissions.includes('responder_conversas')) throw new ForbiddenException('Você não tem permissão para responder clientes.');
  }

  async sendText(actor: ChatActor, id: number, body: { text?: unknown; confirmedNew?: unknown; suggestionId?: unknown }) {
    this.assertReply(actor);
    const conversation = await this.load(actor, id);
    let messageId: number;
    if (conversation.channel.type === 'instagram') {
      this.assertInstagram(conversation.channel);
      const sent = await this.instagram.sendText(actor, conversation.contact.externalId, String(body.text ?? ''), conversation.channel);
      messageId = sent!.id;
    } else {
      messageId = (await this.send.enqueue({ channel: conversation.channel, conversationId: id, contact: conversation.contact, text: String(body.text ?? ''), userId: actor.userId, confirmedNew: body.confirmedNew === true })).id;
    }
    await this.bot.used(actor, id, body.suggestionId, String(body.text ?? ''));
    await this.bot.onHumanReply(id, actor.userId);
    await this.claim(actor, conversation);
    return this.prisma.chat_Message.findUnique({ where: { id: messageId } });
  }

  private assertInstagram(channel: { status: string }) {
    if (channel.status !== 'conectado') throw new BadRequestException('A conta do Instagram está desconectada. Conecte de novo em Bots → Conectores.');
  }

  /** Quem responde uma conversa sem dono passa a ser o dono. */
  private async claim(actor: ChatActor, conversation: { id: number; companyId: number; channelId: number; assignedUserId: number | null }) {
    if (conversation.assignedUserId) return;
    await this.prisma.chat_Conversation.update({ where: { id: conversation.id }, data: { assignedUserId: actor.userId, status: 'aberta' } });
    this.changed({ ...conversation, assignedUserId: actor.userId });
  }

  /** Foto, vídeo, documento ou áudio (gravado na hora = `ptt`). */
  async sendMedia(actor: ChatActor, id: number, file: { buffer: Buffer; mimetype: string; originalname?: string; size: number } | undefined, body: { caption?: unknown; ptt?: unknown; confirmedNew?: unknown }) {
    this.assertReply(actor);
    const conversation = await this.load(actor, id);
    const instagram = conversation.channel.type === 'instagram';
    if (instagram) this.assertInstagram(conversation.channel);
    const ptt = body.ptt === true || body.ptt === 'true';
    const { type, media } = await this.media.upload(actor.companyId, id, file, ptt);
    const caption = String(body.caption ?? '').trim();
    let messageId: number;
    if (instagram) {
      const sent = await this.instagram.sendMedia(actor, conversation.contact.externalId, type, media);
      messageId = sent!.id;
      if (caption) await this.instagram.sendText(actor, conversation.contact.externalId, caption, conversation.channel);
    } else {
      messageId = (await this.send.enqueue({ channel: conversation.channel, conversationId: id, contact: conversation.contact, text: type === 'audio' ? '' : caption, type, media, userId: actor.userId, confirmedNew: body.confirmedNew === true || body.confirmedNew === 'true' })).id;
    }
    await this.bot.onHumanReply(id, actor.userId);
    await this.claim(actor, conversation);
    return this.prisma.chat_Message.findUnique({ where: { id: messageId } });
  }

  async note(actor: ChatActor, id: number, body: { text?: unknown }) {
    const conversation = await this.load(actor, id);
    const text = String(body.text ?? '').trim();
    if (!text) throw new BadRequestException('Escreva a nota.');
    const note = await this.prisma.chat_Message.create({ data: { companyId: actor.companyId, channelId: conversation.channelId, conversationId: id, direction: 'note', type: 'text', text: text.slice(0, 4000), status: 'sent', origin: 'system', sentByUserId: actor.userId } });
    this.changed(conversation, 'message');
    return note;
  }

  async retry(actor: ChatActor, id: number, messageId: number) {
    this.assertReply(actor);
    await this.load(actor, id);
    const message = await this.prisma.chat_Message.findFirst({ where: { id: messageId, conversationId: id } });
    if (!message) throw new NotFoundException('Mensagem não encontrada');
    return this.send.retry(message);
  }

  /** Baixar de novo a mídia que falhou. */
  async retryMedia(actor: ChatActor, id: number, messageId: number) {
    const conversation = await this.load(actor, id);
    const message = await this.prisma.chat_Message.findFirst({ where: { id: messageId, conversationId: id } });
    if (!message) throw new NotFoundException('Mensagem não encontrada');
    await this.media.retry(message, conversation.channel.type);
    return { ok: true };
  }

  async read(actor: ChatActor, id: number) {
    const conversation = await this.load(actor, id);
    if (!conversation.unread) return { ok: true };
    await this.prisma.chat_Conversation.update({ where: { id }, data: { unread: 0 } });
    this.changed(conversation);
    if (conversation.channel.type === 'instagram') {
      void this.instagram.markRead(actor.companyId, conversation.contact.externalId);
      return { ok: true };
    }
    if (conversation.channel.instanceName && conversation.channel.status === 'conectado') {
      const unread = await this.prisma.chat_Message.findMany({ where: { conversationId: id, direction: 'in' }, orderBy: { id: 'desc' }, take: Math.min(conversation.unread, 20), select: { externalId: true } });
      void this.provider.markRead(conversation.channel.instanceName, conversation.contact.externalId, unread.map((m) => m.externalId!).filter(Boolean));
    }
    return { ok: true };
  }

  /** Assumir, soltar, transferir de setor, resolver e reabrir. */
  async update(actor: ChatActor, id: number, body: Record<string, unknown>) {
    const conversation = await this.load(actor, id);
    const data: Prisma.Chat_ConversationUpdateInput = {};
    const notes: string[] = [];
    if (body.status !== undefined) {
      if (!['aberta', 'aguardando', 'resolvida'].includes(String(body.status))) throw new BadRequestException('Situação inválida');
      data.status = String(body.status);
      data.resolvedAt = body.status === 'resolvida' ? new Date() : null;
      if (body.status === 'resolvida') data.unread = 0;
      if (body.status !== conversation.status) notes.push(body.status === 'resolvida' ? 'Conversa resolvida' : body.status === 'aberta' ? 'Conversa reaberta' : 'Aguardando o cliente');
    }
    if (body.assignedUserId !== undefined) {
      const userId = body.assignedUserId === 'me' ? actor.userId : body.assignedUserId ? Number(body.assignedUserId) : null;
      if (userId && userId !== actor.userId && !actor.permissions.includes('todas_conversas') && !actor.permissions.includes('canais_conversas')) {
        const member = await this.prisma.chat_ChannelMember.findFirst({ where: { channelId: conversation.channelId, userId } });
        if (!member) throw new BadRequestException('Essa pessoa não está na equipe deste número.');
      }
      if (userId) {
        const user = await this.prisma.user.findFirst({ where: { id: userId, companyId: actor.companyId }, select: { name: true } });
        if (!user) throw new BadRequestException('Usuário não encontrado');
        if (userId !== conversation.assignedUserId) notes.push(userId === actor.userId ? 'Assumiu a conversa' : `Passou a conversa para ${user.name}`);
      } else if (conversation.assignedUserId) notes.push('Soltou a conversa (sem dono)');
      data.assignedUserId = userId;
    }
    if (body.sector !== undefined) {
      const sector = body.sector ? String(body.sector) : null;
      const found = SECTORS.find((s) => s.id === sector);
      if (sector && !found) throw new BadRequestException('Setor inválido');
      if (sector !== conversation.sector) notes.push(`Transferida para o setor ${found?.name ?? 'nenhum'}`);
      data.sector = sector;
    }
    const saved = await this.prisma.chat_Conversation.update({ where: { id }, data });
    this.changed(saved);
    if (conversation.assignedUserId && conversation.assignedUserId !== saved.assignedUserId) this.changed(conversation);
    for (const text of notes) {
      await this.prisma.chat_Message.create({ data: { companyId: actor.companyId, channelId: conversation.channelId, conversationId: id, direction: 'note', type: 'event', text, status: 'sent', origin: 'system', sentByUserId: actor.userId } });
    }
    return this.get(actor, id);
  }

  /** Ficha do contato: vincular/desvincular cliente, nome e "não quer receber". */
  async updateContact(actor: ChatActor, id: number, body: { customerId?: unknown; name?: unknown; optOut?: unknown }) {
    if (!['responder_conversas', 'canais_conversas'].some((p) => actor.permissions.includes(p))) throw new ForbiddenException('Você não tem permissão para alterar o contato.');
    const conversation = await this.load(actor, id);
    const contact = conversation.contact;
    const data: Prisma.Chat_ContactUpdateInput = {};
    const notes: string[] = [];
    if (body.customerId !== undefined) {
      if (body.customerId) {
        const customer = await this.customerCards.assertCustomer(actor.companyId, Number(body.customerId));
        if (customer.id !== contact.customerId) notes.push(`Vinculado ao cliente ${customer.name}`);
        data.customerId = customer.id;
      } else if (contact.customerId) {
        notes.push('Cliente desvinculado');
        data.customerId = null;
      }
    }
    if (body.name !== undefined) {
      const name = String(body.name ?? '').trim().slice(0, 160);
      data.name = name || null;
    }
    if (body.optOut !== undefined) {
      const optOut = body.optOut === true;
      if (optOut !== contact.optOut) {
        data.optOut = optOut;
        data.optOutAt = optOut ? new Date() : null;
        notes.push(optOut ? 'Marcado como "não quer receber mensagens": os envios foram travados' : 'Voltou a receber mensagens');
      }
    }
    await this.prisma.chat_Contact.update({ where: { id: contact.id }, data });
    // trocou de cliente: a negociação ligada era do anterior
    if (data.customerId !== undefined && data.customerId !== contact.customerId && conversation.dealId) {
      await this.prisma.chat_Conversation.update({ where: { id }, data: { dealId: null } });
    }
    for (const text of notes) {
      await this.prisma.chat_Message.create({ data: { companyId: actor.companyId, channelId: conversation.channelId, conversationId: id, direction: 'note', type: 'event', text, status: 'sent', origin: 'system', sentByUserId: actor.userId } });
    }
    this.changed(conversation);
    return this.get(actor, id);
  }

  /** Etiquetas da conversa. */
  async setTags(actor: ChatActor, id: number, tagIds: unknown) {
    const conversation = await this.load(actor, id);
    await this.library.setConversationTags(actor, conversation, tagIds);
    return this.get(actor, id);
  }

  /** Resumo do cliente vinculado à conversa. */
  async customerSummary(actor: ChatActor, id: number) {
    const conversation = await this.load(actor, id);
    if (!conversation.contact.customerId) return { customer: null };
    return this.customerCards.summary(actor, conversation.contact.customerId);
  }

  /** Ocultar do sistema: apaga a conversa e deixa de gravar esse contato. */
  async hide(actor: ChatActor, id: number) {
    if (!['responder_conversas', 'canais_conversas'].some((p) => actor.permissions.includes(p))) throw new ForbiddenException('Você não tem permissão para ocultar contatos.');
    const conversation = await this.load(actor, id);
    await this.channels.hideContact(conversation.contactId, actor.userId);
    return { ok: true };
  }

  /** Nova conversa com um número (conta no limite de contatos novos). */
  async start(actor: ChatActor, body: { channelId?: unknown; phone?: unknown; name?: unknown; text?: unknown; confirmedNew?: unknown }) {
    this.assertReply(actor);
    const channel = await this.prisma.chat_Channel.findFirst({
      where: { id: Number(body.channelId), companyId: actor.companyId, active: true, ...(this.seesAll(actor) ? {} : { members: { some: { userId: actor.userId } } }) },
    });
    if (!channel) throw new NotFoundException('Número não encontrado');
    if (channel.type !== 'whatsapp') throw new BadRequestException('No Instagram só dá para responder quem escreveu primeiro.');
    const phone = phoneDigits(String(body.phone ?? ''));
    if (phone.length < 12 || phone.length > 13) throw new BadRequestException('Digite o celular com DDD (ex.: 11 91234-5678).');
    if (await this.inbound.hidden(channel.id, { jid: `${phone}@s.whatsapp.net`, phone })) throw new BadRequestException('Este número está oculto do sistema. Para conversar por aqui, mostre de novo em Números → Configurar.');
    const { contact, conversation } = await this.inbound.contactAndConversation(channel, { jid: `${phone}@s.whatsapp.net`, phone });
    if (body.name && !contact.name) await this.prisma.chat_Contact.update({ where: { id: contact.id }, data: { name: String(body.name).slice(0, 160) } });
    if (body.text) {
      await this.send.enqueue({ channel, conversationId: conversation.id, contact, text: String(body.text), userId: actor.userId, confirmedNew: body.confirmedNew === true });
    }
    await this.prisma.chat_Conversation.update({ where: { id: conversation.id }, data: { assignedUserId: conversation.assignedUserId ?? actor.userId, status: 'aberta' } });
    this.changed({ ...conversation, assignedUserId: conversation.assignedUserId ?? actor.userId });
    return { id: conversation.id };
  }

  async unread(actor: ChatActor) {
    const result = await this.prisma.chat_Conversation.aggregate({ where: { AND: [this.scope(actor), { status: { not: 'resolvida' } }, { unread: { gt: 0 } }] }, _count: true });
    return { conversations: result._count };
  }
}
