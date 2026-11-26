import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { EvolutionProvider } from './providers/evolution.provider';
import { ChatChannelsService, ChatActor } from './chat-channels.service';
import { SECTORS, normalizeSettings, spDayStart } from './chat.settings';

const DAY = 86400000;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
};
const avg = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
const pct = (part: number, total: number) => (total ? Math.round((part / total) * 100) : null);

export interface HealthWarning { level: 'erro' | 'atencao'; text: string }

/**
 * Saúde dos números (conexão, uso perto do limite, sinais de risco de bloqueio)
 * e métricas do atendimento (tempo da primeira resposta, volume por setor e
 * por atendente). Também confere, a cada 5 min, se a conexão no servidor do
 * WhatsApp bate com o que o sistema acha (caiu sem avisar / voltou sozinha).
 */
@Injectable()
export class ChatMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatMetricsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService, private readonly provider: EvolutionProvider, private readonly channels: ChatChannelsService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.watch().catch((error) => this.logger.warn(`Saúde dos números: ${error?.message}`)), 5 * 60000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Confere a conexão real dos números que o sistema acha conectados (ou caídos). */
  async watch() {
    if (!this.provider.ready()) return;
    const rows = await this.prisma.chat_Channel.findMany({ where: { active: true, type: 'whatsapp', provider: 'evolution', instanceName: { not: null }, status: { in: ['conectado', 'caiu'] } }, select: { id: true, status: true, instanceName: true } });
    for (const row of rows) {
      const state = await this.provider.state(row.instanceName!).catch(() => null);
      if (!state) continue;
      if (state === 'open' && row.status === 'caiu') await this.channels.markConnected(row.id);
      if (state === 'close' && row.status === 'conectado') await this.channels.markDown(row.id, 'caiu', 'O servidor do WhatsApp perdeu a conexão com o aparelho. Abra o WhatsApp no celular; se não voltar, conecte de novo pelo QR code.');
    }
  }

  private allowed(actor: ChatActor) {
    if (!actor.permissions.includes('todas_conversas') && !actor.permissions.includes('canais_conversas')) throw new ForbiddenException('Acesso negado: Permissões insuficientes');
  }

  // ------------------------------------------------------------------ saúde

  async health(actor: ChatActor, id: number) {
    this.allowed(actor);
    const channel = await this.prisma.chat_Channel.findFirst({ where: { id, companyId: actor.companyId, active: true } });
    if (!channel) throw new NotFoundException('Número não encontrado');
    const limits = normalizeSettings(channel.settings).limites;
    const now = Date.now();
    const day = spDayStart();
    const week = new Date(now - 7 * DAY);
    const sentOk = { in: ['sent', 'delivered', 'read'] };
    const live = { notIn: ['history'] };

    const [sentDay, sentHour, sentMinute, queued, oldestQueued, failed24, optOuts7, lastIn, lastOut, inbound7, outbound7, events, before, drops7] = await Promise.all([
      this.prisma.chat_Message.count({ where: { channelId: id, direction: 'out', status: sentOk, origin: live, sentAt: { gte: day } } }),
      this.prisma.chat_Message.count({ where: { channelId: id, direction: 'out', status: sentOk, origin: live, sentAt: { gte: new Date(now - 3600000) } } }),
      this.prisma.chat_Message.count({ where: { channelId: id, direction: 'out', status: sentOk, origin: live, sentAt: { gte: new Date(now - 60000) } } }),
      this.prisma.chat_Message.count({ where: { channelId: id, status: 'queued' } }),
      this.prisma.chat_Message.findFirst({ where: { channelId: id, status: 'queued' }, orderBy: { id: 'asc' }, select: { createdAt: true } }),
      this.prisma.chat_Message.count({ where: { channelId: id, direction: 'out', status: 'failed', createdAt: { gte: new Date(now - DAY) } } }),
      this.prisma.chat_Contact.count({ where: { channelId: id, optOut: true, optOutAt: { gte: week } } }),
      this.prisma.chat_Message.findFirst({ where: { channelId: id, direction: 'in', origin: live }, orderBy: { id: 'desc' }, select: { sentAt: true } }),
      this.prisma.chat_Message.findFirst({ where: { channelId: id, direction: 'out', origin: live, status: sentOk }, orderBy: { id: 'desc' }, select: { sentAt: true } }),
      this.prisma.chat_Message.count({ where: { channelId: id, direction: 'in', origin: live, sentAt: { gte: week } } }),
      this.prisma.chat_Message.count({ where: { channelId: id, direction: 'out', origin: live, status: sentOk, sentAt: { gte: week } } }),
      this.prisma.chat_ChannelEvent.findMany({ where: { channelId: id }, orderBy: { id: 'desc' }, take: 20, select: { id: true, status: true, reason: true, createdAt: true } }),
      this.prisma.chat_ChannelEvent.findFirst({ where: { channelId: id, createdAt: { lt: week } }, orderBy: { id: 'desc' }, select: { status: true } }),
      this.prisma.chat_ChannelEvent.count({ where: { channelId: id, status: { in: ['caiu', 'banido'] }, createdAt: { gte: week } } }),
    ]);

    // contatos novos hoje: receberam a 1ª mensagem hoje sem nunca ter escrito
    const [fresh] = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM "Chat_Contact" c
      WHERE c."channelId" = ${id} AND (c."firstInboundAt" IS NULL OR c."firstInboundAt" >= ${day})
        AND EXISTS (SELECT 1 FROM "Chat_Message" m JOIN "Chat_Conversation" v ON v.id = m."conversationId"
                    WHERE v."contactId" = c.id AND m.direction = 'out' AND m.status <> 'failed' AND m."sentAt" >= ${day})`;
    const newToday = Number(fresh?.n ?? 0);

    // quem recebeu mensagem nos 7 dias e respondeu (taxa de resposta: pouca resposta = cara de disparo)
    const [reply] = await this.prisma.$queryRaw<{ talked: bigint; answered: bigint }[]>`
      SELECT COUNT(*)::bigint AS talked,
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Chat_Message" i WHERE i."conversationId" = o."conversationId" AND i.direction = 'in' AND i.origin <> 'history' AND i."sentAt" >= ${week}))::bigint AS answered
      FROM (SELECT DISTINCT "conversationId" FROM "Chat_Message" WHERE "channelId" = ${id} AND direction = 'out' AND origin NOT IN ('history', 'auto') AND status IN ('sent', 'delivered', 'read') AND "sentAt" >= ${week}) o`;
    const talked = Number(reply?.talked ?? 0);
    const answered = Number(reply?.answered ?? 0);

    // tempo conectado nos últimos 7 dias, pelo histórico
    const timeline = await this.prisma.chat_ChannelEvent.findMany({ where: { channelId: id, createdAt: { gte: week } }, orderBy: { id: 'asc' }, select: { status: true, createdAt: true } });
    let uptime: number | null = null;
    if (before || timeline.length) {
      let state = before?.status ?? null;
      let cursor = week.getTime();
      let up = 0;
      let known = 0;
      for (const ev of timeline) {
        const at = ev.createdAt.getTime();
        if (state) { known += at - cursor; if (state === 'conectado') up += at - cursor; }
        state = ev.status;
        cursor = at;
      }
      if (state) { known += now - cursor; if (state === 'conectado') up += now - cursor; }
      uptime = known > 0 ? Math.round((up / known) * 1000) / 10 : null;
    }

    const warnings: HealthWarning[] = [];
    const whatsapp = channel.type === 'whatsapp';
    if (channel.status === 'banido') warnings.push({ level: 'erro', text: 'O WhatsApp bloqueou este número. Os envios estão pausados. Use outro número (e, se der, peça a revisão no aplicativo).' });
    else if (channel.status === 'caiu') warnings.push({ level: 'erro', text: 'A conexão caiu. Abra o WhatsApp no celular; se não voltar em alguns minutos, conecte de novo pelo QR code.' });
    else if (channel.status === 'desconectado' && whatsapp) warnings.push({ level: 'atencao', text: 'O número está desconectado: as mensagens novas não chegam.' });
    if (channel.status === 'conectado' && oldestQueued && now - oldestQueued.createdAt.getTime() > 15 * 60000 && sentDay < limits.porDia) warnings.push({ level: 'atencao', text: 'Tem mensagem esperando na fila há mais de 15 minutos. Pode ser a conexão lenta ou o limite por hora.' });
    if (whatsapp && sentDay >= limits.porDia * 0.8) warnings.push({ level: 'atencao', text: `Já foram ${sentDay} de ${limits.porDia} mensagens hoje. Passando do limite, o resto espera até amanhã.` });
    if (whatsapp && limits.novosPorDia && newToday >= limits.novosPorDia * 0.8) warnings.push({ level: 'atencao', text: `${newToday} de ${limits.novosPorDia} contatos novos hoje. Mensagem para quem nunca falou com o número é o que mais pesa para bloquear.` });
    if (failed24 >= 5) warnings.push({ level: 'atencao', text: `${failed24} mensagens falharam nas últimas 24 h. Veja o motivo nas conversas (balão vermelho).` });
    if (talked >= 15 && answered / talked < 0.3) warnings.push({ level: 'atencao', text: `Só ${pct(answered, talked)}% de quem recebeu mensagem nos 7 dias respondeu. Pouca resposta é o padrão de disparo que o WhatsApp bloqueia.` });
    if (optOuts7 >= 3) warnings.push({ level: 'atencao', text: `${optOuts7} pessoas pediram para não receber mais mensagens nesta semana. Cuidado: quem pede para parar costuma denunciar.` });
    if (drops7 >= 3) warnings.push({ level: 'atencao', text: `A conexão caiu ${drops7} vezes em 7 dias. Confira a internet do celular e se o WhatsApp está atualizado.` });
    if (channel.status === 'conectado' && lastIn && now - lastIn.sentAt.getTime() > 7 * DAY) warnings.push({ level: 'atencao', text: 'Nenhuma mensagem chegou em 7 dias. Se o número é usado, a conexão pode ter travado: desconecte e conecte de novo.' });

    return {
      id: channel.id, name: channel.name, type: channel.type, provider: channel.provider, status: channel.status, statusReason: channel.statusReason, statusAt: channel.statusAt, connectedAt: channel.connectedAt, phone: channel.phone,
      level: warnings.some((w) => w.level === 'erro') ? 'erro' : warnings.length ? 'atencao' : 'ok',
      warnings,
      usage: { minute: sentMinute, hour: sentHour, day: sentDay, newToday, limits },
      queue: { queued, oldestAt: oldestQueued?.createdAt ?? null },
      week: { inbound: inbound7, outbound: outbound7, talked, answered, replyRate: pct(answered, talked), optOuts: optOuts7, drops: drops7, uptime },
      failed24, lastInboundAt: lastIn?.sentAt ?? null, lastOutboundAt: lastOut?.sentAt ?? null,
      events,
    };
  }

  // ---------------------------------------------------------------- métricas

  async metrics(actor: ChatActor, query: { days?: unknown; channelId?: unknown }) {
    this.allowed(actor);
    const days = [1, 7, 30, 90].includes(Number(query.days)) ? Number(query.days) : 30;
    const from = days === 1 ? spDayStart() : new Date(spDayStart().getTime() - (days - 1) * DAY);
    const channels = await this.prisma.chat_Channel.findMany({ where: { companyId: actor.companyId, active: true, ...(Number(query.channelId) > 0 ? { id: Number(query.channelId) } : {}) }, select: { id: true, name: true, color: true, type: true, sector: true } });
    const ids = channels.map((c) => c.id);
    const empty = { days, from, channels: channels.map((c) => ({ id: c.id, name: c.name })), totals: null, firstResponse: null, bySector: [], byUser: [], byChannel: [], byDay: [], byHour: [] };
    if (!ids.length) return empty;
    const idList = Prisma.join(ids);
    const buffer = new Date(from.getTime() - 2 * DAY);

    // 1ª resposta: cada vez que o cliente volta a escrever depois de uma resposta (ou pela 1ª vez), quanto tempo até a empresa responder
    const turns = await this.prisma.$queryRaw<{ conversationId: number; channelId: number; asked: Date; answered: Date | null; userId: number | null; botId: number | null; origin: string | null }[]>`
      WITH m AS (
        SELECT id, "conversationId", "channelId", direction, "sentAt",
               LAG(direction) OVER (PARTITION BY "conversationId" ORDER BY id) AS prev
        FROM "Chat_Message"
        WHERE "companyId" = ${actor.companyId} AND "channelId" IN (${idList}) AND direction IN ('in', 'out')
          AND origin NOT IN ('history', 'auto') AND status <> 'failed' AND "sentAt" >= ${buffer}
      ), o AS (
        SELECT id, "conversationId", "channelId", "sentAt" FROM m WHERE direction = 'in' AND (prev IS NULL OR prev = 'out') AND "sentAt" >= ${from}
      )
      SELECT o."conversationId", o."channelId", o."sentAt" AS asked, r."sentAt" AS answered, r."sentByUserId" AS "userId", r."sentByBotId" AS "botId", r.origin
      FROM o LEFT JOIN LATERAL (
        SELECT x."sentAt", x."sentByUserId", x."sentByBotId", x.origin FROM "Chat_Message" x
        WHERE x."conversationId" = o."conversationId" AND x.id > o.id AND x.direction = 'out' AND x.origin NOT IN ('history', 'auto') AND x.status <> 'failed'
        ORDER BY x.id LIMIT 1
      ) r ON true`;

    const [messages, byDay, byHour, newContacts, resolved, conversations] = await Promise.all([
      this.prisma.$queryRaw<{ channelId: number; conversationId: number; direction: string; origin: string; userId: number | null; n: bigint }[]>`
        SELECT "channelId", "conversationId", direction, origin, "sentByUserId" AS "userId", COUNT(*)::bigint AS n FROM "Chat_Message"
        WHERE "companyId" = ${actor.companyId} AND "channelId" IN (${idList}) AND direction IN ('in', 'out') AND origin <> 'history' AND status <> 'failed' AND "sentAt" >= ${from}
        GROUP BY 1, 2, 3, 4, 5`,
      this.prisma.$queryRaw<{ day: string; inbound: bigint; outbound: bigint }[]>`
        SELECT to_char(("sentAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS day,
               COUNT(*) FILTER (WHERE direction = 'in')::bigint AS inbound, COUNT(*) FILTER (WHERE direction = 'out')::bigint AS outbound
        FROM "Chat_Message" WHERE "companyId" = ${actor.companyId} AND "channelId" IN (${idList}) AND direction IN ('in', 'out') AND origin <> 'history' AND status <> 'failed' AND "sentAt" >= ${from}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ hour: number; n: bigint }[]>`
        SELECT EXTRACT(HOUR FROM ("sentAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::int AS hour, COUNT(*)::bigint AS n
        FROM "Chat_Message" WHERE "companyId" = ${actor.companyId} AND "channelId" IN (${idList}) AND direction = 'in' AND origin <> 'history' AND "sentAt" >= ${from}
        GROUP BY 1`,
      this.prisma.chat_Contact.count({ where: { companyId: actor.companyId, channelId: { in: ids }, hidden: false, firstInboundAt: { gte: from } } }),
      this.prisma.chat_Conversation.count({ where: { companyId: actor.companyId, channelId: { in: ids }, status: 'resolvida', resolvedAt: { gte: from } } }),
      this.prisma.chat_Conversation.findMany({ where: { companyId: actor.companyId, channelId: { in: ids }, OR: [{ lastMessageAt: { gte: from } }, { status: { not: 'resolvida' } }] }, select: { id: true, channelId: true, sector: true, assignedUserId: true, status: true } }),
    ]);

    const convById = new Map(conversations.map((c) => [c.id, c]));
    const channelById = new Map(channels.map((c) => [c.id, c]));
    const sectorOf = (conversationId: number, channelId: number) => convById.get(conversationId)?.sector ?? channelById.get(channelId)?.sector ?? null;
    const waitOf = (t: (typeof turns)[number]) => (t.answered ? Math.max(0, (t.answered.getTime() - t.asked.getTime()) / 1000) : null);
    const isBot = (t: { botId: number | null; origin: string | null }) => !!t.botId || t.origin === 'bot';

    const summarize = (list: typeof turns) => {
      const waits = list.map(waitOf).filter((w): w is number => w !== null);
      const human = list.filter((t) => t.answered && !isBot(t)).map(waitOf) as number[];
      return {
        turns: list.length, answered: waits.length, unanswered: list.length - waits.length,
        medianSec: median(waits), avgSec: avg(waits), humanMedianSec: median(human),
        within5m: pct(waits.filter((w) => w <= 300).length, list.length), within1h: pct(waits.filter((w) => w <= 3600).length, list.length),
        byBot: list.filter((t) => t.answered && isBot(t)).length,
      };
    };

    // totais
    let inbound = 0, outHuman = 0, outBot = 0, outPhone = 0, outAuto = 0;
    const active = new Set<number>();
    const perConv = new Map<number, { inbound: number; outbound: number }>();
    const perUser = new Map<number, { messages: number; conversations: Set<number> }>();
    for (const m of messages) {
      const n = Number(m.n);
      active.add(m.conversationId);
      const c = perConv.get(m.conversationId) ?? { inbound: 0, outbound: 0 };
      if (m.direction === 'in') { inbound += n; c.inbound += n; } else {
        c.outbound += n;
        if (m.origin === 'bot') outBot += n; else if (m.origin === 'auto') outAuto += n; else if (m.origin === 'phone') outPhone += n; else outHuman += n;
        if (m.userId) {
          const u = perUser.get(m.userId) ?? { messages: 0, conversations: new Set<number>() };
          u.messages += n; u.conversations.add(m.conversationId);
          perUser.set(m.userId, u);
        }
      }
      perConv.set(m.conversationId, c);
    }

    // por setor
    const sectors = new Map<string, { conversations: Set<number>; inbound: number; outbound: number; turns: typeof turns }>();
    const sectorKey = (s: string | null) => s ?? 'sem_setor';
    for (const [conversationId, c] of perConv) {
      const conv = convById.get(conversationId);
      const key = sectorKey(sectorOf(conversationId, conv?.channelId ?? 0));
      const entry = sectors.get(key) ?? { conversations: new Set(), inbound: 0, outbound: 0, turns: [] };
      entry.conversations.add(conversationId); entry.inbound += c.inbound; entry.outbound += c.outbound;
      sectors.set(key, entry);
    }
    for (const t of turns) {
      const key = sectorKey(sectorOf(t.conversationId, t.channelId));
      const entry = sectors.get(key) ?? { conversations: new Set(), inbound: 0, outbound: 0, turns: [] };
      entry.turns.push(t);
      sectors.set(key, entry);
    }
    const openNow = conversations.filter((c) => c.status !== 'resolvida');
    const bySector = [...sectors.entries()].map(([key, e]) => {
      const fr = summarize(e.turns);
      return {
        sector: key === 'sem_setor' ? null : key, name: SECTORS.find((s) => s.id === key)?.name ?? 'Sem setor',
        conversations: e.conversations.size, inbound: e.inbound, outbound: e.outbound,
        open: openNow.filter((c) => sectorKey(c.sector ?? channelById.get(c.channelId)?.sector ?? null) === key).length,
        medianSec: fr.medianSec, within1h: fr.within1h, unanswered: fr.unanswered,
      };
    }).sort((a, b) => b.conversations - a.conversations);

    // por atendente (quem deu a 1ª resposta e quantas mensagens mandou)
    const firstByUser = new Map<number, number[]>();
    for (const t of turns) if (t.answered && t.userId && !isBot(t)) firstByUser.set(t.userId, [...(firstByUser.get(t.userId) ?? []), waitOf(t)!]);
    const userIds = [...new Set([...perUser.keys(), ...firstByUser.keys(), ...openNow.map((c) => c.assignedUserId).filter((u): u is number => !!u)])];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds }, companyId: actor.companyId }, select: { id: true, name: true, imageUrl: true } as any }) as unknown as { id: number; name: string; imageUrl: string | null }[] : [];
    const byUser = users.map((u) => {
      const waits = firstByUser.get(u.id) ?? [];
      return {
        userId: u.id, name: u.name, imageUrl: u.imageUrl ?? null,
        messages: perUser.get(u.id)?.messages ?? 0, conversations: perUser.get(u.id)?.conversations.size ?? 0,
        firstResponses: waits.length, medianSec: median(waits),
        open: openNow.filter((c) => c.assignedUserId === u.id).length,
      };
    }).sort((a, b) => b.messages - a.messages || b.open - a.open);

    // por número
    const byChannel = channels.map((ch) => {
      const list = turns.filter((t) => t.channelId === ch.id);
      const fr = summarize(list);
      const msgs = messages.filter((m) => m.channelId === ch.id);
      return {
        channelId: ch.id, name: ch.name, color: ch.color, type: ch.type,
        conversations: new Set(msgs.map((m) => m.conversationId)).size,
        inbound: msgs.filter((m) => m.direction === 'in').reduce((s, m) => s + Number(m.n), 0),
        outbound: msgs.filter((m) => m.direction === 'out').reduce((s, m) => s + Number(m.n), 0),
        medianSec: fr.medianSec, unanswered: fr.unanswered,
      };
    });

    // dias sem mensagem também aparecem no gráfico
    const dayMap = new Map(byDay.map((d) => [d.day, d]));
    const series: { day: string; inbound: number; outbound: number }[] = [];
    for (let t = from.getTime() + 60000; t <= Date.now(); t += DAY) {
      const key = new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
      if (series.some((s) => s.day === key)) continue;
      const row = dayMap.get(key);
      series.push({ day: key, inbound: Number(row?.inbound ?? 0), outbound: Number(row?.outbound ?? 0) });
    }
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, inbound: Number(byHour.find((h) => h.hour === hour)?.n ?? 0) }));

    return {
      days, from,
      channels: channels.map((c) => ({ id: c.id, name: c.name })),
      totals: { conversations: active.size, newContacts, inbound, outbound: outHuman + outBot + outPhone + outAuto, outHuman, outBot, outPhone, outAuto, resolved, open: openNow.length, waiting: openNow.filter((c) => c.status === 'aberta' && !c.assignedUserId).length },
      firstResponse: summarize(turns),
      bySector, byUser, byChannel, byDay: series, byHour: hours,
    };
  }
}
