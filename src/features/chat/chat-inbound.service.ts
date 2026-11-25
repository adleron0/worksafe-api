import { Injectable, Logger } from '@nestjs/common';
import { Chat_Channel, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatChannelsService } from './chat-channels.service';
import { isOptOut, normalizeSettings, outOfHours, phoneDigits } from './chat.settings';
import { ChatSendService } from './chat-send.service';

type Json = Record<string, any>;

/** O que aparece na lista quando a mensagem não é texto. */
const LABELS: Record<string, string> = {
  image: '📷 Foto', audio: '🎤 Áudio', video: '🎬 Vídeo', document: '📄 Documento', sticker: '💟 Figurinha', location: '📍 Localização', contact: '👤 Contato', other: 'Mensagem',
};

export function readMessage(message: Json | undefined): { type: string; text: string; media: Json | null } {
  const m = message ?? {};
  if (typeof m.conversation === 'string') return { type: 'text', text: m.conversation, media: null };
  if (m.extendedTextMessage) return { type: 'text', text: String(m.extendedTextMessage.text ?? ''), media: null };
  if (m.imageMessage) return { type: 'image', text: String(m.imageMessage.caption ?? ''), media: { mimetype: m.imageMessage.mimetype ?? null } };
  if (m.videoMessage) return { type: 'video', text: String(m.videoMessage.caption ?? ''), media: { mimetype: m.videoMessage.mimetype ?? null } };
  if (m.audioMessage) return { type: 'audio', text: '', media: { mimetype: m.audioMessage.mimetype ?? null, seconds: m.audioMessage.seconds ?? null, ptt: !!m.audioMessage.ptt } };
  if (m.documentMessage || m.documentWithCaptionMessage) {
    const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage ?? {};
    return { type: 'document', text: String(doc.caption ?? ''), media: { fileName: doc.fileName ?? doc.title ?? null, mimetype: doc.mimetype ?? null } };
  }
  if (m.stickerMessage) return { type: 'sticker', text: '', media: null };
  if (m.locationMessage) return { type: 'location', text: String(m.locationMessage.name ?? m.locationMessage.address ?? ''), media: { lat: m.locationMessage.degreesLatitude, lng: m.locationMessage.degreesLongitude } };
  if (m.contactMessage) return { type: 'contact', text: String(m.contactMessage.displayName ?? ''), media: null };
  if (m.ephemeralMessage?.message) return readMessage(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return readMessage(m.viewOnceMessage.message);
  return { type: 'other', text: '', media: null };
}

export const previewOf = (type: string, text: string) => (text ? text : LABELS[type] ?? 'Mensagem').replace(/\s+/g, ' ').slice(0, 200);

const STATUS_RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };
const ACK: Record<string, string> = { SERVER_ACK: 'sent', DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'read', '2': 'sent', '3': 'delivered', '4': 'read', '5': 'read' };

/** Eventos que o Evolution manda para o webhook de cada número. */
@Injectable()
export class ChatInboundService {
  private readonly logger = new Logger(ChatInboundService.name);

  constructor(private readonly prisma: PrismaService, private readonly channels: ChatChannelsService, private readonly send: ChatSendService) {}

  async handle(channel: Chat_Channel, body: Json) {
    const event = String(body?.event ?? '').toLowerCase().replace(/_/g, '.');
    const data = body?.data;
    switch (event) {
      case 'messages.upsert':
        return { stored: await this.upsertMessages(channel, Array.isArray(data) ? data : data?.messages ?? [data]) };
      case 'send.message':
        return { stored: await this.upsertMessages(channel, [data]) };
      case 'messages.update':
        return { updated: await this.updateStatus(channel, Array.isArray(data) ? data : [data]) };
      case 'connection.update':
        await this.connection(channel, data ?? {}, body);
        return { ok: true };
      case 'qrcode.updated': {
        const qr = data?.qrcode?.base64 ?? data?.base64;
        if (qr) this.channels.rememberQr(channel.id, qr);
        return { ok: true };
      }
      default:
        return { ignored: event || 'sem evento' };
    }
  }

