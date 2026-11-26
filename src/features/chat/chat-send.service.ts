import { BadRequestException, ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Chat_Channel, Chat_Message } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { EvolutionProvider, ProviderError } from './providers/evolution.provider';
import { ChatEventsService } from './chat-events.service';
import { ChatMedia, ChatMediaService } from './chat-media.service';
import { ChatChannelsService } from './chat-channels.service';
import { previewOf } from './chat.settings';
import { hasLink, hasShortener, normalizeSettings, signText, spDayStart, textHash } from './chat.settings';
import { signerOf } from './chat-signature';
import { CloudConfig, CloudProvider, cloudConfigOf } from './providers/cloud.provider';

const MAX_TEXT = 4000;
const REPEAT_LIMIT = 5;

/**
 * Fila de envio com ritmo de pessoa. Nada fala direto com o WhatsApp: a
 * mensagem entra como `queued` e o trabalhador manda uma por vez por número,
 * com intervalo aleatório, "digitando…" e limites por minuto, hora e dia.
 * A fila fica no banco (sobrevive a deploy) e a trava por número é o
 * `nextSendAt` do canal, atualizado de forma atômica (vale com várias réplicas).
 */
@Injectable()
export class ChatSendService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatSendService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Nos testes: sem intervalo nem "digitando". */
  fast = process.env.NODE_ENV === 'test';

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: EvolutionProvider,
    private readonly channels: ChatChannelsService,
    private readonly events: ChatEventsService,
    private readonly media: ChatMediaService,
    private readonly cloud: CloudProvider,
  ) {}

  private changed(message: { companyId: number; channelId: number; conversationId: number }, kind: 'message' | 'status' = 'status') {
    this.events.emit({ companyId: message.companyId, kind, channelId: message.channelId, conversationId: message.conversationId });
  }

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 1000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- entrada na fila

  /**
   * Valida as proteções e põe na fila. `isNew` = o contato nunca escreveu para
   * este número (conta no limite de contatos novos do dia).
   */
  async enqueue(params: { channel: Chat_Channel; conversationId: number; contact: { id: number; optOut: boolean; firstInboundAt: Date | null }; text: string; userId?: number | null; botId?: number | null; confirmedNew?: boolean; origin?: 'system' | 'bot' | 'auto'; type?: string; media?: ChatMedia | null }) {
    const { channel, contact } = params;
    const text = String(params.text ?? '').trim();
    const type = params.media ? params.type ?? 'document' : 'text';
    if (!text && type === 'text') throw new BadRequestException('Escreva a mensagem.');
    if (text.length > MAX_TEXT) throw new BadRequestException(`A mensagem passou de ${MAX_TEXT} caracteres.`);
    if (channel.status === 'banido') throw new BadRequestException('Este número foi bloqueado pelo WhatsApp. Os envios estão pausados.');
    if (channel.status !== 'conectado') throw new BadRequestException('Este número está desconectado. Conecte de novo em Conversas → Números.');
    if (contact.optOut) throw new BadRequestException('Este cliente pediu para não receber mais mensagens.');
    if (hasShortener(text)) throw new BadRequestException('Links encurtados (bit.ly e parecidos) aumentam o risco de bloqueio. Use o endereço completo.');

    const settings = normalizeSettings(channel.settings);
    const isNew = !contact.firstInboundAt;
    if (isNew) {
      if (hasLink(text)) throw new BadRequestException('Na primeira mensagem para quem nunca falou com este número, mande sem link. Depois que a pessoa responder, o link pode ir.');
      const alreadyTalked = await this.prisma.chat_Message.count({ where: { conversationId: params.conversationId, direction: 'out', status: { notIn: ['failed'] } } });
      if (!alreadyTalked) {
        if (!params.confirmedNew) throw new ConflictException({ code: 'confirm_new', message: 'Esta pessoa nunca falou com este número. Confirme que ela pediu o contato.' });
        const newToday = await this.newContactsToday(channel.id);
        if (newToday >= settings.limites.novosPorDia) throw new BadRequestException(`Limite de ${settings.limites.novosPorDia} contatos novos por dia neste número atingido. Tente amanhã.`);
      }
    }

    const hash = textHash(text);
    if (type === 'text' && text.length >= 20) {
      const since = new Date(Date.now() - 3600000);
      const same = await this.prisma.chat_Message.findMany({ where: { channelId: channel.id, textHash: hash, direction: 'out', sentAt: { gte: since }, conversationId: { not: params.conversationId } }, distinct: ['conversationId'], select: { conversationId: true } });
      if (same.length >= REPEAT_LIMIT) throw new BadRequestException('Este mesmo texto já foi para muitos contatos na última hora. Mude a mensagem (use o nome da pessoa) para não parecer disparo.');
    }

    const message = await this.prisma.chat_Message.create({
      data: {
        companyId: channel.companyId, channelId: channel.id, conversationId: params.conversationId, direction: 'out', type, text, media: (params.media as any) ?? undefined,
        status: 'queued', origin: params.origin ?? (params.botId ? 'bot' : 'system'), sentByUserId: params.userId ?? null, sentByBotId: params.botId ?? null,
        textHash: hash, scheduledAt: new Date(), sentAt: new Date(),
      },
    });
    await this.prisma.chat_Conversation.update({ where: { id: params.conversationId }, data: { lastMessageAt: message.sentAt, lastMessagePreview: previewOf(type, text), lastDirection: 'out', unread: 0 } });
    this.changed(message, 'message');
    if (this.fast) await this.tick();
    return message;
  }

  /** Contatos que nunca escreveram e receberam a 1ª mensagem hoje. */
  async newContactsToday(channelId: number) {
    const day = spDayStart();
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT v."contactId")::bigint AS n FROM "Chat_Conversation" v
      JOIN "Chat_Contact" c ON c.id = v."contactId"
      WHERE v."channelId" = ${channelId} AND c."firstInboundAt" IS NULL
        AND EXISTS (SELECT 1 FROM "Chat_Message" m WHERE m."conversationId" = v.id AND m.direction = 'out' AND m.status <> 'failed' AND m."sentAt" >= ${day})`;
    return Number(rows[0]?.n ?? 0);
  }

  // ---------------------------------------------------------------- trabalhador

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.prisma.chat_Message.findMany({ where: { status: 'queued', scheduledAt: { lte: new Date() } }, distinct: ['channelId'], select: { channelId: true }, take: 50 });
      // um número lento (ou fora do ar) não segura os outros
      await Promise.all(due.map(async ({ channelId }) => {
        // em teste, manda tudo o que estiver na fila de uma vez
        do { /* empty */ } while ((await this.sendNext(channelId)) && this.fast);
      }));
    } catch (error) {
      this.logger.error(`Fila de envio: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private rand(min: number, max: number) {
    return Math.round((min + Math.random() * (max - min)) * 1000);
  }

  /** Limites por minuto/hora/dia: devolve quando liberar, ou null se pode enviar agora. */
  private async blockedUntil(channel: Chat_Channel): Promise<Date | null> {
    const { limites } = normalizeSettings(channel.settings);
    const now = Date.now();
    const count = (since: Date) => this.prisma.chat_Message.count({ where: { channelId: channel.id, direction: 'out', origin: { in: ['system', 'bot', 'auto'] }, status: { in: ['sending', 'sent', 'delivered', 'read'] }, sentAt: { gte: since } } });
    const [minute, hour, day] = await Promise.all([count(new Date(now - 60000)), count(new Date(now - 3600000)), count(spDayStart())]);
    if (day >= limites.porDia) return new Date(spDayStart().getTime() + 24 * 3600000 + 60000);
    if (hour >= limites.porHora) return new Date(now + 5 * 60000);
    if (minute >= limites.porMinuto) return new Date(now + 15000);
    return null;
  }

  /** Manda a próxima da fila deste número, se a trava de ritmo deixar. */
  async sendNext(channelId: number): Promise<boolean> {
    const channel = await this.prisma.chat_Channel.findUnique({ where: { id: channelId } });
    if (!channel) return false;
    const next = await this.prisma.chat_Message.findFirst({ where: { channelId, status: 'queued', scheduledAt: { lte: new Date() } }, orderBy: { id: 'asc' } });
    if (!next) return false;
    if (channel.status === 'banido' || !channel.active) {
      await this.fail(next, 'Número bloqueado ou removido: envio cancelado.');
      return true;
    }
    const cloud = channel.provider === 'cloud' ? cloudConfigOf(channel) : null;
    if (channel.status !== 'conectado' || (!channel.instanceName && !cloud)) {
      await this.prisma.chat_Message.update({ where: { id: next.id }, data: { scheduledAt: new Date(Date.now() + 30000) } });
      return false;
    }
    const until = await this.blockedUntil(channel);
    if (until) {
      await this.prisma.chat_Message.updateMany({ where: { channelId, status: 'queued', scheduledAt: { lt: until } }, data: { scheduledAt: until } });
      return false;
    }
    const { intervalo } = normalizeSettings(channel.settings);
    const gap = this.fast ? 0 : this.rand(intervalo.min, intervalo.max);
    const typing = this.fast ? 0 : next.type === 'text' ? Math.min(6000, Math.max(1200, next.text.length * 45)) : this.rand(1.5, 3.5);
    // trava atômica: só uma réplica passa, e a próxima mensagem espera o intervalo
    const claimed = await this.prisma.$executeRaw`
      UPDATE "Chat_Channel" SET "nextSendAt" = ${new Date(Date.now() + typing + gap)}
      WHERE id = ${channelId} AND ("nextSendAt" IS NULL OR "nextSendAt" <= ${new Date()})`;
    if (!claimed) return false;
    const took = await this.prisma.chat_Message.updateMany({ where: { id: next.id, status: 'queued' }, data: { status: 'sending' } });
    if (!took.count) return false;

    const contact = await this.prisma.chat_Contact.findFirst({ where: { conversations: { some: { id: next.conversationId } } } });
    if (!contact || contact.optOut) {
      await this.fail(next, 'O cliente pediu para não receber mais mensagens.');
      return true;
    }
    try {
      const to = contact.externalId.endsWith('@s.whatsapp.net') ? contact.externalId.split('@')[0] : contact.externalId;
      const signer = ['system', 'bot'].includes(next.origin) ? await signerOf(this.prisma, channel, { userId: next.sentByUserId, botId: next.sentByBotId }) : null;
      const signed = { ...next, text: signText(next.text, signer, 'whatsapp') };
      const { externalId } = cloud ? await this.deliverCloud(cloud, to, signed) : await this.deliver(channel.instanceName!, to, signed, typing);
      const known = externalId ? await this.prisma.chat_Message.findUnique({ where: { externalId } }) : null;
      if (known && known.id !== next.id) {
        // o eco do webhook chegou antes da resposta: junta as duas
        await this.prisma.chat_Message.delete({ where: { id: known.id } });
      }
      await this.prisma.chat_Message.update({ where: { id: next.id }, data: { status: 'sent', externalId: externalId ?? undefined, sentAt: new Date(), error: null } });
      this.changed(next);
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : (error as Error).message;
      await this.fail(next, message);
      if (error instanceof ProviderError && error.disconnected) await this.channels.markDown(channelId, 'caiu', 'O envio falhou porque o número está desconectado.');
    }
    return true;
  }

  /** Texto, arquivo ou áudio de voz. */
  private async deliver(instance: string, to: string, message: Chat_Message, typing: number) {
    if (message.type === 'text') return this.provider.sendText(instance, to, message.text, typing);
    const media = (message.media as ChatMedia | null) ?? {};
    if (!media.key) throw new BadRequestException('O arquivo desta mensagem não foi encontrado.');
    const base64 = (await this.media.read(media.key)).toString('base64');
    if (message.type === 'audio' && media.ptt) return this.provider.sendAudio(instance, to, base64, typing);
    const mediatype = message.type === 'image' ? 'image' : message.type === 'video' ? 'video' : 'document';
    return this.provider.sendMedia(instance, to, { mediatype, mimetype: media.mimetype || 'application/octet-stream', base64, fileName: media.fileName ?? (mediatype === 'document' ? 'arquivo' : null), caption: message.text }, typing);
  }

  /**
   * WhatsApp oficial: mensagem livre só até 24 h depois da última do cliente
   * (fora disso a Meta exige modelo aprovado, que o sistema ainda não manda).
   */
  private async deliverCloud(cfg: CloudConfig, to: string, message: Chat_Message) {
    const last = await this.prisma.chat_Message.findFirst({ where: { conversationId: message.conversationId, direction: 'in' }, orderBy: { id: 'desc' }, select: { sentAt: true } });
    if (!last || Date.now() - last.sentAt.getTime() > 24 * 3600000) throw new ProviderError('WhatsApp oficial: passaram mais de 24 h desde a última mensagem do cliente. A Meta só deixa mandar modelo aprovado; peça para o cliente escrever ou use outro número.');
    if (message.type === 'text') return this.cloud.sendText(cfg, to, message.text);
    const media = (message.media as ChatMedia | null) ?? {};
    if (!media.key) throw new BadRequestException('O arquivo desta mensagem não foi encontrado.');
    const buffer = await this.media.read(media.key);
    const type = message.type === 'image' || message.type === 'video' || message.type === 'audio' ? message.type : 'document';
    return this.cloud.sendMedia(cfg, to, { type, buffer, mimetype: media.mimetype || 'application/octet-stream', fileName: media.fileName ?? (type === 'document' ? 'arquivo' : null), caption: message.text });
  }

  private async fail(message: Chat_Message, error: string) {
    await this.prisma.chat_Message.update({ where: { id: message.id }, data: { status: 'failed', error: error.slice(0, 1000) } });
    this.changed(message);
  }

  /** Tentar de novo uma mensagem que falhou (volta para o fim da fila). */
  async retry(message: Chat_Message) {
    if (message.status !== 'failed' || message.direction !== 'out') throw new BadRequestException('Só dá para reenviar mensagem que falhou.');
    await this.prisma.chat_Message.update({ where: { id: message.id }, data: { status: 'queued', error: null, scheduledAt: new Date() } });
    this.changed(message);
    if (this.fast) await this.tick();
    return this.prisma.chat_Message.findUnique({ where: { id: message.id } });
  }
}
