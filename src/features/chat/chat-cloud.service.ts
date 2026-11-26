import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Chat_Channel } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { encryptPayload } from 'src/utils/crypto';
import { ChatActor, ChatChannelsService } from './chat-channels.service';
import { ChatInboundService } from './chat-inbound.service';
import { ChatEventsService } from './chat-events.service';
import { CloudConfig, CloudProvider, cloudConfigOf } from './providers/cloud.provider';

type Json = Record<string, any>;

const ACK: Record<string, string> = { sent: 'SERVER_ACK', delivered: 'DELIVERY_ACK', read: 'READ' };

/** Mensagem da Cloud API no formato que a caixa de entrada já entende (o do Evolution). */
export function cloudToUpsert(message: Json, contacts: Json[]): Json | null {
  const waId = String(message.from ?? '');
  if (!waId || !message.id) return null;
  const name = contacts.find((c) => c?.wa_id === waId)?.profile?.name ?? null;
  const media = (kind: string, extra: Json = {}) => ({ mimetype: message[kind]?.mime_type ?? null, cloudId: message[kind]?.id ?? null, ...extra });
  let body: Json;
  switch (message.type) {
    case 'text': body = { conversation: String(message.text?.body ?? '') }; break;
    case 'image': body = { imageMessage: media('image', { caption: message.image?.caption ?? '' }) }; break;
    case 'video': body = { videoMessage: media('video', { caption: message.video?.caption ?? '' }) }; break;
    case 'audio': body = { audioMessage: media('audio', { ptt: !!message.audio?.voice }) }; break;
    case 'document': body = { documentMessage: media('document', { fileName: message.document?.filename ?? null, caption: message.document?.caption ?? '' }) }; break;
    case 'sticker': body = { stickerMessage: media('sticker') }; break;
    case 'location': body = { locationMessage: { degreesLatitude: message.location?.latitude, degreesLongitude: message.location?.longitude, name: message.location?.name ?? message.location?.address ?? '' } }; break;
    case 'contacts': body = { contactMessage: { displayName: message.contacts?.[0]?.name?.formatted_name ?? 'Contato' } }; break;
    case 'button': body = { conversation: String(message.button?.text ?? '') }; break;
    case 'interactive': body = { conversation: String(message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? '') }; break;
    default: return null; // reação, sistema, não suportado
  }
  return { key: { remoteJid: `${waId}@s.whatsapp.net`, fromMe: false, id: message.id }, pushName: name, message: body, messageTimestamp: Number(message.timestamp) || Math.floor(Date.now() / 1000) };
}

/**
 * WhatsApp oficial (Cloud API): conectar o número com as credenciais da Meta
 * e receber o webhook (verificação + mensagens + status de entrega).
 */
@Injectable()
export class ChatCloudService {
  private readonly logger = new Logger(ChatCloudService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloud: CloudProvider,
    private readonly channels: ChatChannelsService,
    private readonly inbound: ChatInboundService,
    private readonly events: ChatEventsService,
  ) {}

  webhookUrl(channelId: number) {
    return this.channels.webhookUrl(channelId).replace('/webhook/evolution/', '/webhook/cloud/');
  }

  /** Liga (ou atualiza o token de) um número pelo WhatsApp oficial. */
  async connect(actor: ChatActor, id: number, body: { phoneNumberId?: unknown; wabaId?: unknown; token?: unknown; appSecret?: unknown }) {
    const channel = await this.prisma.chat_Channel.findFirst({ where: { id, companyId: actor.companyId, active: true } });
    if (!channel) throw new NotFoundException('Número não encontrado');
    if (channel.type !== 'whatsapp') throw new BadRequestException('Só números de WhatsApp usam a API oficial.');
    if (channel.provider !== 'cloud' && channel.instanceName && channel.status === 'conectado') throw new BadRequestException('Este número está conectado pelo QR code. Desconecte primeiro para passar para o WhatsApp oficial.');
    const previous = cloudConfigOf(channel);
    const text = (value: unknown) => String(value ?? '').trim();
    const cfg: CloudConfig = {
      phoneNumberId: text(body.phoneNumberId) || previous?.phoneNumberId || '',
      wabaId: text(body.wabaId) || previous?.wabaId || null,
      token: text(body.token) || previous?.token || '',
      appSecret: text(body.appSecret) || previous?.appSecret || '',
      verifyToken: previous?.verifyToken || randomBytes(18).toString('hex'),
    };
    if (!/^\d{6,30}$/.test(cfg.phoneNumberId)) throw new BadRequestException('Informe o ID do número de telefone (só números, aparece em WhatsApp → Configuração da API).');
    if (cfg.token.length < 20) throw new BadRequestException('Informe o token de acesso permanente (de um usuário do sistema da Meta).');
    if (cfg.appSecret.length < 16) throw new BadRequestException('Informe a chave secreta do app (Configurações do app → Básico).');
    const info = await this.cloud.check(cfg);
    await this.prisma.chat_Channel.update({
      where: { id },
      data: {
        provider: 'cloud', cloudConfig: encryptPayload(cfg), instanceName: null, webhookTokenHash: null,
        termsAcceptedByUserId: actor.userId, termsAcceptedAt: new Date(), termsVersion: 'oficial',
      },
    });
    await this.channels.markConnected(id, { phone: info.phone, profileName: info.name });
    return { status: 'conectado', phone: info.phone, profileName: info.name, webhookUrl: this.webhookUrl(id), verifyToken: cfg.verifyToken };
  }

