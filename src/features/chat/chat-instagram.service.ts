import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Ai_SocialMessage, Chat_Channel, Prisma } from '@prisma/client';
import { InstagramMessagesService } from 'src/features/ai/connectors/instagram-messages.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatEventsService } from './chat-events.service';
import { previewOf } from './chat.settings';
import { ChatMedia, ChatMediaService } from './chat-media.service';
import { chatHooks } from './chat.hooks';
import { signText } from './chat.settings';
import { signerOf } from './chat-signature';

/**
 * Instagram Direct na caixa única.
 *
 * O Direct continua sendo gravado onde sempre foi (Ai_SocialMessage, que a
 * Nina e as ferramentas usam). Cada mensagem gravada lá é espelhada aqui como
 * conversa do canal "Instagram" da empresa, criado sozinho quando a conta
 * está conectada em Bots → Conectores. A resposta pela caixa passa pelas
 * mesmas regras do Instagram (janela de 24 h e limite do dia).
 */

export const IG_WINDOW_MS = 24 * 3600000;
const ATTACHMENT_TYPE: Record<string, string> = { image: 'image', video: 'video', audio: 'audio', file: 'document', share: 'other', story_mention: 'image', ig_reel: 'video', reel: 'video', animated_image: 'image', sticker: 'sticker' };

