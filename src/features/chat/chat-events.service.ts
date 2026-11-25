import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Response } from 'express';
import type Redis from 'ioredis';
import { CacheService } from 'src/common/cache/cache.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatActor } from './chat-channels.service';

/**
 * Tempo real da caixa de entrada (SSE).
 *
 * Quem muda alguma coisa publica um evento pequeno no Redis (vale com várias
 * réplicas da API); cada réplica entrega aos navegadores conectados nela que
 * podem ver aquele número. O evento só avisa "mudou": a tela busca os dados
 * de novo pelas rotas normais, que conferem a permissão.
 *
 * O EventSource do navegador não manda cabeçalho, então a tela pede antes um
 * ticket de uso único (vale 60 s) com o login normal.
 */

export type ChatEventKind = 'message' | 'status' | 'conversation' | 'channel';
export interface ChatEvent {
  companyId: number;
  kind: ChatEventKind;
  channelId?: number | null;
  conversationId?: number | null;
  assignedUserId?: number | null;
  /** mensagem nova do cliente (a tela pode avisar com som) */
  inbound?: boolean;
  contactName?: string | null;
  preview?: string | null;
}

interface Client {
  id: number;
  res: Response;
  companyId: number;
  userId: number;
  all: boolean;
  channelIds: Set<number>;
  refreshedAt: number;
}

const TOPIC = 'chat:events';
const TICKET_TTL = 60;
const PING_MS = 25000;
const REFRESH_MS = 60000;

@Injectable()
export class ChatEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatEventsService.name);
  private readonly clients = new Map<number, Client>();
  private sub: Redis | null = null;
  private subscribed = false;
  private seq = 0;
  private ping: NodeJS.Timeout | null = null;

  constructor(private readonly cache: CacheService, private readonly prisma: PrismaService) {}

  onModuleInit() {
    try {
      this.sub = this.cache.client().duplicate();
      this.sub.on('error', (error) => this.logger.warn(`Redis (tempo real): ${error.message}`));
      this.sub.on('message', (_topic, raw) => {
        try { void this.deliver(JSON.parse(raw)); } catch { /* evento inválido */ }
      });
      this.sub.subscribe(TOPIC).then(() => { this.subscribed = true; }).catch((error) => this.logger.warn(`Tempo real sem Redis (só nesta réplica): ${error.message}`));
    } catch (error) {
      this.logger.warn(`Tempo real sem Redis (só nesta réplica): ${(error as Error).message}`);
    }
    this.ping = setInterval(() => {
      for (const client of this.clients.values()) client.res.write(': ping\n\n');
    }, PING_MS);
    this.ping.unref?.();
  }

  onModuleDestroy() {
    if (this.ping) clearInterval(this.ping);
    for (const client of this.clients.values()) client.res.end();
    this.clients.clear();
    this.sub?.disconnect();
  }

  /** Avisa as telas. Nunca derruba quem chamou. */
  emit(event: ChatEvent) {
    if (!event?.companyId) return;
    const raw = JSON.stringify(event);
    if (this.subscribed) {
      this.cache.client().publish(TOPIC, raw).catch(() => void this.deliver(event));
    } else {
      void this.deliver(event);
    }
  }

  // ---------------------------------------------------------------- conexão

  async ticket(actor: ChatActor): Promise<{ ticket: string; expiresIn: number }> {
    const ticket = randomBytes(24).toString('hex');
    await this.cache.set(`chat:ticket:${ticket}`, actor, TICKET_TTL);
    return { ticket, expiresIn: TICKET_TTL };
  }

  /** Troca o ticket pelo login (uma vez só). */
  async redeem(ticket: unknown): Promise<ChatActor | null> {
    if (typeof ticket !== 'string' || !/^[a-f0-9]{48}$/.test(ticket)) return null;
    const key = `chat:ticket:${ticket}`;
    const actor = await this.cache.get<ChatActor>(key).catch(() => null);
    if (!actor) return null;
    await this.cache.del(key).catch(() => undefined);
    return actor;
  }

  private async visibleChannels(actor: { companyId: number; userId: number }) {
    const rows = await this.prisma.chat_ChannelMember.findMany({ where: { userId: actor.userId, channel: { companyId: actor.companyId, active: true } }, select: { channelId: true } });
    return new Set(rows.map((r) => r.channelId));
  }

  async open(actor: ChatActor, res: Response) {
    const all = actor.permissions.includes('todas_conversas');
    const client: Client = { id: ++this.seq, res, companyId: actor.companyId, userId: actor.userId, all, channelIds: all ? new Set() : await this.visibleChannels(actor), refreshedAt: Date.now() };
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx não segura os eventos
    res.flushHeaders?.();
    res.write(`retry: 5000\nevent: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    this.clients.set(client.id, client);
    res.on('close', () => this.clients.delete(client.id));
  }

  /** Quantas telas estão ouvindo nesta réplica (para os testes). */
  get listening() {
    return this.clients.size;
  }

  private async deliver(event: ChatEvent) {
    const payload = `event: chat\ndata: ${JSON.stringify({
      kind: event.kind, channelId: event.channelId ?? null, conversationId: event.conversationId ?? null, inbound: !!event.inbound,
      contactName: event.contactName ?? null, preview: event.preview ?? null, assignedUserId: event.assignedUserId ?? null,
    })}\n\n`;
    for (const client of this.clients.values()) {
      if (client.companyId !== event.companyId) continue;
      if (!client.all) {
        if (Date.now() - client.refreshedAt > REFRESH_MS || event.kind === 'channel') {
          client.refreshedAt = Date.now();
          client.channelIds = await this.visibleChannels(client).catch(() => client.channelIds);
        }
        const mine = event.assignedUserId && event.assignedUserId === client.userId;
        if (event.channelId && !client.channelIds.has(event.channelId) && !mine) continue;
      }
      client.res.write(payload);
    }
  }
}