  /** Dados para colar no app da Meta (só quem cuida dos números). */
  async webhookInfo(actor: ChatActor, id: number) {
    const channel = await this.prisma.chat_Channel.findFirst({ where: { id, companyId: actor.companyId, active: true } });
    if (!channel) throw new NotFoundException('Número não encontrado');
    const cfg = cloudConfigOf(channel);
    if (channel.provider !== 'cloud' || !cfg) return { connected: false, webhookUrl: this.webhookUrl(id), verifyToken: null, phoneNumberId: null, wabaId: null };
    return { connected: channel.status === 'conectado', webhookUrl: this.webhookUrl(id), verifyToken: cfg.verifyToken, phoneNumberId: cfg.phoneNumberId, wabaId: cfg.wabaId ?? null, tokenHint: `…${cfg.token.slice(-4)}` };
  }

  private async channelOf(id: number): Promise<{ channel: Chat_Channel; cfg: CloudConfig } | null> {
    const channel = await this.prisma.chat_Channel.findFirst({ where: { id, active: true, provider: 'cloud' } });
    const cfg = channel ? cloudConfigOf(channel) : null;
    return channel && cfg ? { channel, cfg } : null;
  }

  /** GET da Meta ao cadastrar o webhook: devolve o hub.challenge se o token bater. */
  async verify(id: number, query: Json): Promise<string> {
    const found = await this.channelOf(id);
    if (!found || query['hub.mode'] !== 'subscribe' || String(query['hub.verify_token'] ?? '') !== found.cfg.verifyToken) throw new ForbiddenException('Token de verificação inválido');
    return String(query['hub.challenge'] ?? '');
  }

  validSignature(raw: Buffer | undefined, header: unknown, secret: string) {
    if (!Buffer.isBuffer(raw) || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
    const got = Buffer.from(header.slice(7));
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /** POST da Meta: mensagens novas e status (enviada, entregue, lida, falhou). */
  async receive(id: number, raw: Buffer | undefined, signature: unknown) {
    const found = await this.channelOf(id);
    if (!found) throw new ForbiddenException('Webhook inválido');
    if (!this.validSignature(raw, signature, found.cfg.appSecret)) throw new ForbiddenException('Assinatura inválida');
    let body: Json;
    try { body = JSON.parse(raw!.toString('utf8')); } catch { return { stored: 0 }; }
    let stored = 0;
    let updated = 0;
    for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        const value = change?.value ?? {};
        if (value?.metadata?.phone_number_id && String(value.metadata.phone_number_id) !== found.cfg.phoneNumberId) continue;
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        const items = (Array.isArray(value.messages) ? value.messages : []).map((m: Json) => cloudToUpsert(m, contacts)).filter(Boolean);
        if (items.length) stored += Number((await this.inbound.handle(found.channel, { event: 'messages.upsert', data: items }))?.stored ?? 0);
        for (const st of Array.isArray(value.statuses) ? value.statuses : []) {
          if (st?.status === 'failed') {
            const error = st.errors?.[0];
            const row = await this.prisma.chat_Message.findUnique({ where: { externalId: String(st.id) } });
            if (row) {
              await this.prisma.chat_Message.update({ where: { id: row.id }, data: { status: 'failed', error: `WhatsApp oficial: ${error?.error_data?.details || error?.title || 'a Meta não entregou a mensagem'}`.slice(0, 1000) } });
              this.events.emit({ companyId: row.companyId, kind: 'status', channelId: row.channelId, conversationId: row.conversationId });
              updated++;
            }
            continue;
          }
          const ack = ACK[String(st?.status ?? '')];
          if (ack && st?.id) updated += Number((await this.inbound.handle(found.channel, { event: 'messages.update', data: [{ keyId: String(st.id), status: ack }] }))?.updated ?? 0);
        }
      }
    }
    return { stored, updated };
  }
}