@Injectable()
export class ChatInstagramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatInstagramService.name);
  private readonly tasks = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instagram: InstagramMessagesService,
    private readonly media: ChatMediaService,
    private readonly events: ChatEventsService,
  ) {}

  onModuleInit() {
    chatHooks.instagramMessage = (row) => this.track(this.mirror(row));
  }

  onModuleDestroy() {
    chatHooks.instagramMessage = null;
  }

  /** Para os testes: espera os espelhos em andamento. */
  async idle() {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    await this.media.idle();
  }

  private track(work: Promise<unknown>) {
    const task = work.catch((error) => this.logger.warn(`Espelho do Direct: ${error?.message}`)).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  // ---------------------------------------------------------------- canal

  /**
   * Canal do Instagram da empresa: criado na primeira vez que a conta aparece
   * conectada (e o Direct que já existia é trazido). Removido pela tela, não volta.
   */
  async ensureChannel(companyId: number): Promise<Chat_Channel | null> {
    const connector = await this.prisma.ai_Connector.findUnique({ where: { companyId_provider: { companyId, provider: 'instagram' } } });
    const existing = await this.prisma.chat_Channel.findFirst({ where: { companyId, type: 'instagram' }, orderBy: { id: 'asc' } });
    if (!connector) {
      if (existing?.active && existing.status !== 'desconectado') {
        return this.prisma.chat_Channel.update({ where: { id: existing.id }, data: { status: 'desconectado', statusReason: 'A conta do Instagram foi desconectada em Bots → Conectores.', statusAt: new Date() } });
      }
      return existing?.active ? existing : null;
    }
    const status = connector.status === 'connected' ? 'conectado' : 'caiu';
    const reason = connector.status === 'connected' ? null : connector.lastError || 'A conexão com o Instagram expirou. Conecte de novo em Bots → Conectores.';
    if (existing) {
      if (!existing.active) return null;
      const owner = connector.connectedByUserId && existing.termsAcceptedByUserId !== connector.connectedByUserId ? { termsAcceptedByUserId: connector.connectedByUserId, termsAcceptedAt: new Date(), termsVersion: 'instagram' } : {};
      if (existing.status !== status || existing.phone !== connector.username || Object.keys(owner).length) {
        return this.prisma.chat_Channel.update({ where: { id: existing.id }, data: { status, statusReason: reason, statusAt: new Date(), phone: connector.username, profileName: connector.name ?? connector.username, ...owner } });
      }
      return existing;
    }
    const channel = await this.prisma.chat_Channel.create({
      data: {
        companyId, type: 'instagram', provider: 'meta', name: 'Instagram', color: '#E52127', status, statusReason: reason, statusAt: new Date(),
        connectedAt: new Date(), phone: connector.username, profileName: connector.name ?? connector.username, botMode: 'desligado', historyDays: 0,
        // o bot do canal age com as permissões de quem conectou a conta
        termsAcceptedByUserId: connector.connectedByUserId ?? null, termsAcceptedAt: connector.connectedByUserId ? new Date() : null, termsVersion: connector.connectedByUserId ? 'instagram' : null,
      },
    });
    if (connector.connectedByUserId) await this.prisma.chat_ChannelMember.create({ data: { channelId: channel.id, userId: connector.connectedByUserId } }).catch(() => undefined);
    await this.backfill(channel);
    return channel;
  }

  /** Traz o Direct que já estava gravado (até 2.000 mensagens dos últimos 30 dias). */
  private async backfill(channel: Chat_Channel) {
    const rows = await this.prisma.ai_SocialMessage.findMany({
      where: { companyId: channel.companyId, channel: 'direct', sentAt: { gte: new Date(Date.now() - 30 * 86400000) } },
      orderBy: { sentAt: 'asc' }, take: 2000,
    });
    for (const row of rows) await this.mirror(row, { channel, quiet: true });
  }

  // ---------------------------------------------------------------- espelho

  private kindOf(row: Ai_SocialMessage): { type: string; media: ChatMedia | null } {
    const list = Array.isArray(row.attachments) ? (row.attachments as { type?: string; url?: string | null }[]) : [];
    const first = list[0];
    if (!first) return { type: 'text', media: null };
    const type = ATTACHMENT_TYPE[String(first.type ?? '')] ?? 'document';
    if (type === 'other') return { type: row.text ? 'text' : 'other', media: null };
    return { type, media: { sourceUrl: first.url ?? null, state: first.url ? 'pending' : 'failed' } };
  }

  async mirror(row: Ai_SocialMessage, opts: { channel?: Chat_Channel; quiet?: boolean; media?: ChatMedia } = {}) {
    if (row.channel !== 'direct') return null;
    const externalId = `ig:${row.externalId}`;
    const known = await this.prisma.chat_Message.findUnique({ where: { externalId } });
    if (known) return known;
    const channel = opts.channel ?? (await this.ensureChannel(row.companyId));
    if (!channel || channel.type !== 'instagram' || !channel.active) return null;

    const igsid = row.conversationId;
    const inbound = row.direction === 'in';
    let contact = await this.prisma.chat_Contact.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: igsid } } });
    if (contact?.hidden) return null; // contato oculto: nada é gravado
    const username = inbound && row.fromUsername ? `@${row.fromUsername}` : null;
    if (!contact) {
      contact = await this.prisma.chat_Contact
        .create({ data: { companyId: row.companyId, channelId: channel.id, externalId: igsid, pushName: username, firstInboundAt: inbound ? row.sentAt : null } })
        .catch(async (error) => {
          if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') return this.prisma.chat_Contact.findUniqueOrThrow({ where: { channelId_externalId: { channelId: channel.id, externalId: igsid } } });
          throw error;
        });
    } else if ((username && username !== contact.pushName) || (inbound && !contact.firstInboundAt)) {
      contact = await this.prisma.chat_Contact.update({ where: { id: contact.id }, data: { ...(username ? { pushName: username } : {}), ...(inbound && !contact.firstInboundAt ? { firstInboundAt: row.sentAt } : {}) } });
    }
    let conversation = await this.prisma.chat_Conversation.findUnique({ where: { channelId_contactId: { channelId: channel.id, contactId: contact.id } } });
    if (!conversation) {
      conversation = await this.prisma.chat_Conversation
        .create({ data: { companyId: row.companyId, channelId: channel.id, contactId: contact.id, sector: channel.sector } })
        .catch(async (error) => {
          if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') return this.prisma.chat_Conversation.findUniqueOrThrow({ where: { channelId_contactId: { channelId: channel.id, contactId: contact!.id } } });
          throw error;
        });
    }

    const kind = this.kindOf(row);
    const media = opts.media ?? kind.media;
    const origin = inbound ? (row.origin === 'sync' ? 'history' : 'webhook') : row.repliedByBotId ? 'bot' : row.origin === 'system' ? 'system' : 'phone';
    let message;
    try {
      message = await this.prisma.chat_Message.create({
        data: {
          companyId: row.companyId, channelId: channel.id, conversationId: conversation.id, direction: inbound ? 'in' : 'out', type: kind.type,
          text: row.text ?? '', media: (media as any) ?? undefined, externalId, status: inbound ? 'received' : 'sent', origin,
          sentByUserId: row.repliedByUserId ?? null, sentByBotId: row.repliedByBotId ?? null, sentAt: row.sentAt,
        },
      });
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') return this.prisma.chat_Message.findUnique({ where: { externalId } });
      throw error;
    }

    const newer = !conversation.lastMessageAt || row.sentAt >= conversation.lastMessageAt;
    const unreadNow = inbound && !row.readAt && !opts.quiet;
    const unreadBackfill = inbound && !row.readAt && opts.quiet && Date.now() - row.sentAt.getTime() < 7 * 86400000;
    await this.prisma.chat_Conversation.update({
      where: { id: conversation.id },
      data: {
        ...(newer ? { lastMessageAt: row.sentAt, lastMessagePreview: previewOf(message.type, message.text), lastDirection: inbound ? 'in' : 'out' } : {}),
        ...(unreadNow || unreadBackfill ? { unread: { increment: 1 } } : {}),
        ...(!inbound && newer ? { unread: 0 } : {}),
        ...(inbound && !opts.quiet && conversation.status === 'resolvida' ? { status: 'aberta', resolvedAt: null } : {}),
      },
    });
    if (media?.state === 'pending' && media.sourceUrl) this.media.fetchUrl(message.id);
    if (!opts.quiet && origin === 'webhook') chatHooks.botInbound?.(conversation.id, message.id);
    if (!opts.quiet && !inbound && origin === 'phone') chatHooks.botHumanReply?.(conversation.id);
    if (!opts.quiet) {
      this.events.emit({
        companyId: row.companyId, kind: 'message', channelId: channel.id, conversationId: conversation.id, assignedUserId: conversation.assignedUserId,
        inbound, contactName: contact.name || contact.pushName, preview: previewOf(message.type, message.text),
      });
    }
    return message;
  }

  // ---------------------------------------------------------------- resposta

  /** Até quando dá para responder (24 h depois da última mensagem do cliente). */
  async replyUntil(conversationId: number): Promise<Date | null> {
    const last = await this.prisma.chat_Message.findFirst({ where: { conversationId, direction: 'in' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
    return last ? new Date(last.sentAt.getTime() + IG_WINDOW_MS) : null;
  }

  /** Resposta pela caixa: de uma pessoa ou do bot do canal (botId). */
  async sendText(actor: { companyId: number; userId: number; botId?: number | null }, igsid: string, text: string, channel?: { settings: unknown } | null) {
    const clean = String(text ?? '').trim();
    const signer = channel ? await signerOf(this.prisma, channel, { userId: actor.userId, botId: actor.botId }) : null;
    const sent = await this.instagram.reply({ companyId: actor.companyId, userId: actor.userId, botId: actor.botId ?? null }, igsid, signText(clean, signer, 'instagram'));
    const message = await this.mirrored(sent.id);
    // na caixa a mensagem fica sem a assinatura (quem enviou já aparece no balão)
    if (message && signer && message.text !== clean) return this.prisma.chat_Message.update({ where: { id: message.id }, data: { text: clean } });
    return message;
  }

  async sendMedia(actor: { companyId: number; userId: number }, igsid: string, type: string, media: ChatMedia) {
    const igType = type === 'image' ? 'image' : type === 'video' ? 'video' : type === 'audio' ? 'audio' : 'file';
    const url = await this.media.publicLink(media);
    const sent = await this.instagram.replyMedia({ companyId: actor.companyId, userId: actor.userId }, igsid, { type: igType, url });
    const row = sent.id ? await this.prisma.ai_SocialMessage.findUnique({ where: { id: sent.id } }) : null;
    if (!row) throw new BadRequestException('O Instagram não confirmou o envio.');
    const message = await this.mirror(row, { media: { ...media, state: 'ok' } });
    // o gancho pode ter espelhado antes, sem o arquivo: completa
    if (message && !(message.media as ChatMedia | null)?.key) {
      return this.prisma.chat_Message.update({ where: { id: message.id }, data: { media: { ...media, state: 'ok' } as any, type } });
    }
    return message;
  }

  private async mirrored(socialId: number | null) {
    const row = socialId ? await this.prisma.ai_SocialMessage.findUnique({ where: { id: socialId } }) : null;
    if (!row) throw new BadRequestException('O Instagram não confirmou o envio.');
    return this.mirror(row);
  }

  async markRead(companyId: number, igsid: string) {
    await this.instagram.markRead(companyId, igsid).catch(() => undefined);
  }
}