  private async connection(channel: Chat_Channel, data: Json, body: Json) {
    const state = String(data.state ?? '');
    if (state === 'open') {
      const jid = String(data.wuid ?? body?.sender ?? '');
      await this.channels.markConnected(channel.id, { phone: phoneDigits(jid.split('@')[0].split(':')[0]) || null, profileName: data.profileName ?? null });
      return;
    }
    if (state === 'close') {
      const code = Number(data.statusReason ?? data.lastDisconnect?.error?.output?.statusCode ?? 0);
      // 401 = saiu do aparelho vinculado; 403 = número banido/bloqueado pelo WhatsApp
      if (code === 403 || code === 402) return this.channels.markDown(channel.id, 'banido', `O WhatsApp bloqueou o número (código ${code}). Os envios foram pausados.`);
      if (code === 401) return this.channels.markDown(channel.id, 'desconectado', 'O aparelho foi desconectado pelo celular. Conecte de novo pelo QR code.');
      if (channel.status === 'conectado') return this.channels.markDown(channel.id, 'caiu', `A conexão caiu${code ? ` (código ${code})` : ''}. O servidor tenta reconectar sozinho.`);
    }
  }

  private jidOf(key: Json): { jid: string; phone: string | null } | null {
    const remote = String(key?.remoteJid ?? '');
    if (!remote || remote.endsWith('@g.us') || remote === 'status@broadcast' || remote.endsWith('@broadcast') || remote.endsWith('@newsletter')) return null;
    const alt = [key?.remoteJidAlt, key?.senderPn, key?.participantPn].find((v) => typeof v === 'string' && v.includes('@s.whatsapp.net')) as string | undefined;
    const pnJid = remote.endsWith('@s.whatsapp.net') ? remote : alt;
    const phone = pnJid ? phoneDigits(pnJid.split('@')[0].split(':')[0]) : null;
    return { jid: pnJid ?? remote, phone };
  }

