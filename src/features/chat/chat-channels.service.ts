import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { EvolutionProvider, ProviderError } from './providers/evolution.provider';
import { ChatEventsService } from './chat-events.service';
import { ChatInstagramService } from './chat-instagram.service';
import { ChatMedia, ChatMediaService } from './chat-media.service';
import { TAG_COLORS } from './chat-library.service';
import { Prisma } from '@prisma/client';
import { BOT_MODES, phoneDigits, SECTORS, TERMS, TERMS_VERSION, normalizeSettings, spDayStart } from './chat.settings';

export interface ChatActor { userId: number; companyId: number; permissions: string[] }

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const COLORS = ['#149E5E', '#3E6F98', '#F0C419', '#E52127', '#78716C'];

/** Canais = números de WhatsApp conectados (cada um com setor, bot, equipe e limites). */
@Injectable()
export class ChatChannelsService {
  private readonly logger = new Logger(ChatChannelsService.name);
  /** Último QR recebido pelo webhook (o Evolution troca a cada ~40 s). */
  private readonly qrCache = new Map<number, { qr: string; at: number }>();

  constructor(private readonly prisma: PrismaService, private readonly provider: EvolutionProvider, private readonly events: ChatEventsService, private readonly instagram: ChatInstagramService, private readonly media: ChatMediaService) {}

  webhookUrl(channelId: number): string {
    const base = (process.env.CHAT_WEBHOOK_BASE || process.env.WEBHOOK_URL || 'https://api.worksafebrasil.com.br').replace(/\/+$/, '');
    return `${base}/chat/webhook/evolution/${channelId}`;
  }

  async meta(companyId: number) {
    const [bots, users] = await Promise.all([
      this.prisma.ai_Bot.findMany({ where: { companyId, active: true } as any, select: { id: true, name: true, persona: true, role: true, avatar: true, key: true }, orderBy: { name: 'asc' } }).catch(() => []),
      this.prisma.user.findMany({ where: { companyId, active: true } as any, select: { id: true, name: true, imageUrl: true } as any, orderBy: { name: 'asc' } }).catch(() => []),
    ]);
    return { sectors: SECTORS, botModes: BOT_MODES, terms: TERMS, defaults: normalizeSettings({}), bots, users, serverReady: this.provider.ready(), tagColors: TAG_COLORS };
  }

  private async load(companyId: number, id: number) {
    const channel = await this.prisma.chat_Channel.findFirst({ where: { id, companyId, active: true }, include: { members: { select: { userId: true } } } });
    if (!channel) throw new NotFoundException('Número não encontrado');
    return channel;
  }

  private view(channel: Awaited<ReturnType<ChatChannelsService['load']>>, stats?: { sentToday: number; newToday: number; open: number; unread: number }) {
    const { webhookTokenHash, termsAcceptedIp, members, settings, ...rest } = channel as any;
    return { ...rest, settings: normalizeSettings(settings), memberIds: (members ?? []).map((m: { userId: number }) => m.userId), termsOk: channel.termsVersion === TERMS_VERSION, stats };
  }

  private async stats(channelIds: number[]) {
    if (!channelIds.length) return new Map<number, { sentToday: number; newToday: number; open: number; unread: number }>();
    const day = spDayStart();
    const [sent, open] = await Promise.all([
      this.prisma.chat_Message.groupBy({ by: ['channelId'], where: { channelId: { in: channelIds }, direction: 'out', status: { in: ['sent', 'delivered', 'read'] }, sentAt: { gte: day } }, _count: true }),
      this.prisma.chat_Conversation.groupBy({ by: ['channelId'], where: { channelId: { in: channelIds }, status: { not: 'resolvida' } }, _count: true, _sum: { unread: true } }),
    ]);
    const fresh = await this.prisma.$queryRaw<{ channelId: number; n: bigint }[]>`
      SELECT c."channelId", COUNT(*)::bigint AS n FROM "Chat_Contact" c
      WHERE c."channelId" = ANY(${channelIds}) AND c."firstInboundAt" IS NULL
        AND EXISTS (SELECT 1 FROM "Chat_Message" m JOIN "Chat_Conversation" v ON v.id = m."conversationId"
                    WHERE v."contactId" = c.id AND m.direction = 'out' AND m.status <> 'failed' AND m."sentAt" >= ${day})
      GROUP BY c."channelId"`;
    const map = new Map<number, { sentToday: number; newToday: number; open: number; unread: number }>();
    for (const id of channelIds) map.set(id, { sentToday: 0, newToday: 0, open: 0, unread: 0 });
    for (const row of sent) map.get(row.channelId)!.sentToday = row._count;
    for (const row of open) Object.assign(map.get(row.channelId)!, { open: row._count, unread: row._sum.unread ?? 0 });
    for (const row of fresh) map.get(row.channelId)!.newToday = Number(row.n);
    return map;
  }

