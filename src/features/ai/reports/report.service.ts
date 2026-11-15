import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Ai_Schedule, Prisma } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { AgentService } from '../engine/agent.service';
import { UsageService } from '../engine/usage.service';
import { frontUrl } from '../mcp/mcp-oauth.service';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { ToolContext } from '../tools/tool.types';
import { Delivery, NotifyService } from './notify.service';
import { EVENT_DETECTORS, EventOccurrence } from './events';

export interface ReportActor { userId: number; companyId: number; permissions: string[] }

/** Relatórios de dados: montados direto das ferramentas, sem IA (custo zero de modelo). */
export const DATA_REPORTS: Record<string, { name: string; description: string }> = {
  agenda_do_dia: { name: 'Agenda do dia', description: 'Pendências da esteira, OS agendadas e em execução, retornos de hoje e turmas da semana.' },
  comercial_semana: { name: 'Comercial da semana', description: 'Funil por situação, propostas vencidas e retornos atrasados.' },
  documentos_vencendo: { name: 'Documentos vencendo', description: 'Documentos da equipe vencidos, a vencer e faltando.' },
  resultado_obras: { name: 'Resultado das obras', description: 'Orçado × realizado das obras em execução e concluídas.' },
};

const FREQUENCIES = ['once', 'hourly', 'daily', 'weekly', 'monthly', 'event'];
/** Quantas tarefas ativas cada pessoa pode ter (quem configura os bots não tem limite). */
const MAX_OWN_TASKS = 15;
const CHANNELS = ['system', 'email', 'whatsapp'];
const brl = (value: unknown) => Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10).split('-').reverse().join('/') : '—');

/**
 * Próxima execução no horário de Brasília (UTC-3, sem horário de verão).
 * once: no runAt; hourly: a cada N horas entre 08:00 e 18:00 de segunda a sexta;
 * daily: todo dia na hora; weekly: nos dias da semana (1 = segunda); monthly:
 * no dia do mês (1–28); event: o detector roda a cada minuto (nextRunAt = agora).
 */