  /** Acha (ou cria) contato e conversa; vincula o cliente pelo telefone. */
  async contactAndConversation(channel: Chat_Channel, who: { jid: string; phone: string | null; pushName?: string | null }) {
    let contact = await this.prisma.chat_Contact.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: who.jid } } });
    if (!contact) {
      const customerId = who.phone ? await this.findCustomer(channel.companyId, who.phone) : null;
      contact = await this.prisma.chat_Contact
        .create({ data: { companyId: channel.companyId, channelId: channel.id, externalId: who.jid, phone: who.phone, pushName: who.pushName ?? null, customerId } })
        .catch(async (error) => {
          if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') return this.prisma.chat_Contact.findUniqueOrThrow({ where: { channelId_externalId: { channelId: channel.id, externalId: who.jid } } });
          throw error;
        });
    } else if (who.pushName && who.pushName !== contact.pushName) {
      contact = await this.prisma.chat_Contact.update({ where: { id: contact.id }, data: { pushName: who.pushName } });
    }
    let conversation = await this.prisma.chat_Conversation.findUnique({ where: { channelId_contactId: { channelId: channel.id, contactId: contact.id } } });
    if (!conversation) {
      conversation = await this.prisma.chat_Conversation
        .create({ data: { companyId: channel.companyId, channelId: channel.id, contactId: contact.id, sector: channel.sector } })
        .catch(async (error) => {
          if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') return this.prisma.chat_Conversation.findUniqueOrThrow({ where: { channelId_contactId: { channelId: channel.id, contactId: contact!.id } } });
          throw error;
        });
    }
    return { contact, conversation };
  }

  /** Cliente cujo telefone (ou de um contato dele) termina com os mesmos 10 dígitos. */
  async findCustomer(companyId: number, phone: string): Promise<number | null> {
    const tail = phone.replace(/\D/g, '').slice(-10);
    if (tail.length < 10) return null;
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT c.id FROM "Customer" c
      WHERE c."companyId" = ${companyId} AND (
        right(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), 10) = ${tail}
        OR right(regexp_replace(coalesce(c.phone2, ''), '\\D', '', 'g'), 10) = ${tail}
        OR EXISTS (SELECT 1 FROM "Customer_Contacts" cc WHERE cc."customerId" = c.id AND right(regexp_replace(coalesce(cc.phone, ''), '\\D', '', 'g'), 10) = ${tail})
      )
      ORDER BY c.id LIMIT 1`.catch(() => []);
    return rows[0]?.id ?? null;
  }

  private async upsertMessages(channel: Chat_Channel, items: Json[]) {
    let stored = 0;
    for (const item of items) {
      if (!item?.key?.id) continue;
      const who = this.jidOf(item.key);
      if (!who) continue;
      const exists = await this.prisma.chat_Message.findUnique({ where: { externalId: item.key.id } });
      if (exists) continue;
      const fromMe = item.key.fromMe === true;
      const { type, text, media } = readMessage(item.message);
      if (type === 'other' && !text) continue; // reações, protocolo, edições
      const sentAt = item.messageTimestamp ? new Date(Number(item.messageTimestamp) * (Number(item.messageTimestamp) < 1e12 ? 1000 : 1)) : new Date();
      const { contact, conversation } = await this.contactAndConversation(channel, { ...who, pushName: fromMe ? null : item.pushName });
      try {
        await this.prisma.chat_Message.create({
          data: {
            companyId: channel.companyId, channelId: channel.id, conversationId: conversation.id,
            direction: fromMe ? 'out' : 'in', type, text, media: media ?? undefined, externalId: item.key.id,
            status: fromMe ? 'sent' : 'received', origin: fromMe ? 'phone' : 'webhook', sentAt,
          },
        });
      } catch (error) {
        if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') continue;
        throw error;
      }
      stored++;
      const reopened = !fromMe && conversation.status === 'resolvida';
      await this.prisma.chat_Conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: sentAt, lastMessagePreview: previewOf(type, text), lastDirection: fromMe ? 'out' : 'in',
          ...(fromMe ? { unread: 0 } : { unread: { increment: 1 }, status: 'aberta' }),
          ...(reopened ? { resolvedAt: null, sector: conversation.sector ?? channel.sector } : {}),
        },
      });
      if (!fromMe) {
        const optOut = type === 'text' && isOptOut(text);
        await this.prisma.chat_Contact.update({
          where: { id: contact.id },
          data: { ...(contact.firstInboundAt ? {} : { firstInboundAt: sentAt }), ...(optOut && !contact.optOut ? { optOut: true, optOutAt: new Date() } : {}) },
        });
        if (!optOut && !contact.optOut) await this.outOfHoursReply(channel, conversation.id, contact.id);
        if (optOut && !contact.optOut) {
          await this.prisma.chat_Message.create({
            data: { companyId: channel.companyId, channelId: channel.id, conversationId: conversation.id, direction: 'note', type: 'text', status: 'sent', origin: 'system', text: 'O cliente pediu para não receber mais mensagens. Os envios para este contato foram travados.' },
          });
        }
      }
    }
    return stored;
  }

  /** Fora do horário: manda a mensagem configurada, no máximo uma vez a cada 12 h por conversa. */
  private async outOfHoursReply(channel: Chat_Channel, conversationId: number, contactId: number) {
    const settings = normalizeSettings(channel.settings);
    const text = settings.horario.mensagemFora.trim();
    if (!text || !outOfHours(settings)) return;
    const recent = await this.prisma.chat_Message.count({ where: { conversationId, origin: 'auto', sentAt: { gte: new Date(Date.now() - 12 * 3600000) } } });
    if (recent) return;
    const contact = await this.prisma.chat_Contact.findUniqueOrThrow({ where: { id: contactId } });
    try {
      await this.send.enqueue({ channel, conversationId, contact, text, origin: 'auto' });
    } catch (error) {
      this.logger.warn(`Mensagem fora do horário não saiu: ${(error as Error).message}`);
    }
  }

  private async updateStatus(channel: Chat_Channel, items: Json[]) {
    let updated = 0;
    for (const item of items) {
      const id = item?.keyId ?? item?.key?.id ?? item?.messageId;
      const raw = String(item?.status ?? item?.update?.status ?? '');
      const status = ACK[raw];
      if (!id || !status) continue;
      const message = await this.prisma.chat_Message.findFirst({ where: { externalId: String(id), channelId: channel.id } });
      if (!message || message.direction !== 'out') continue;
      if ((STATUS_RANK[status] ?? 0) <= (STATUS_RANK[message.status] ?? 0)) continue;
      await this.prisma.chat_Message.update({ where: { id: message.id }, data: { status } });
      updated++;
    }
    return updated;
  }
}