  async list(actor: ChatActor) {
    // a conta do Instagram conectada em Bots → Conectores vira um canal sozinha
    await this.instagram.ensureChannel(actor.companyId).catch((error) => this.logger.warn(`Canal do Instagram: ${error?.message}`));
    const all = actor.permissions.includes('todas_conversas') || actor.permissions.includes('canais_conversas');
    const channels = await this.prisma.chat_Channel.findMany({
      where: { companyId: actor.companyId, active: true, ...(all ? {} : { members: { some: { userId: actor.userId } } }) },
      include: { members: { select: { userId: true } } },
      orderBy: { id: 'asc' },
    });
    const stats = await this.stats(channels.map((c) => c.id));
    return channels.map((c) => this.view(c, stats.get(c.id)));
  }

  async get(actor: ChatActor, id: number) {
    const channel = await this.load(actor.companyId, id);
    const stats = await this.stats([id]);
    return this.view(channel, stats.get(id));
  }

  private clean(body: Record<string, unknown>, partial: boolean) {
    const data: Record<string, unknown> = {};
    if (!partial || body.name !== undefined) {
      const name = String(body.name ?? '').trim();
      if (!name) throw new BadRequestException('Dê um nome para o número (ex.: WhatsApp Serviços).');
      data.name = name.slice(0, 120);
    }
    if (body.sector !== undefined) {
      const sector = body.sector ? String(body.sector) : null;
      if (sector && !SECTORS.some((s) => s.id === sector)) throw new BadRequestException('Setor inválido');
      data.sector = sector;
    }
    if (body.botMode !== undefined) {
      if (!BOT_MODES.some((m) => m.id === body.botMode)) throw new BadRequestException('Modo do bot inválido');
      data.botMode = body.botMode;
    }
    if (body.defaultBotId !== undefined) data.defaultBotId = body.defaultBotId ? Number(body.defaultBotId) : null;
    if (body.color !== undefined) data.color = /^#[0-9a-f]{6}$/i.test(String(body.color)) ? String(body.color) : null;
    if (body.settings !== undefined) data.settings = normalizeSettings(body.settings) as any;
    if (body.historyDays !== undefined) data.historyDays = Math.min(90, Math.max(0, Math.round(Number(body.historyDays) || 0)));
    return data;
  }