export function nextRun(schedule: Pick<Ai_Schedule, 'frequency' | 'time' | 'dayOfWeek' | 'dayOfMonth'> & Partial<Pick<Ai_Schedule, 'runAt' | 'daysOfWeek' | 'everyHours'>>, after = new Date()): Date | null {
  if (schedule.frequency === 'once') return schedule.runAt && schedule.runAt > after ? schedule.runAt : null;
  if (schedule.frequency === 'event') return after;
  const local = new Date(after.getTime() - 3 * 3600000);
  if (schedule.frequency === 'hourly') {
    const every = Math.min(10, Math.max(1, Number(schedule.everyHours) || 2));
    for (let add = 0; add <= 8; add++) {
      const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + add));
      const weekday = day.getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      for (let hour = 8; hour <= 18; hour += every) {
        const utc = new Date(day.getTime() + (hour + 3) * 3600000);
        if (utc > after) return utc;
      }
    }
    return null;
  }
  const [hour, minute] = schedule.time.split(':').map(Number);
  const days = Array.isArray(schedule.daysOfWeek) && (schedule.daysOfWeek as number[]).length ? (schedule.daysOfWeek as number[]) : [schedule.dayOfWeek ?? 1];
  for (let add = 0; add <= 62; add++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + add, hour, minute));
    const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    const fits = schedule.frequency === 'daily'
      || (schedule.frequency === 'weekly' && days.includes(weekday))
      || (schedule.frequency === 'monthly' && day.getUTCDate() === (schedule.dayOfMonth ?? 1));
    const utc = new Date(day.getTime() + 3 * 3600000);
    if (fits && utc > after) return utc;
  }
  throw new Error('Não foi possível calcular a próxima execução');
}

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ToolCatalogService,
    private readonly agent: AgentService,
    private readonly usage: UsageService,
    private readonly notify: NotifyService,
  ) {}

  // ---------------------------------------------------------------- cadastro

  /** Quem configura os bots vê a agenda da empresa toda; os demais, só as tarefas que criaram. */
  private admin(actor: ReportActor) { return actor.permissions.includes('update_bots'); }

  async list(actor: ReportActor) {
    const rows = await this.prisma.ai_Schedule.findMany({ where: { companyId: actor.companyId, inactiveAt: null, ...(this.admin(actor) ? {} : { ownerUserId: actor.userId }) }, orderBy: { id: 'asc' } });
    const users = this.admin(actor)
      ? await this.prisma.user.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, select: { id: true, name: true, phone: true, email: true }, orderBy: { name: 'asc' } })
      : await this.prisma.user.findMany({ where: { id: actor.userId }, select: { id: true, name: true, phone: true, email: true } });
    const bots = await this.prisma.ai_Bot.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, select: { id: true, name: true, persona: true, role: true, avatar: true, key: true, permissionKey: true }, orderBy: { id: 'asc' } });
    const owners = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.ownerUserId))] } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]));
    return {
      schedules: rows.map((row) => ({ ...this.present(row), owner: owners.get(row.ownerUserId) ?? null, mine: row.ownerUserId === actor.userId })),
      reports: Object.entries(DATA_REPORTS).map(([key, value]) => ({ key, ...value })),
      events: Object.entries(EVENT_DETECTORS).map(([key, value]) => ({ key, label: value.label, description: value.description, params: value.params ?? [] })),
      users: users.map((user) => ({ id: user.id, name: user.name, hasPhone: !!user.phone, hasEmail: !!user.email })),
      bots: bots.filter((bot) => actor.permissions.includes(bot.permissionKey)).map((bot) => ({ id: bot.id, name: bot.persona ? `${bot.persona} · ${bot.name}` : bot.name, persona: bot.persona ?? bot.name, role: bot.role, avatar: bot.avatar ?? bot.key })),
      channels: { system: true, email: this.notify.emailReady(), whatsapp: this.notify.whatsappReady() },
      admin: this.admin(actor),
    };
  }

  private present(row: Ai_Schedule) {
    return {
      id: row.id, name: row.name, kind: row.kind, report: row.report, botId: row.botId, prompt: row.prompt, frequency: row.frequency, time: row.time,
      dayOfWeek: row.dayOfWeek, dayOfMonth: row.dayOfMonth, daysOfWeek: row.daysOfWeek ?? [], everyHours: row.everyHours, runAt: row.runAt,
      eventType: row.eventType, eventParams: row.eventParams ?? {}, eventLabel: row.eventType ? EVENT_DETECTORS[row.eventType]?.label ?? row.eventType : null,
      channels: row.channels, recipients: row.recipients, active: row.active, lastRunAt: row.lastRunAt, nextRunAt: row.nextRunAt,
      lastStatus: row.lastStatus, lastReportId: row.lastReportId, failures: row.failures, pausedReason: row.pausedReason, maxRunsPerDay: row.maxRunsPerDay, ownerUserId: row.ownerUserId,
    };
  }

  parse(actor: ReportActor, body: Record<string, any>, current?: Ai_Schedule) {
    const merged = { ...(current ?? {}), ...body } as Record<string, any>;
    const name = String(merged.name ?? '').trim().slice(0, 120);
    if (name.length < 3) throw new BadRequestException('Dê um nome para a tarefa');
    const kind = merged.kind === 'ai' ? 'ai' : 'data';
    if (kind === 'data' && !DATA_REPORTS[merged.report]) throw new BadRequestException('Escolha o relatório');
    const prompt = kind === 'ai' ? String(merged.prompt ?? '').trim().slice(0, 4000) : null;
    if (kind === 'ai' && (!prompt || prompt.length < 10)) throw new BadRequestException('Escreva o que o assistente deve fazer');
    if (kind === 'ai' && !(Number(merged.botId) > 0)) throw new BadRequestException('Escolha o assistente');
    const frequency = String(merged.frequency);
    if (!FREQUENCIES.includes(frequency)) throw new BadRequestException('Escolha quando a tarefa roda');
    if (frequency === 'event' && kind !== 'ai') throw new BadRequestException('Gatilho por evento só para tarefa de assistente');
    const time = String(merged.time ?? '07:00');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BadRequestException('Horário inválido');
    let runAt: Date | null = null;
    if (frequency === 'once') {
      runAt = merged.runAt ? new Date(merged.runAt) : null;
      if (!runAt || Number.isNaN(runAt.getTime())) throw new BadRequestException('Informe a data e a hora');
      if (runAt <= new Date()) throw new BadRequestException('A data e a hora precisam estar no futuro');
    }
    const daysOfWeek = frequency === 'weekly'
      ? [...new Set((Array.isArray(merged.daysOfWeek) && merged.daysOfWeek.length ? merged.daysOfWeek : [merged.dayOfWeek]).map(Number).filter((day: number) => day >= 1 && day <= 7))].sort()
      : null;
    if (frequency === 'weekly' && !daysOfWeek!.length) throw new BadRequestException('Escolha os dias da semana');
    const dayOfMonth = frequency === 'monthly' ? Number(merged.dayOfMonth) : null;
    if (frequency === 'monthly' && !(dayOfMonth! >= 1 && dayOfMonth! <= 28)) throw new BadRequestException('Escolha o dia do mês (1 a 28)');
    const everyHours = frequency === 'hourly' ? Number(merged.everyHours) : null;
    if (frequency === 'hourly' && !(everyHours! >= 1 && everyHours! <= 10)) throw new BadRequestException('A cada quantas horas? (1 a 10)');
    const eventType = frequency === 'event' ? String(merged.eventType ?? '') : null;
    if (frequency === 'event' && !EVENT_DETECTORS[eventType!]) throw new BadRequestException('Escolha o evento');
    const eventParams = frequency === 'event' && merged.eventParams && typeof merged.eventParams === 'object' ? merged.eventParams : null;
    const channels = (Array.isArray(merged.channels) ? merged.channels : ['system']).filter((channel: string) => CHANNELS.includes(channel));
    if (!channels.length) throw new BadRequestException('Escolha ao menos um canal');
    // sem ninguém escolhido, quem configura recebe; quem não configura bots só agenda para si
    let recipients = [...new Set((Array.isArray(merged.recipients) && merged.recipients.length ? merged.recipients : [actor.userId]).map(Number).filter((id: number) => id > 0))].slice(0, 30);
    if (!this.admin(actor)) recipients = [actor.userId];
    const maxRunsPerDay = Math.min(48, Math.max(1, Number(merged.maxRunsPerDay) || 12));
    return {
      name, kind, report: kind === 'data' ? merged.report : null, botId: kind === 'ai' ? Number(merged.botId) : null, prompt,
      frequency, time, runAt, daysOfWeek, dayOfWeek: daysOfWeek?.[0] ?? null, dayOfMonth, everyHours, eventType, eventParams, maxRunsPerDay,
      channels, recipients, active: merged.active !== false && merged.active !== 'false',
    };
  }

  private async assertRefs(actor: ReportActor, data: { botId: number | null; recipients: number[] }) {
    if (data.botId) {
      const bot = await this.prisma.ai_Bot.findFirst({ where: { id: data.botId, companyId: actor.companyId, inactiveAt: null }, select: { permissionKey: true } });
      if (!bot) throw new BadRequestException('Assistente não encontrado');
      if (!actor.permissions.includes(bot.permissionKey)) throw new BadRequestException('Você não tem acesso a este assistente');
    }
    const found = await this.prisma.user.count({ where: { id: { in: data.recipients }, companyId: actor.companyId, inactiveAt: null } });
    if (found !== data.recipients.length) throw new BadRequestException('Destinatário não encontrado');
  }

  private async owned(actor: ReportActor, id: number) {
    const row = await this.prisma.ai_Schedule.findFirst({ where: { id, companyId: actor.companyId, inactiveAt: null, ...(this.admin(actor) ? {} : { ownerUserId: actor.userId }) } });
    if (!row) throw new NotFoundException('Tarefa não encontrada');
    return row;
  }

  private dataFor(data: ReturnType<ReportService['parse']>) {
    return {
      ...data, daysOfWeek: data.daysOfWeek ?? Prisma.DbNull, eventParams: data.eventParams ?? Prisma.DbNull,
      nextRunAt: data.active ? nextRun(data as unknown as Ai_Schedule) : null,
    };
  }

  async create(actor: ReportActor, body: Record<string, any>) {
    const data = this.parse(actor, body);
    await this.assertRefs(actor, data);
    if (!this.admin(actor)) {
      const mine = await this.prisma.ai_Schedule.count({ where: { companyId: actor.companyId, ownerUserId: actor.userId, inactiveAt: null, active: true } });
      if (mine >= MAX_OWN_TASKS) throw new BadRequestException(`Você já tem ${MAX_OWN_TASKS} tarefas ativas: pause ou remova alguma`);
    }
    const row = await this.prisma.ai_Schedule.create({
      data: { ...this.dataFor(data), companyId: actor.companyId, ownerUserId: actor.userId, eventCursor: data.frequency === 'event' ? new Date() : null } as Prisma.Ai_ScheduleUncheckedCreateInput,
    });
    return this.present(row);
  }

  async update(actor: ReportActor, id: number, body: Record<string, any>) {
    const current = await this.owned(actor, id);
    const data = this.parse(actor, body, current);
    await this.assertRefs(actor, data);
    // quem altera passa a ser o dono: a tarefa usa as permissões dele; reativar zera as falhas
    const row = await this.prisma.ai_Schedule.update({
      where: { id },
      data: {
        ...this.dataFor(data), ownerUserId: actor.userId, failures: 0, pausedReason: null,
        ...(data.frequency === 'event' && current.frequency !== 'event' ? { eventCursor: new Date(), firedKeys: [] } : {}),
      } as Prisma.Ai_ScheduleUncheckedUpdateInput,
    });
    return this.present(row);
  }

  async setActive(actor: ReportActor, id: number, active: boolean) {
    const current = await this.owned(actor, id);
    const row = await this.prisma.ai_Schedule.update({
      where: { id },
      data: { active, failures: active ? 0 : current.failures, pausedReason: active ? null : 'Pausada por você', nextRunAt: active ? nextRun(current) : null, ...(active && current.frequency === 'event' ? { eventCursor: new Date() } : {}) },
    });
    return this.present(row);
  }

  async remove(actor: ReportActor, id: number) {
    await this.owned(actor, id);
    await this.prisma.ai_Schedule.update({ where: { id }, data: { inactiveAt: new Date(), active: false, nextRunAt: null } });
    return { removed: true };
  }

  // ---------------------------------------------------------------- relatórios gerados

  async reports(actor: ReportActor, query: Record<string, string>) {
    const page = Math.max(0, Number(query.page) || 0);
    const where: Prisma.Ai_ReportWhereInput = { companyId: actor.companyId, ...(Number(query.scheduleId) > 0 ? { scheduleId: Number(query.scheduleId) } : {}) };
    const rows = await this.prisma.ai_Report.findMany({ where, orderBy: { id: 'desc' }, skip: page * 30, take: 30, select: { id: true, title: true, scheduleId: true, createdAt: true, deliveries: true } });
    // cada um só vê os relatórios em que é destinatário (ou todos, quem configura)
    const visible = actor.permissions.includes('update_bots') ? rows : rows.filter((row) => ((row.deliveries as unknown as Delivery[]) ?? []).some((item) => item.userId === actor.userId));
    return visible;
  }

  async report(actor: ReportActor, id: number) {
    const row = await this.prisma.ai_Report.findFirst({ where: { id, companyId: actor.companyId } });
    if (!row) throw new NotFoundException('Relatório não encontrado');
    const mine = ((row.deliveries as unknown as Delivery[]) ?? []).some((item) => item.userId === actor.userId);
    if (!mine && !actor.permissions.includes('update_bots')) throw new NotFoundException('Relatório não encontrado');
    return { id: row.id, title: row.title, body: row.body, createdAt: row.createdAt, deliveries: row.deliveries };
  }

  // ---------------------------------------------------------------- execução

  /** A cada minuto: roda os agendamentos vencidos. Desligado na suíte de testes. */
  @Cron('0 * * * * *')
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || process.env.AI_SCHEDULES_ENABLED === 'false') return;
    await this.runDue().catch((error) => console.error('[ai] agendamentos falharam', error));
  }

  async runDue(now = new Date()): Promise<number> {
    const due = await this.prisma.ai_Schedule.findMany({ where: { active: true, inactiveAt: null, nextRunAt: { lte: now } }, take: 30, orderBy: { nextRunAt: 'asc' } });
    let ran = 0;
    for (const schedule of due) {
      const next = schedule.frequency === 'event' ? new Date(now.getTime() + 60000) : nextRun(schedule, now);
      // trava pelo próprio nextRunAt: duas instâncias não rodam o mesmo agendamento
      const claimed = await this.prisma.ai_Schedule.updateMany({ where: { id: schedule.id, nextRunAt: schedule.nextRunAt }, data: { nextRunAt: next, ...(schedule.frequency === 'once' ? { active: false } : {}) } });
      if (!claimed.count) continue;
      try {
        if (schedule.frequency === 'event') {
          if (await this.runEvent(schedule, now)) ran++;
        } else if (await this.guard(schedule, now)) {
          await this.execute(schedule);
          ran++;
        }
      } catch (error) {
        console.error(`[ai] tarefa ${schedule.id} falhou`, error);
      }
    }
    return ran;
  }

  /** Limite por dia: passou, pula até amanhã. */
  private async guard(schedule: Ai_Schedule, now: Date): Promise<boolean> {
    const day = new Date(now.getTime() - 3 * 3600000).toISOString().slice(0, 10);
    const today = schedule.runsDay === day ? schedule.runsToday : 0;
    if (today >= schedule.maxRunsPerDay) return false;
    await this.prisma.ai_Schedule.update({ where: { id: schedule.id }, data: { runsDay: day, runsToday: today + 1 } });
    return true;
  }

  /** Gatilho por evento: o que aconteceu desde o cursor e ainda não disparou vai num pedido só. */
  private async runEvent(schedule: Ai_Schedule, now: Date): Promise<boolean> {
    const detector = EVENT_DETECTORS[schedule.eventType ?? ''];
    if (!detector) return false;
    const since = schedule.eventCursor ?? new Date(now.getTime() - 3600000);
    const fired = new Set(((schedule.firedKeys as string[]) ?? []));
    const found = await detector.detect(this.prisma, schedule.companyId, since, (schedule.eventParams as Record<string, any>) ?? {});
    const fresh = found.filter((item) => !fired.has(item.key));
    const cursor = found.reduce((max, item) => (item.at > max && item.at <= now ? item.at : max), since);
    if (!fresh.length) {
      if (cursor > since) await this.prisma.ai_Schedule.update({ where: { id: schedule.id }, data: { eventCursor: cursor } });
      return false;
    }
    if (!(await this.guard(schedule, now))) return false;
    const keys = [...fired, ...fresh.map((item) => item.key)].slice(-500);
    await this.prisma.ai_Schedule.update({ where: { id: schedule.id }, data: { eventCursor: cursor, firedKeys: keys } });
    await this.execute(schedule, fresh);
    return true;
  }

  /** Roda uma tarefa agora (botão "Rodar agora"). */
  async runNow(actor: ReportActor, id: number) {
    const schedule = await this.owned(actor, id);
    if (schedule.frequency === 'event') {
      const detector = EVENT_DETECTORS[schedule.eventType ?? ''];
      const sample = detector ? (await detector.detect(this.prisma, schedule.companyId, new Date(Date.now() - 7 * 86400000), (schedule.eventParams as Record<string, any>) ?? {})).slice(0, 5) : [];
      const report = await this.execute(schedule, sample.length ? sample : [{ key: 'teste', at: new Date(), text: 'Teste manual: nenhum evento recente encontrado. Diga o que você faria quando o evento acontecer.' }]);
      return { id: report.id, title: report.title };
    }
    const report = await this.execute(schedule);
    return { id: report.id, title: report.title };
  }

  private async execute(schedule: Ai_Schedule, events?: EventOccurrence[]) {
    const owner = await this.prisma.user.findFirst({
      where: { id: schedule.ownerUserId, companyId: schedule.companyId, inactiveAt: null, active: true },
      select: { id: true, permissions: { where: { inactiveAt: null }, select: { permission: { select: { name: true } } } }, profile: { select: { permissions: { where: { inactiveAt: null }, select: { permission: { select: { name: true } } } } } } },
    });
    const date = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const title = `${schedule.name} — ${br(date)}`;
    let body: string;
    let cost = 0;
    let status: 'ok' | 'falhou' = 'ok';
    let pendingCount = 0;
    if (!owner) {
      body = 'O usuário dono desta tarefa não está mais ativo. Alguém precisa salvar a tarefa de novo.';
      status = 'falhou';
    } else {
      const permissions = [...new Set([...owner.permissions.map((item) => item.permission.name), ...(owner.profile?.permissions ?? []).map((item) => item.permission.name)])];
      const ctx: ToolContext = { userId: owner.id, companyId: schedule.companyId, permissions, origin: 'schedule' };
      if (schedule.kind === 'ai') {
        const bot = await this.prisma.ai_Bot.findFirst({ where: { id: schedule.botId ?? 0, companyId: schedule.companyId, inactiveAt: null } });
        if (!bot) { body = 'O assistente desta tarefa não existe mais.'; status = 'falhou'; }
        else if (!permissions.includes(bot.permissionKey)) { body = `O dono da tarefa não tem mais acesso a ${bot.persona ?? bot.name}.`; status = 'falhou'; }
        else if (await this.usage.overBudget(schedule.companyId)) { body = 'Tarefa não executada: o teto mensal de gasto com IA foi atingido.'; status = 'falhou'; }
        else {
          const conversation = await this.prisma.ai_Conversation.create({ data: { companyId: schedule.companyId, userId: owner.id, botId: bot.id, title, origin: 'schedule' } });
          const context = events?.length
            ? `\n\nO que aconteceu (gatilho "${EVENT_DETECTORS[schedule.eventType ?? '']?.label ?? schedule.eventType}"):\n${events.map((item) => `- ${item.text}`).join('\n')}`
            : '';
          try {
            const out = await this.agent.sendAndWait(ctx, bot, conversation.id,
              `${schedule.prompt}${context}\n\n(Tarefa agendada, sem ninguém acompanhando agora: faça o que der com as ferramentas, não faça perguntas, e termine com um resumo curto em markdown do que foi feito e do que ficou esperando confirmação.)`);
            body = out.text || 'O assistente não devolveu texto.';
            cost = out.costUsd;
            pendingCount = await this.prisma.ai_PendingAction.count({ where: { conversationId: conversation.id, confirmedAt: null, cancelledAt: null } });
            if (pendingCount) body += `\n\n**${pendingCount} ação(ões) esperando a sua confirmação** em [Ações pendentes](/bots/acoes).`;
          } catch (error) {
            body = `Não foi possível concluir a tarefa: ${(error as Error).message}`;
            status = 'falhou';
          }
        }
      } else {
        body = await this.dataReport(ctx, schedule.report ?? '');
      }
    }
    const report = await this.prisma.ai_Report.create({ data: { companyId: schedule.companyId, scheduleId: schedule.id, title, body, costUsd: cost } });
    const deliveries = await this.deliver(schedule, report.id, title, body);
    await this.prisma.ai_Report.update({ where: { id: report.id }, data: { deliveries: deliveries as unknown as Prisma.InputJsonValue } });
    // três falhas seguidas: pausa e avisa no próprio cadastro
    const failures = status === 'falhou' ? schedule.failures + 1 : 0;
    await this.prisma.ai_Schedule.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: new Date(), lastStatus: status, lastReportId: report.id, failures,
        ...(failures >= 3 ? { active: false, nextRunAt: null, pausedReason: 'Pausada depois de 3 falhas seguidas. Veja o último relatório e reative.' } : {}),
      },
    });
    return report;
  }

  private async deliver(schedule: Ai_Schedule, reportId: number, title: string, body: string): Promise<Delivery[]> {
    const users = await this.prisma.user.findMany({ where: { id: { in: (schedule.recipients as number[]) ?? [] }, companyId: schedule.companyId, inactiveAt: null }, select: { id: true, email: true, phone: true } });
    const link = `${frontUrl()}/bots/relatorios/${reportId}`;
    const out: Delivery[] = [];
    for (const user of users) {
      for (const channel of (schedule.channels as string[]) ?? []) {
        if (channel === 'system') { out.push({ channel, userId: user.id, status: 'enviado' }); continue; }
        try {
          if (channel === 'email') {
            if (!user.email) { out.push({ channel, userId: user.id, status: 'pulado', error: 'sem e-mail' }); continue; }
            await this.notify.sendEmail(user.email, title, title, body, link);
          } else if (channel === 'whatsapp') {
            if (!user.phone) { out.push({ channel, userId: user.id, status: 'pulado', error: 'sem telefone' }); continue; }
            await this.notify.sendWhatsapp(user.phone, title, link);
          }
          out.push({ channel, userId: user.id, status: 'enviado' });
        } catch (error) {
          out.push({ channel, userId: user.id, status: 'falhou', error: String((error as Error).message).slice(0, 300) });
        }
      }
    }
    return out;
  }

  /** Monta o relatório de dados chamando as ferramentas (com auditoria e as permissões do dono). */
  async dataReport(ctx: ToolContext, report: string): Promise<string> {
    const get = async (tool: string, input: Record<string, unknown> = {}) => {
      const outcome = await this.catalog.call(ctx, tool, input, null);
      if (outcome.status === 'denied') return { _semPermissao: true } as any;
      try { return JSON.parse(outcome.content); } catch { return {}; }
    };
    const noAccess = (data: any, area: string) => (data?._semPermissao ? `_Sem permissão para ver ${area}._\n` : null);
    const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const lines: string[] = [];

    if (report === 'agenda_do_dia') {
      const esteira = await get('minha_esteira');
      lines.push('## Pendências');
      const blocks = (esteira.blocos ?? []).filter((block: any) => block.quantidade > 0);
      if (!blocks.length) lines.push('Nada pendente na esteira.');
      for (const block of blocks) lines.push(`- **${block.titulo}** (${block.area}): ${block.quantidade}${block.total ? ` · ${brl(block.total)}` : ''}`);
      const execucao = await get('listar_os', { etapa: 'em_execucao' });
      const agendadas = await get('listar_os', { etapa: 'agendada' });
      lines.push('\n## Obras');
      lines.push(noAccess(execucao, 'as OS') ?? '');
      for (const os of execucao.ordens ?? []) lines.push(`- Em execução: **${os.numero}** ${os.titulo} — ${os.cliente ?? ''}`);
      const starting = (agendadas.ordens ?? []).filter((item: any) => item.inicioPrevisto && item.inicioPrevisto <= today);
      for (const os of starting) lines.push(`- Começa hoje ou atrasada: **${os.numero}** ${os.titulo} (${br(os.inicioPrevisto)})`);
      if (!execucao._semPermissao && !(execucao.ordens ?? []).length && !starting.length) lines.push('Nenhuma obra em execução ou começando hoje.');
      const retornos = await get('listar_acompanhamentos', { situacao: 'hoje' });
      const atrasados = await get('listar_acompanhamentos', { situacao: 'atrasadas' });
      lines.push('\n## Retornos com clientes');
      lines.push(noAccess(retornos, 'o comercial') ?? `Hoje: ${retornos.total ?? 0} · Atrasados: ${atrasados.total ?? 0}`);
      for (const item of [...(atrasados.itens ?? []).slice(0, 10), ...(retornos.itens ?? []).slice(0, 10)]) lines.push(`- ${item.assunto} — ${item.cliente ?? ''} (${br(item.marcadoPara)}${item.hora ? ` ${item.hora}` : ''})`);
      const turmas = await get('listar_turmas');
      lines.push('\n## Turmas nos próximos 7 dias');
      const limit = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const soon = (turmas.turmas ?? []).filter((turma: any) => turma.inicio && turma.inicio <= limit);
      lines.push(noAccess(turmas, 'as turmas') ?? (soon.length ? '' : 'Nenhuma.'));
      for (const turma of soon) lines.push(`- ${turma.nome} (${br(turma.inicio)}): ${turma.inscritosConfirmados} inscritos / ${turma.vagas} vagas`);
    } else if (report === 'comercial_semana') {
      const propostas = await get('listar_propostas');
      if (propostas._semPermissao) return '_Sem permissão para ver o comercial._';
      lines.push('## Funil por situação');
      for (const [status, info] of Object.entries(propostas.resumoPorSituacao ?? {}) as [string, any][]) lines.push(`- ${status}: ${info.count} · ${brl(info.total)}`);
      const vencidas = (propostas.propostas ?? []).filter((item: any) => item.vencida);
      lines.push('\n## Propostas enviadas com validade vencida');
      lines.push(vencidas.length ? '' : 'Nenhuma.');
      for (const item of vencidas) lines.push(`- ${item.numero} — ${item.cliente} · ${brl(item.total)} (validade ${br(item.validade)})`);
      const atrasados = await get('listar_acompanhamentos', { situacao: 'atrasadas' });
      lines.push(`\n## Retornos atrasados: ${atrasados.total ?? 0}`);
      for (const item of (atrasados.itens ?? []).slice(0, 20)) lines.push(`- ${item.assunto} — ${item.cliente ?? ''} (${br(item.marcadoPara)}) · ${item.responsavel ?? ''}`);
    } else if (report === 'documentos_vencendo') {
      const docs = await get('documentos_vencendo');
      if (docs._semPermissao) return '_Sem permissão para ver os documentos da equipe._';
      lines.push(`Vencidos: ${docs.resumo?.vencido ?? 0} · A vencer: ${docs.resumo?.a_vencer ?? 0} · Faltando: ${docs.resumo?.faltando ?? 0}\n`);
      for (const status of ['vencido', 'a_vencer', 'faltando']) {
        const rows = (docs.documentos ?? []).filter((row: any) => row.situacao === status);
        if (!rows.length) continue;
        lines.push(`## ${{ vencido: 'Vencidos', a_vencer: 'A vencer', faltando: 'Faltando' }[status]}`);
        for (const row of rows) lines.push(`- ${row.funcionario}: ${row.documento}${row.vence ? ` (${br(row.vence)})` : ''}`);
      }
    } else if (report === 'resultado_obras') {
      const execucao = await get('resultado_obras', { etapa: 'em_execucao' });
      if (execucao._semPermissao) return '_Sem permissão para ver as OS._';
      const concluidas = await get('resultado_obras', { etapa: 'concluida' });
      const pct = (value: unknown) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—');
      const table = (title: string, data: any) => {
        lines.push(`## ${title}`);
        if (!(data.obras ?? []).length) { lines.push('Nenhuma obra.'); return; }
        lines.push('| OS | Cliente | Receita orçada | Lucro orçado | Lucro projetado | Margem projetada |', '|---|---|---|---|---|---|');
        for (const obra of data.obras) lines.push(`| ${obra.numero} | ${obra.cliente ?? ''} | ${brl(obra.orcado?.receita)} | ${obra.orcado?.lucro === undefined ? '—' : brl(obra.orcado.lucro)} | ${obra.projetado?.lucro === undefined ? '—' : brl(obra.projetado.lucro)} | ${pct(obra.projetado?.margem)} |`);
        if (data.totais?.abaixoDoOrcado) lines.push(`\n**${data.totais.abaixoDoOrcado} obra(s) caminhando para fechar abaixo do orçado.**`);
      };
      table('Em execução', execucao);
      lines.push('');
      table('Concluídas', concluidas);
    } else {
      return 'Relatório desconhecido.';
    }
    return lines.filter((line) => line !== '').join('\n');
  }
}
