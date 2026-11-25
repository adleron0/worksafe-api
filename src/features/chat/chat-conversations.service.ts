import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { EvolutionProvider } from './providers/evolution.provider';
import { ChatActor } from './chat-channels.service';
import { ChatInboundService } from './chat-inbound.service';
import { ChatSendService } from './chat-send.service';
import { SECTORS, phoneDigits } from './chat.settings';

const PAGE = 60;

/** Caixa de entrada: lista, conversa, envio e ações simples (assumir, resolver). */
@Injectable()
export class ChatConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly send: ChatSendService,
    private readonly inbound: ChatInboundService,
    private readonly provider: EvolutionProvider,
  ) {}

  private seesAll(actor: ChatActor) {
    return actor.permissions.includes('todas_conversas');
  }

  /** Quem não vê tudo enxerga as conversas dos números em que está na equipe e as atribuídas a ele. */
  private scope(actor: ChatActor): Prisma.Chat_ConversationWhereInput {
    const base: Prisma.Chat_ConversationWhereInput = { companyId: actor.companyId, channel: { active: true } };
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
      include: { contact: true, channel: { select: { id: true, name: true, color: true, type: true } } },
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
      contact: { id: r.contact.id, name: r.contact.name || customer?.name || r.contact.pushName || null, pushName: r.contact.pushName, phone: r.contact.phone, avatarUrl: r.contact.avatarUrl, optOut: r.contact.optOut, isNew: !r.contact.firstInboundAt },
      customer,
      assignedUser: r.assignedUserId ? users.get(r.assignedUserId) ?? { id: r.assignedUserId, name: 'Usuário', imageUrl: null } : null,
    };
  }

  private async load(actor: ChatActor, id: number) {
    const conversation = await this.prisma.chat_Conversation.findFirst({ where: { AND: [this.scope(actor), { id }] }, include: { contact: true, channel: true } });
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
    return {
      ...this.row({ ...conversation }, customers, users),
      channel: { id: channel.id, name: channel.name, color: channel.color, type: channel.type, status: channel.status, phone: channel.phone, sector: channel.sector, botMode: channel.botMode },
      messages: messages.reverse().map((m) => ({
        id: m.id, direction: m.direction, type: m.type, text: m.text, media: m.media, status: m.status, error: m.error, origin: m.origin, sentAt: m.sentAt,
        sentBy: m.sentByUserId ? users.get(m.sentByUserId)?.name ?? null : m.origin === 'phone' ? 'Pelo celular' : null,
      })),
      hasMore: messages.length === PAGE,
    };
  }

  private assertReply(actor: ChatActor) {
    if (!actor.permissions.includes('responder_conversas')) throw new ForbiddenException('Você não tem permissão para responder clientes.');
  }

  async sendText(actor: ChatActor, id: number, body: { text?: unknown; confirmedNew?: unknown }) {
    this.assertReply(actor);
    const conversation = await this.load(actor, id);
    const message = await this.send.enqueue({ channel: conversation.channel, conversationId: id, contact: conversation.contact, text: String(body.text ?? ''), userId: actor.userId, confirmedNew: body.confirmedNew === true });
    // quem responde uma conversa sem dono passa a ser o dono
    if (!conversation.assignedUserId) await this.prisma.chat_Conversation.update({ where: { id }, data: { assignedUserId: actor.userId, status: 'aberta' } });
    return this.prisma.chat_Message.findUnique({ where: { id: message.id } });
  }

  async note(actor: ChatActor, id: number, body: { text?: unknown }) {
    const conversation = await this.load(actor, id);
    const text = String(body.text ?? '').trim();
    if (!text) throw new BadRequestException('Escreva a nota.');
    return this.prisma.chat_Message.create({ data: { companyId: actor.companyId, channelId: conversation.channelId, conversationId: id, direction: 'note', type: 'text', text: text.slice(0, 4000), status: 'sent', origin: 'system', sentByUserId: actor.userId } });
  }

  async retry(actor: ChatActor, id: number, messageId: number) {
    this.assertReply(actor);
    await this.load(actor, id);
    const message = await this.prisma.chat_Message.findFirst({ where: { id: messageId, conversationId: id } });
    if (!message) throw new NotFoundException('Mensagem não encontrada');
    return this.send.retry(message);
  }

  async read(actor: ChatActor, id: number) {
    const conversation = await this.load(actor, id);
    if (!conversation.unread) return { ok: true };
    await this.prisma.chat_Conversation.update({ where: { id }, data: { unread: 0 } });
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
    await this.prisma.chat_Conversation.update({ where: { id }, data });
    for (const text of notes) {
      await this.prisma.chat_Message.create({ data: { companyId: actor.companyId, channelId: conversation.channelId, conversationId: id, direction: 'note', type: 'event', text, status: 'sent', origin: 'system', sentByUserId: actor.userId } });
    }
    return this.get(actor, id);
  }

  /** Nova conversa com um número (conta no limite de contatos novos). */
  async start(actor: ChatActor, body: { channelId?: unknown; phone?: unknown; name?: unknown; text?: unknown; confirmedNew?: unknown }) {
    this.assertReply(actor);
    const channel = await this.prisma.chat_Channel.findFirst({
      where: { id: Number(body.channelId), companyId: actor.companyId, active: true, ...(this.seesAll(actor) ? {} : { members: { some: { userId: actor.userId } } }) },
    });
    if (!channel) throw new NotFoundException('Número não encontrado');
    const phone = phoneDigits(String(body.phone ?? ''));
    if (phone.length < 12 || phone.length > 13) throw new BadRequestException('Digite o celular com DDD (ex.: 11 91234-5678).');
    const { contact, conversation } = await this.inbound.contactAndConversation(channel, { jid: `${phone}@s.whatsapp.net`, phone });
    if (body.name && !contact.name) await this.prisma.chat_Contact.update({ where: { id: contact.id }, data: { name: String(body.name).slice(0, 160) } });
    if (body.text) {
      await this.send.enqueue({ channel, conversationId: conversation.id, contact, text: String(body.text), userId: actor.userId, confirmedNew: body.confirmedNew === true });
    }
    await this.prisma.chat_Conversation.update({ where: { id: conversation.id }, data: { assignedUserId: conversation.assignedUserId ?? actor.userId, status: 'aberta' } });
    return { id: conversation.id };
  }

  async unread(actor: ChatActor) {
    const result = await this.prisma.chat_Conversation.aggregate({ where: { AND: [this.scope(actor), { status: { not: 'resolvida' } }, { unread: { gt: 0 } }] }, _count: true });
    return { conversations: result._count };
  }
}