  private async saveMembers(companyId: number, channelId: number, memberIds: unknown) {
    if (!Array.isArray(memberIds)) return;
    const ids = [...new Set(memberIds.map(Number).filter((n) => n > 0))];
    const valid = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids }, companyId }, select: { id: true } }) : [];
    await this.prisma.chat_ChannelMember.deleteMany({ where: { channelId } });
    if (valid.length) await this.prisma.chat_ChannelMember.createMany({ data: valid.map((u) => ({ channelId, userId: u.id })) });
  }

  private async assertBot(companyId: number, botId: unknown) {
    if (!botId) return;
    const bot = await this.prisma.ai_Bot.findFirst({ where: { id: Number(botId), companyId } });
    if (!bot) throw new BadRequestException('Bot não encontrado');
  }

  async create(actor: ChatActor, body: Record<string, unknown>) {
    const data = this.clean(body, false);
    await this.assertBot(actor.companyId, data.defaultBotId);
    const count = await this.prisma.chat_Channel.count({ where: { companyId: actor.companyId } });
    const channel = await this.prisma.chat_Channel.create({
      data: { companyId: actor.companyId, type: 'whatsapp', provider: 'evolution', color: COLORS[count % COLORS.length], settings: normalizeSettings({}) as any, ...data } as any,
    });
    await this.saveMembers(actor.companyId, channel.id, body.memberIds ?? [actor.userId]);
    return this.get(actor, channel.id);
  }

  async update(actor: ChatActor, id: number, body: Record<string, unknown>) {
    await this.load(actor.companyId, id);
    const data = this.clean(body, true);
    await this.assertBot(actor.companyId, data.defaultBotId);
    await this.prisma.chat_Channel.update({ where: { id }, data: data as any });
    if (body.memberIds !== undefined) await this.saveMembers(actor.companyId, id, body.memberIds);
    return this.get(actor, id);
  }

  async remove(actor: ChatActor, id: number) {
    const channel = await this.load(actor.companyId, id);
    if (channel.instanceName && this.provider.ready()) await this.provider.remove(channel.instanceName);
    await this.prisma.chat_Channel.update({ where: { id }, data: { active: false, status: 'desconectado', instanceName: null, webhookTokenHash: null } });
    return { ok: true };
  }

  // ---------------------------------------------------------------- conexão

  /**
   * Aceita o termo (se ainda não aceito nesta versão), cria a conexão no
   * Evolution se preciso e devolve o QR code ou, com `phone`, o código de
   * pareamento.
   */
  private notInstagram(channel: { type: string }) {
    if (channel.type === 'instagram') throw new BadRequestException('A conta do Instagram se conecta e desconecta em Bots → Conectores.');
  }

  async connect(actor: ChatActor, id: number, body: { acceptTerms?: unknown; phone?: unknown }, ip: string | null) {
    const channel = await this.load(actor.companyId, id);
    this.notInstagram(channel);
    if (channel.termsVersion !== TERMS_VERSION) {
      if (body.acceptTerms !== true) throw new BadRequestException('Para conectar, aceite o termo de uso do WhatsApp não oficial.');
      await this.prisma.chat_Channel.update({ where: { id }, data: { termsVersion: TERMS_VERSION, termsAcceptedAt: new Date(), termsAcceptedByUserId: actor.userId, termsAcceptedIp: ip?.slice(0, 64) ?? null } });
    }
    if (channel.status === 'conectado') return this.qr(actor, id);

    let instanceName = channel.instanceName;
    const secret = randomBytes(24).toString('hex');
    const webhook = { url: this.webhookUrl(id), secret };
    try {
      if (!instanceName || !(await this.provider.exists(instanceName))) {
        instanceName = `ws-${actor.companyId}-${id}-${randomBytes(3).toString('hex')}`;
        await this.provider.createInstance(instanceName, webhook);
      } else {
        await this.provider.setWebhook(instanceName, webhook);
      }
      await this.prisma.chat_Channel.update({ where: { id }, data: { instanceName, webhookTokenHash: sha(secret), status: 'aguardando', statusReason: null, statusAt: new Date() } });
      const phone = body.phone ? String(body.phone).replace(/\D/g, '') : '';
      if (body.phone !== undefined && phone.length < 12) throw new BadRequestException('Digite o número com DDD e o 55 na frente (ex.: 55 11 91234-5678).');
      const result = await this.provider.connect(instanceName, phone || undefined);
      if (result.qr) this.qrCache.set(id, { qr: result.qr, at: Date.now() });
      if (result.state === 'open') return this.markConnected(id);
      return { status: 'aguardando', qr: result.qr, pairingCode: result.pairingCode };
    } catch (error) {
      if (error instanceof ProviderError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /** A tela pergunta a cada 2 s: conectou? Qual o QR atual? */
  async qr(actor: ChatActor, id: number) {
    const channel = await this.load(actor.companyId, id);
    this.notInstagram(channel);
    if (channel.status === 'conectado') return { status: 'conectado', phone: channel.phone, profileName: channel.profileName, qr: null };
    if (!channel.instanceName) return { status: channel.status, qr: null };
    const state = await this.provider.state(channel.instanceName).catch(() => 'close' as const);
    if (state === 'open') return this.markConnected(id);
    const cached = this.qrCache.get(id);
    return { status: channel.status, qr: cached && Date.now() - cached.at < 60000 ? cached.qr : null, reason: channel.statusReason };
  }

  rememberQr(channelId: number, qr: string) {
    this.qrCache.set(channelId, { qr, at: Date.now() });
  }

  async markConnected(id: number, info: { phone?: string | null; profileName?: string | null } = {}) {
    this.qrCache.delete(id);
    const channel = await this.prisma.chat_Channel.update({
      where: { id },
      data: { status: 'conectado', statusReason: null, statusAt: new Date(), connectedAt: new Date(), ...(info.phone ? { phone: info.phone } : {}), ...(info.profileName ? { profileName: info.profileName } : {}) },
    });
    this.events.emit({ companyId: channel.companyId, kind: 'channel', channelId: id });
    return { status: 'conectado', phone: channel.phone, profileName: channel.profileName, qr: null };
  }

  async markDown(id: number, status: 'caiu' | 'banido' | 'desconectado', reason: string) {
    const channel = await this.prisma.chat_Channel.update({ where: { id }, data: { status, statusReason: reason, statusAt: new Date() } });
    this.events.emit({ companyId: channel.companyId, kind: 'channel', channelId: id });
    if (status === 'banido') {
      await this.prisma.chat_Message.updateMany({ where: { channelId: id, status: 'queued' }, data: { status: 'failed', error: 'Número bloqueado pelo WhatsApp: envios pausados.' } });
    }
  }

  async disconnect(actor: ChatActor, id: number) {
    const channel = await this.load(actor.companyId, id);
    this.notInstagram(channel);
    if (channel.instanceName && this.provider.ready()) await this.provider.logout(channel.instanceName);
    await this.prisma.chat_Channel.update({ where: { id }, data: { status: 'desconectado', statusReason: 'Desconectado pelo sistema', statusAt: new Date() } });
    return { ok: true };
  }

  // ---------------------------------------------------------------- contatos ocultos

  /**
   * Oculta um contato (assunto pessoal): apaga a conversa, as mensagens e os
   * arquivos dele do sistema e, daqui para frente, nada dele é gravado.
   */
  async hideContact(contactId: number, userId: number) {
    const contact = await this.prisma.chat_Contact.update({ where: { id: contactId }, data: { hidden: true, hiddenAt: new Date(), hiddenByUserId: userId, customerId: null } });
    const conversations = await this.prisma.chat_Conversation.findMany({ where: { contactId }, select: { id: true } });
    const ids = conversations.map((c) => c.id);
    if (ids.length) {
      const files = await this.prisma.chat_Message.findMany({ where: { conversationId: { in: ids }, media: { not: Prisma.DbNull } }, select: { media: true } });
      await this.prisma.chat_Message.deleteMany({ where: { conversationId: { in: ids } } });
      await this.prisma.chat_Conversation.deleteMany({ where: { id: { in: ids } } });
      await this.media.remove(files.map((f) => (f.media as ChatMedia | null)?.key).filter((k): k is string => !!k));
    }
    this.events.emit({ companyId: contact.companyId, kind: 'conversation', channelId: contact.channelId, conversationId: ids[0] ?? null });
    return contact;
  }

  async hiddenList(actor: ChatActor, id: number) {
    await this.load(actor.companyId, id);
    const rows = await this.prisma.chat_Contact.findMany({ where: { channelId: id, hidden: true }, orderBy: { hiddenAt: 'desc' }, select: { id: true, name: true, pushName: true, phone: true, externalId: true, hiddenAt: true } });
    return rows;
  }

  /** Oculta pelo número, antes mesmo de a pessoa escrever. */
  async hidePhone(actor: ChatActor, id: number, body: { phone?: unknown; name?: unknown }) {
    const channel = await this.load(actor.companyId, id);
    if (channel.type !== 'whatsapp') throw new BadRequestException('No Instagram, oculte pela própria conversa.');
    const phone = phoneDigits(String(body.phone ?? ''));
    if (phone.length < 12 || phone.length > 13) throw new BadRequestException('Digite o celular com DDD (ex.: 11 91234-5678).');
    const jid = `${phone}@s.whatsapp.net`;
    const found = await this.prisma.chat_Contact.findMany({ where: { channelId: id, OR: [{ externalId: jid }, { phone }] } });
    if (!found.some((c) => c.externalId === jid)) {
      found.push(await this.prisma.chat_Contact.create({ data: { companyId: actor.companyId, channelId: id, externalId: jid, phone, name: body.name ? String(body.name).slice(0, 160) : null } }));
    }
    for (const contact of found) await this.hideContact(contact.id, actor.userId);
    return this.hiddenList(actor, id);
  }

  /** Volta a aparecer (só o que chegar daqui para frente; o que foi apagado não volta). */
  async unhide(actor: ChatActor, id: number, contactId: number) {
    await this.load(actor.companyId, id);
    const done = await this.prisma.chat_Contact.updateMany({ where: { id: contactId, channelId: id, hidden: true }, data: { hidden: false, hiddenAt: null, hiddenByUserId: null } });
    if (!done.count) throw new NotFoundException('Contato oculto não encontrado');
    return this.hiddenList(actor, id);
  }

  /** Confere o segredo que o Evolution manda no cabeçalho do webhook. */
  async channelForWebhook(id: number, secret: unknown) {
    if (typeof secret !== 'string' || !secret) return null;
    const channel = await this.prisma.chat_Channel.findFirst({ where: { id, active: true } });
    if (!channel?.webhookTokenHash || channel.webhookTokenHash !== sha(secret)) return null;
    return channel;
  }
}
