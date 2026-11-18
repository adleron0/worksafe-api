import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Service_DailyReport, Service_Order } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { recordFlowEvent } from 'src/common/flow/flow';
import type { PricingSnapshot } from 'src/features/commercial/commercial.service';
import { computeBase, professionalCost } from 'src/features/commercial/pricing/engine';
import { OrderActor, ordersVisibleTo } from './service-order.service';

/**
 * RDO — relatório diário de obra.
 *
 * O encarregado registra o dia: quem trabalhou e quantas horas, o que foi
 * feito, o avanço de cada etapa do cronograma, ocorrências e fotos. Disso
 * saem, sem ninguém calcular: o avanço físico da OS, as horas realizadas
 * contra as orçadas e o custo de mão de obra (horas × custo hora da base de
 * cálculo usada na proposta).
 */
type Body = Record<string, any>;

export const REPORT_SHIFTS = ['integral', 'manha', 'tarde', 'noite'] as const;
export const REPORT_WEATHERS = ['bom', 'nublado', 'chuva', 'impraticavel'] as const;
export const OCCURRENCE_TYPES = ['paralisacao', 'pendencia_cliente', 'quase_acidente', 'acidente', 'outro'] as const;
const SHIFT_LABEL: Record<string, string> = { integral: 'Dia inteiro', manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };

/** `in`/`out` só aparecem quando a pessoa entrou ou saiu em hora diferente da do dia; `leaveReason` explica a saída antecipada. */
/** `employeeId` e `professionalId` ligam a pessoa e a função ao cadastro; sem eles vale o texto, como antes. */
export interface CrewMember { name: string; role: string; hours: number; overtime: number; in?: string | null; out?: string | null; leaveReason?: string | null; employeeId?: number | null; professionalId?: number | null }
export const SITE_CONDITIONS = ['normal', 'restricao', 'impedido'] as const;
export interface StepProgress { step: number; title: string; percent: number }
export interface Occurrence { type: string; description: string; hoursLost: number }
export interface Photo { url: string; caption: string }
interface ScheduleShape { unit?: string; steps?: Array<{ title: string; start: number; duration: number }> }
interface ScopeShape { items: Array<{ type: string; description: string; quantity: number; workDays: number | null; hoursPerDay: number | null; overtimeHours: number }> }

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const text = (value: unknown, max = 10000) => String(value ?? '').trim().slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86400000);
const norm = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
function dateOf(value: unknown, label: string): string {
  const raw = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(String(value ?? '').trim())?.[1] ?? '';
  if (!raw || Number.isNaN(asDate(raw).getTime()) || iso(asDate(raw)) !== raw) throw new BadRequestException(`${label}: informe uma data válida`);
  return raw;
}
/** Hora do dia "HH:MM"; vazio vira nulo. */
function timeOf(value: unknown, label: string): string | null {
  if (blank(value)) return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value).trim());
  if (!match) throw new BadRequestException(`${label}: informe a hora no formato 07:30`);
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
/** Minutos entre a entrada e a saída; no turno da noite a saída pode ser no dia seguinte. */
export function spanMinutes(start: string, end: string, overnight: boolean): number {
  const span = minutesOf(end) - minutesOf(start);
  return span <= 0 && overnight ? span + 24 * 60 : span;
}
function hoursOf(value: unknown, label: string, max = 24): number {
  if (blank(value)) return 0;
  const out = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(out) || out < 0 || out > max) throw new BadRequestException(`${label}: informe um número de horas entre 0 e ${max}`);
  return round2(out);
}

@Injectable()
export class DailyReportService {
  constructor(private readonly prisma: PrismaService) {}

  private async orderOf(actor: OrderActor, orderId: number): Promise<Service_Order> {
    const order = await this.prisma.service_Order.findFirst({ where: { id: orderId, companyId: actor.companyId, AND: [await ordersVisibleTo(this.prisma, actor)] } });
    if (!order) throw new NotFoundException('Ordem de serviço não encontrada');
    return order;
  }

  private async byId(companyId: number, id: number): Promise<Service_DailyReport> {
    const row = await this.prisma.service_DailyReport.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException('RDO não encontrado');
    return row;
  }

  // ------------------------------------------------------------------ o que vem da OS e da proposta

  /** Etapas do cronograma planejado, na ordem. */
  private stepsOf(order: Service_Order) {
    return ((order.schedule as ScheduleShape | null)?.steps ?? []).map((step, index) => ({ step: index, title: step.title, start: Number(step.start) || 1, duration: Math.max(1, Number(step.duration) || 1) }));
  }

  /** Funções de mão de obra vendidas (as opções de "função" da equipe do dia). */
  private rolesOf(order: Service_Order): string[] {
    const roles = ((order.scope as unknown as ScopeShape[]) ?? []).flatMap((section) => section.items.filter((item) => item.type === 'mao_de_obra').map((item) => item.description));
    return [...new Set(roles)];
  }

  /** As funções orçadas com o id do cadastro: a tela grava o id junto do nome para o custo casar pelo cadastro. */
  private async roleOptionsOf(order: Service_Order): Promise<Array<{ name: string; professionalId: number | null }>> {
    const labor = await this.laborOf(order);
    return [...labor.byRole.values()].map((entry) => ({ name: entry.role, professionalId: entry.professionalId }));
  }

  /** A equipe do dia só aponta para funcionários e funções desta empresa. */
  private async assertCrewLinks(companyId: number, body: Body): Promise<void> {
    const crew = Array.isArray(body.crew) ? (body.crew as Body[]) : [];
    const ids = (key: string) => [...new Set(crew.map((raw) => Number(raw?.[key])).filter((id) => id > 0))];
    const employeeIds = ids('employeeId');
    const professionalIds = ids('professionalId');
    const [employees, professionals] = await Promise.all([
      employeeIds.length ? this.prisma.hr_Employee.count({ where: { id: { in: employeeIds }, companyId } }) : 0,
      professionalIds.length ? this.prisma.commercial_Professional.count({ where: { id: { in: professionalIds }, companyId } }) : 0,
    ]);
    if (employees !== employeeIds.length) throw new BadRequestException('Pessoa da equipe do dia não encontrada no cadastro de funcionários');
    if (professionals !== professionalIds.length) throw new BadRequestException('Função da equipe do dia não encontrada no cadastro de profissionais');
  }

  /**
   * Mão de obra orçada por função: horas e custo hora, recalculados da fotografia
   * da base de cálculo guardada na proposta (o mesmo número que formou o preço).
   */
  private async laborOf(order: Service_Order) {
    const proposal = await this.prisma.commercial_Proposal.findUnique({
      where: { id: order.proposalId },
      select: { snapshot: true, workDays: true, items: { where: { type: 'mao_de_obra' }, select: { description: true, professionalId: true, quantity: true, workDays: true, hoursPerDay: true, overtimeHours: true } } },
    });
    const byRole = new Map<string, { role: string; professionalId: number | null; budgetHours: number; budgetOvertime: number; hourCost: number; overtimePerHour: number }>();
    // a mesma função, achada pelo cadastro: é por aqui que o custo casa quando a pessoa vem do cadastro de funcionários
    const byProfessional = new Map<number, string>();
    if (!proposal) return { byRole, byProfessional, hoursPerDay: 8 };
    const snapshot = proposal.snapshot as unknown as PricingSnapshot;
    let base: ReturnType<typeof computeBase> | null = null;
    try { base = computeBase(snapshot.params, snapshot.items, snapshot.date); } catch { base = null; }
    const hoursPerDay = Number(snapshot?.params?.hoursPerDay) > 0 ? Number(snapshot.params.hoursPerDay) : 8;
    for (const item of proposal.items) {
      const quantity = Number(item.quantity);
      const hours = quantity * Number(item.workDays ?? proposal.workDays ?? 0) * (item.hoursPerDay === null ? hoursPerDay : Number(item.hoursPerDay) || hoursPerDay);
      const salary = snapshot?.salaries?.[String(item.professionalId)]?.salary;
      const cost = base && salary ? professionalCost(salary, snapshot.params, base) : null;
      const key = norm(item.description);
      const entry = byRole.get(key) ?? { role: item.description, professionalId: item.professionalId ?? null, budgetHours: 0, budgetOvertime: 0, hourCost: cost?.hourCost ?? 0, overtimePerHour: cost?.overtimePerHour ?? 0 };
      if (item.professionalId && !byProfessional.has(item.professionalId)) byProfessional.set(item.professionalId, key);
      entry.budgetHours = round2(entry.budgetHours + hours);
      entry.budgetOvertime = round2(entry.budgetOvertime + Number(item.overtimeHours) * quantity);
      byRole.set(key, entry);
    }
    return { byRole, byProfessional, hoursPerDay };
  }

  // ------------------------------------------------------------------ o que o diário diz da obra

  /** Avanço, horas e custo de mão de obra de uma OS, a partir dos RDOs. */
  async summaryOf(order: Service_Order, canSeeCosts: boolean) {
    const [reports, labor] = await Promise.all([
      this.prisma.service_DailyReport.findMany({ where: { orderId: order.id, inactiveAt: null }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
      this.laborOf(order),
    ]);
    // horas por função
    const hours = new Map<string, { role: string; hours: number; overtime: number; budgetHours: number; budgetOvertime: number; matched: boolean }>();
    for (const entry of labor.byRole.values()) hours.set(norm(entry.role), { role: entry.role, hours: 0, overtime: 0, budgetHours: entry.budgetHours, budgetOvertime: entry.budgetOvertime, matched: true });
    let cost = 0;
    const withoutCost = new Set<string>();
    for (const report of reports) for (const member of (report.crew as unknown as CrewMember[]) ?? []) {
      // casa primeiro pela função do cadastro; sem ela (registro antigo ou pessoa avulsa), pelo nome, como sempre foi
      const key = (member.professionalId ? labor.byProfessional.get(member.professionalId) : undefined) ?? norm(member.role || 'Sem função');
      const row = hours.get(key) ?? { role: member.role || 'Sem função', hours: 0, overtime: 0, budgetHours: 0, budgetOvertime: 0, matched: false };
      row.hours = round2(row.hours + member.hours);
      row.overtime = round2(row.overtime + member.overtime);
      hours.set(key, row);
      const rate = labor.byRole.get(key);
      if (rate && rate.hourCost > 0) cost += member.hours * rate.hourCost + member.overtime * rate.overtimePerHour;
      else if (member.hours + member.overtime > 0) withoutCost.add(row.role);
    }
    const rows = [...hours.values()];
    const total = (key: 'hours' | 'overtime' | 'budgetHours' | 'budgetOvertime') => round2(rows.reduce((sum, row) => sum + row[key], 0));

    // avanço físico: o último percentual informado de cada etapa, pesado pela duração
    const steps = this.stepsOf(order);
    const last = new Map<number, number>();
    for (const report of reports) for (const item of (report.progress as unknown as StepProgress[]) ?? []) last.set(item.step, item.percent);
    const weight = steps.reduce((sum, step) => sum + step.duration, 0);
    const done = weight > 0 ? steps.reduce((sum, step) => sum + step.duration * (last.get(step.step) ?? 0), 0) / weight : null;
    // planejado para hoje (ou para o dia em que terminou), contando do início real
    const unitDays = ({ dia: 1, semana: 7, mes: 30 } as Record<string, number>)[(order.schedule as ScheduleShape | null)?.unit ?? 'dia'] ?? 1;
    const started = iso(order.startedAt);
    let planned: number | null = null;
    if (started && weight > 0) {
      const elapsed = (daysBetween(started, iso(order.finishedAt) ?? today()) + 1) / unitDays;
      planned = steps.reduce((sum, step) => sum + step.duration * Math.min(1, Math.max(0, (elapsed - (step.start - 1)) / step.duration)), 0) / weight * 100;
    }
    const stopped = reports.filter((report) => report.weather === 'impraticavel' || ((report.occurrences as unknown as Occurrence[]) ?? []).some((o) => o.type === 'paralisacao'));
    const hoursLost = round2(reports.reduce((sum, report) => sum + ((report.occurrences as unknown as Occurrence[]) ?? []).reduce((s, o) => s + (o.hoursLost || 0), 0), 0));
    const budgetLabor = ((order.budget as { groups?: Array<{ type: string; cost: number }> } | null)?.groups ?? []).find((group) => group.type === 'mao_de_obra')?.cost ?? 0;

    return {
      reports: reports.length, days: new Set(reports.map((report) => iso(report.date))).size, drafts: reports.filter((report) => report.status !== 'fechado').length,
      lastDate: reports.length ? iso(reports[reports.length - 1].date) : null,
      hours: { rows, total: total('hours'), overtime: total('overtime'), budget: total('budgetHours'), budgetOvertime: total('budgetOvertime') },
      progress: {
        done: done === null ? null : round2(done), planned: planned === null ? null : round2(planned),
        steps: steps.map((step) => ({ step: step.step, title: step.title, percent: last.get(step.step) ?? 0 })),
      },
      stoppedDays: new Set(stopped.map((report) => iso(report.date))).size, hoursLost,
      // custo: só com a permissão de custos
      labor: canSeeCosts ? { cost: round2(cost), budget: round2(budgetLabor), withoutCost: [...withoutCost] } : null,
    };
  }

  // ------------------------------------------------------------------ leitura

  /** Saiu antes da hora de saída do dia. */
  private leftEarly(member: CrewMember, row: Pick<Service_DailyReport, 'startTime' | 'endTime' | 'shift'>): boolean {
    if (!member.out || !row.endTime || !row.startTime) return false;
    const overnight = row.shift === 'noite';
    return spanMinutes(row.startTime, member.out, overnight) < spanMinutes(row.startTime, row.endTime, overnight);
  }

  private brief(row: Service_DailyReport, userName: Map<number, string>) {
    const crew = (row.crew as unknown as CrewMember[]) ?? [];
    return {
      id: row.id, orderId: row.orderId, date: iso(row.date)!, shift: row.shift, shiftLabel: SHIFT_LABEL[row.shift] ?? row.shift, weather: row.weather, status: row.status,
      startTime: row.startTime, endTime: row.endTime, earlyLeaves: crew.filter((member) => this.leftEarly(member, row)).length,
      people: crew.length, hours: round2(crew.reduce((sum, member) => sum + member.hours, 0)), overtime: round2(crew.reduce((sum, member) => sum + member.overtime, 0)),
      activities: row.activities ? row.activities.slice(0, 200) : null,
      occurrences: ((row.occurrences as unknown as Occurrence[]) ?? []).length, photos: ((row.photos as unknown as Photo[]) ?? []).length,
      createdBy: row.createdByUserId ? userName.get(row.createdByUserId) ?? null : null, closedAt: row.closedAt,
      returned: row.returnedAt ? { note: row.returnNote, at: row.returnedAt } : null,
    };
  }

  private async namesOf(ids: Array<number | null>) {
    const unique = [...new Set(ids.filter((id): id is number => !!id))];
    const users = unique.length ? await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((user) => [user.id, user.name]));
  }

  private async orderBrief(order: Service_Order) {
    const customer = await this.prisma.customer.findUnique({ where: { id: order.customerId }, select: { id: true, name: true } });
    return { id: order.id, number: order.number, status: order.status, title: order.title, customer, startedAt: iso(order.startedAt), finishedAt: iso(order.finishedAt), location: order.location };
  }

  /** Diário de uma OS: os RDOs e o que eles dizem da obra. */
  async list(actor: OrderActor, orderId: number) {
    const order = await this.orderOf(actor, orderId);
    const rows = await this.prisma.service_DailyReport.findMany({ where: { orderId, inactiveAt: null }, orderBy: [{ date: 'desc' }, { id: 'desc' }] });
    const names = await this.namesOf(rows.map((row) => row.createdByUserId));
    return {
      order: await this.orderBrief(order), canWrite: order.status === 'em_execucao' || order.status === 'concluida',
      rows: rows.map((row) => this.brief(row, names)), summary: await this.summaryOf(order, actor.canSeeCosts),
    };
  }

  /** RDOs recentes de todas as obras e as obras em andamento (a tela do encarregado). */
  async recent(actor: OrderActor, query: Record<string, string>) {
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
    // sem a permissão de ver todas, só as obras e os RDOs das OS da pessoa
    const visible = await ordersVisibleTo(this.prisma, actor);
    const mine = actor.seesAll ? null : (await this.prisma.service_Order.findMany({ where: { companyId: actor.companyId, AND: [visible] }, select: { id: true }, take: 2000 })).map((order) => order.id);
    const [rows, running] = await Promise.all([
      this.prisma.service_DailyReport.findMany({ where: { companyId: actor.companyId, inactiveAt: null, ...(mine ? { orderId: { in: mine } } : {}) }, orderBy: [{ date: 'desc' }, { id: 'desc' }], take: limit }),
      this.prisma.service_Order.findMany({ where: { companyId: actor.companyId, status: 'em_execucao', inactiveAt: null, AND: [visible] }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] }),
    ]);
    const orderIds = [...new Set([...rows.map((row) => row.orderId), ...running.map((order) => order.id)])];
    const orders = await this.prisma.service_Order.findMany({ where: { id: { in: orderIds } } });
    const customers = await this.prisma.customer.findMany({ where: { id: { in: orders.map((order) => order.customerId) } }, select: { id: true, name: true } });
    const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
    const orderOf = new Map(orders.map((order) => [order.id, { id: order.id, number: order.number, title: order.title, status: order.status, customer: customerName.get(order.customerId) ?? '' }]));
    const names = await this.namesOf(rows.map((row) => row.createdByUserId));
    const now = today();
    const todays = await this.prisma.service_DailyReport.findMany({ where: { orderId: { in: running.map((order) => order.id) }, date: asDate(now), inactiveAt: null }, select: { id: true, orderId: true, status: true, shift: true } });
    return {
      today: now,
      running: running.map((order) => ({ ...orderOf.get(order.id)!, startedAt: iso(order.startedAt), plannedEnd: iso(order.plannedEnd), location: order.location, todayReports: todays.filter((report) => report.orderId === order.id) })),
      rows: rows.map((row) => ({ ...this.brief(row, names), order: orderOf.get(row.orderId) ?? null })),
    };
  }

  private async present(row: Service_DailyReport, order: Service_Order) {
    const names = await this.namesOf([row.createdByUserId, row.closedByUserId, row.returnedByUserId]);
    const steps = this.stepsOf(order);
    const saved = new Map(((row.progress as unknown as StepProgress[]) ?? []).map((item) => [item.step, item.percent]));
    return {
      id: row.id, date: iso(row.date)!, shift: row.shift, weather: row.weather, status: row.status, editable: row.status !== 'fechado',
      startTime: row.startTime, endTime: row.endTime, breakMinutes: row.breakMinutes, weatherEnd: row.weatherEnd,
      startCondition: row.startCondition, endCondition: row.endCondition, startNote: row.startNote, endNote: row.endNote,
      crew: (row.crew as unknown as CrewMember[]) ?? [], activities: row.activities,
      progress: steps.map((step) => ({ step: step.step, title: step.title, percent: saved.get(step.step) ?? 0 })),
      occurrences: (row.occurrences as unknown as Occurrence[]) ?? [], equipment: row.equipment, photos: (row.photos as unknown as Photo[]) ?? [], notes: row.notes,
      createdBy: row.createdByUserId ? names.get(row.createdByUserId) ?? null : null, closedAt: row.closedAt, closedBy: row.closedByUserId ? names.get(row.closedByUserId) ?? null : null,
      returned: row.returnedAt ? { note: row.returnNote, at: row.returnedAt, by: row.returnedByUserId ? names.get(row.returnedByUserId) ?? null : null } : null,
      order: await this.orderBrief(order), roles: this.rolesOf(order), roleOptions: await this.roleOptionsOf(order), hoursPerDay: (await this.laborOf(order)).hoursPerDay,
    };
  }

  async get(actor: OrderActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    return this.present(row, await this.orderOf(actor, row.orderId));
  }

  /** RDO em branco de um dia: a equipe escalada na OS e o avanço como estava no último RDO. */
  async template(actor: OrderActor, orderId: number, query: Record<string, string>) {
    const order = await this.orderOf(actor, orderId);
    const date = blank(query.date) ? today() : dateOf(query.date, 'Data');
    const [labor, previous] = await Promise.all([
      this.laborOf(order),
      this.prisma.service_DailyReport.findFirst({ where: { orderId, inactiveAt: null, date: { lte: asDate(date) } }, orderBy: [{ date: 'desc' }, { id: 'desc' }] }),
    ]);
    const last = new Map(((previous?.progress as unknown as StepProgress[]) ?? []).map((item) => [item.step, item.percent]));
    // a equipe de ontem é o melhor palpite para hoje; sem RDO anterior, a equipe escalada na OS
    const yesterday = (previous?.crew as unknown as CrewMember[]) ?? [];
    const link = (member: { employeeId?: number | null; professionalId?: number | null }) => (member.employeeId ? { employeeId: member.employeeId, professionalId: member.professionalId ?? null } : {});
    // RDO de um turno: da equipe escalada, só quem está na obra naquela parte do dia (ou o dia inteiro)
    const wanted = (REPORT_SHIFTS as readonly string[]).includes(String(query.shift)) ? String(query.shift) : 'integral';
    const team = ((order.team as unknown as Array<{ name: string; role: string; employeeId?: number | null; professionalId?: number | null; shift?: string | null }>) ?? [])
      .filter((member) => wanted === 'integral' || !member.shift || member.shift === 'integral' || member.shift === wanted).map((member) => ({ name: member.name, role: member.role, hours: labor.hoursPerDay, overtime: 0, ...link(member) }));
    return {
      id: null, date, shift: wanted, weather: 'bom', status: 'rascunho', editable: true,
      // a hora de entrada costuma se repetir: parte da do último RDO; a saída é preenchida no fim do dia
      startTime: previous?.startTime ?? null, endTime: null, breakMinutes: previous?.breakMinutes ?? 60, weatherEnd: null,
      startCondition: null, endCondition: null, startNote: null, endNote: null,
      crew: yesterday.length ? yesterday.map((member) => ({ name: member.name, role: member.role, hours: member.hours, overtime: 0, in: null, out: null, leaveReason: null, ...link(member) })) : team.map((member) => ({ ...member, in: null, out: null, leaveReason: null })), activities: null,
      progress: this.stepsOf(order).map((step) => ({ step: step.step, title: step.title, percent: last.get(step.step) ?? 0 })),
      occurrences: [], equipment: previous?.equipment ?? null, photos: [], notes: null,
      createdBy: null, closedAt: null, closedBy: null, order: await this.orderBrief(order), roles: this.rolesOf(order), roleOptions: await this.roleOptionsOf(order), hoursPerDay: labor.hoursPerDay,
    };
  }

  // ------------------------------------------------------------------ estatísticas

  /**
   * O que os RDOs de um período dizem: jornada (hora de entrada e de saída),
   * presenças e horas por pessoa e por função, saídas antecipadas e seus
   * motivos, clima e condição da frente de trabalho, dias parados e ocorrências.
   */
  async stats(actor: OrderActor, query: Record<string, string>) {
    const to = blank(query.to) ? today() : dateOf(query.to, 'Até');
    const from = blank(query.from) ? iso(new Date(asDate(to).getTime() - 29 * 86400000))! : dateOf(query.from, 'De');
    if (from > to) throw new BadRequestException('O período começa depois de terminar');
    if (daysBetween(from, to) > 730) throw new BadRequestException('Escolha um período de até dois anos');
    const orderId = Number(query.orderId) > 0 ? Number(query.orderId) : null;
    const visible = await ordersVisibleTo(this.prisma, actor);
    const orders = await this.prisma.service_Order.findMany({
      where: { companyId: actor.companyId, AND: [visible], ...(orderId ? { id: orderId } : {}) }, select: { id: true, number: true, title: true, customerId: true }, take: 2000,
    });
    const reports = await this.prisma.service_DailyReport.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, orderId: { in: orders.map((order) => order.id) }, date: { gte: asDate(from), lte: asDate(to) } },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });
    const customers = await this.prisma.customer.findMany({ where: { id: { in: orders.map((order) => order.customerId) } }, select: { id: true, name: true } });
    const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
    const orderOf = new Map(orders.map((order) => [order.id, order]));

    const tally = (keys: readonly string[]) => Object.fromEntries([...keys, 'sem_registro'].map((key) => [key, 0])) as Record<string, number>;
    const weather = { start: tally(REPORT_WEATHERS), end: tally(REPORT_WEATHERS), changed: 0 };
    const conditions = { start: tally(SITE_CONDITIONS), end: tally(SITE_CONDITIONS) };
    const occurrences = new Map<string, { type: string; count: number; hoursLost: number }>();
    const people = new Map<string, { name: string; role: string; days: Set<string>; hours: number; overtime: number; earlyLeaves: number }>();
    const roles = new Map<string, { role: string; presences: number; hours: number; overtime: number }>();
    const byOrder = new Map<number, { days: Set<string>; presences: number; hours: number; overtime: number; hoursLost: number; earlyLeaves: number }>();
    const byDay = new Map<string, { people: number; hours: number; overtime: number; hoursLost: number }>();
    const reasons = new Map<string, { reason: string; count: number }>();
    const stoppedDays = new Set<string>();
    const starts: number[] = [];
    const ends: number[] = [];
    const spans: number[] = [];
    let presences = 0, hours = 0, overtime = 0, hoursLost = 0, earlyLeaves = 0;

    for (const report of reports) {
      const date = iso(report.date)!;
      const crew = (report.crew as unknown as CrewMember[]) ?? [];
      const list = (report.occurrences as unknown as Occurrence[]) ?? [];
      const order = byOrder.get(report.orderId) ?? { days: new Set<string>(), presences: 0, hours: 0, overtime: 0, hoursLost: 0, earlyLeaves: 0 };
      const day = byDay.get(date) ?? { people: 0, hours: 0, overtime: 0, hoursLost: 0 };
      order.days.add(date);

      // jornada: a saída é contada a partir da entrada, para o turno que vira a noite não bagunçar a média
      if (report.startTime && report.endTime) {
        const start = Number(report.startTime.slice(0, 2)) * 60 + Number(report.startTime.slice(3));
        const span = spanMinutes(report.startTime, report.endTime, report.shift === 'noite');
        starts.push(start); ends.push(start + span); spans.push(span);
      }
      weather.start[report.weather] = (weather.start[report.weather] ?? 0) + 1;
      weather.end[report.weatherEnd ?? 'sem_registro'] += 1;
      if (report.weatherEnd && report.weatherEnd !== report.weather) weather.changed += 1;
      conditions.start[report.startCondition ?? 'sem_registro'] += 1;
      conditions.end[report.endCondition ?? 'sem_registro'] += 1;
      if (report.weather === 'impraticavel' || report.startCondition === 'impedido' || list.some((item) => item.type === 'paralisacao')) stoppedDays.add(`${report.orderId}:${date}`);

      for (const item of list) {
        const entry = occurrences.get(item.type) ?? { type: item.type, count: 0, hoursLost: 0 };
        entry.count += 1; entry.hoursLost = round2(entry.hoursLost + (item.hoursLost || 0));
        occurrences.set(item.type, entry);
        hoursLost += item.hoursLost || 0; order.hoursLost += item.hoursLost || 0; day.hoursLost += item.hoursLost || 0;
      }
      for (const member of crew) {
        const early = this.leftEarly(member, report);
        presences += 1; hours += member.hours; overtime += member.overtime;
        order.presences += 1; order.hours += member.hours; order.overtime += member.overtime;
        day.people += 1; day.hours += member.hours; day.overtime += member.overtime;
        const personKey = member.employeeId ? `e${member.employeeId}` : norm(member.name);
        const person = people.get(personKey) ?? { name: member.name, role: member.role, days: new Set<string>(), hours: 0, overtime: 0, earlyLeaves: 0 };
        person.days.add(date); person.hours += member.hours; person.overtime += member.overtime; if (member.role) person.role = member.role;
        people.set(personKey, person);
        const roleKey = norm(member.role || 'Sem função');
        const role = roles.get(roleKey) ?? { role: member.role || 'Sem função', presences: 0, hours: 0, overtime: 0 };
        role.presences += 1; role.hours += member.hours; role.overtime += member.overtime;
        roles.set(roleKey, role);
        if (early) {
          earlyLeaves += 1; order.earlyLeaves += 1; person.earlyLeaves += 1;
          const reason = member.leaveReason || 'Sem motivo informado';
          const entry = reasons.get(norm(reason)) ?? { reason, count: 0 };
          entry.count += 1; reasons.set(norm(reason), entry);
        }
      }
      byOrder.set(report.orderId, order); byDay.set(date, day);
    }

    const clock = (minutes: number) => `${String(Math.floor((minutes % 1440) / 60)).padStart(2, '0')}:${String(Math.round(minutes % 60) % 60).padStart(2, '0')}`;
    const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
    const avgStart = average(starts), avgEnd = average(ends), avgSpan = average(spans);
    const days = new Set(reports.map((report) => iso(report.date)!));
    return {
      period: { from, to }, orderId,
      reports: reports.length, drafts: reports.filter((report) => report.status !== 'fechado').length, days: days.size, orders: byOrder.size,
      people: { presences, distinct: people.size, averagePerDay: days.size ? round2(presences / days.size) : 0 },
      hours: { normal: round2(hours), overtime: round2(overtime), lost: round2(hoursLost), perPresence: presences ? round2((hours + overtime) / presences) : 0 },
      times: {
        reports: starts.length,
        averageStart: avgStart === null ? null : clock(Math.round(avgStart)), averageEnd: avgEnd === null ? null : clock(Math.round(avgEnd)),
        averageSpan: avgSpan === null ? null : round2(avgSpan / 60),
        earliestStart: starts.length ? clock(Math.min(...starts)) : null, latestEnd: ends.length ? clock(Math.max(...ends)) : null,
      },
      earlyLeaves: {
        count: earlyLeaves, rate: presences ? round2((earlyLeaves / presences) * 100) : 0,
        reasons: [...reasons.values()].sort((a, b) => b.count - a.count),
      },
      weather, conditions, stoppedDays: stoppedDays.size,
      occurrences: [...occurrences.values()].sort((a, b) => b.count - a.count),
      byPerson: [...people.values()].map((person) => ({ name: person.name, role: person.role, days: person.days.size, hours: round2(person.hours), overtime: round2(person.overtime), earlyLeaves: person.earlyLeaves }))
        .sort((a, b) => b.hours + b.overtime - (a.hours + a.overtime)),
      byRole: [...roles.values()].map((role) => ({ ...role, hours: round2(role.hours), overtime: round2(role.overtime) })).sort((a, b) => b.hours - a.hours),
      byOrder: [...byOrder.entries()].map(([id, row]) => {
        const order = orderOf.get(id)!;
        return { id, number: order.number, title: order.title, customer: customerName.get(order.customerId) ?? '', days: row.days.size, presences: row.presences, hours: round2(row.hours), overtime: round2(row.overtime), hoursLost: round2(row.hoursLost), earlyLeaves: row.earlyLeaves };
      }).sort((a, b) => b.hours - a.hours),
      byDay: [...byDay.entries()].map(([date, row]) => ({ date, people: row.people, hours: round2(row.hours), overtime: round2(row.overtime), hoursLost: round2(row.hoursLost) })),
    };
  }

  // ------------------------------------------------------------------ escrita

  private dataOf(body: Body, order: Service_Order): Omit<Prisma.Service_DailyReportUncheckedCreateInput, 'companyId' | 'orderId' | 'date'> {
    const shift = blank(body.shift) ? 'integral' : String(body.shift);
    if (!(REPORT_SHIFTS as readonly string[]).includes(shift)) throw new BadRequestException('Turno inválido');
    const weather = blank(body.weather) ? 'bom' : String(body.weather);
    if (!(REPORT_WEATHERS as readonly string[]).includes(weather)) throw new BadRequestException('Clima inválido');

    // entrada na atividade e saída, com o clima e a condição da frente de trabalho em cada momento
    const overnight = shift === 'noite';
    const startTime = timeOf(body.startTime, 'Hora de entrada');
    const endTime = timeOf(body.endTime, 'Hora de saída');
    if (endTime && !startTime) throw new BadRequestException('Informe a hora de entrada antes da hora de saída');
    if (startTime && endTime && spanMinutes(startTime, endTime, overnight) <= 0) throw new BadRequestException('A hora de saída precisa ser depois da hora de entrada');
    const breakMinutes = blank(body.breakMinutes) ? 60 : Number(body.breakMinutes);
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 240) throw new BadRequestException('Intervalo: informe de 0 a 240 minutos');
    const weatherEnd = blank(body.weatherEnd) ? null : String(body.weatherEnd);
    if (weatherEnd && !(REPORT_WEATHERS as readonly string[]).includes(weatherEnd)) throw new BadRequestException('Clima na saída inválido');
    const condition = (value: unknown, label: string) => {
      if (blank(value)) return null;
      if (!(SITE_CONDITIONS as readonly string[]).includes(String(value))) throw new BadRequestException(`${label} inválida`);
      return String(value);
    };
    const startCondition = condition(body.startCondition, 'Condição na entrada');
    const endCondition = condition(body.endCondition, 'Condição na saída');

    const rawCrew = Array.isArray(body.crew) ? body.crew : [];
    if (rawCrew.length > 80) throw new BadRequestException('Pessoas demais na equipe do dia');
    const crew: CrewMember[] = rawCrew
      .map((raw: Body) => {
        const name = clean(raw?.name, 120);
        // hora própria só fica guardada quando difere da do dia
        const memberIn = timeOf(raw?.in, `Entrada de ${name || 'pessoa'}`);
        const memberOut = timeOf(raw?.out, `Saída de ${name || 'pessoa'}`);
        const first = memberIn ?? startTime;
        if (first && memberOut && spanMinutes(first, memberOut, overnight) <= 0) throw new BadRequestException(`Saída de ${name || 'pessoa'}: precisa ser depois da entrada`);
        return {
          name, role: clean(raw?.role, 80), hours: hoursOf(raw?.hours, 'Horas'), overtime: hoursOf(raw?.overtime, 'Horas extras', 16),
          in: memberIn && memberIn !== startTime ? memberIn : null, out: memberOut && memberOut !== endTime ? memberOut : null,
          leaveReason: clean(raw?.leaveReason, 200) || null,
          ...(Number(raw?.employeeId) > 0 ? { employeeId: Number(raw.employeeId), professionalId: Number(raw?.professionalId) > 0 ? Number(raw.professionalId) : null } : {}),
        };
      })
      .filter((member: CrewMember) => member.name || member.role);
    for (const member of crew) if (!member.name) throw new BadRequestException('Informe o nome de cada pessoa da equipe do dia');

    const steps = this.stepsOf(order);
    const rawProgress = Array.isArray(body.progress) ? body.progress : [];
    const progress: StepProgress[] = steps.map((step) => {
      const raw = rawProgress.find((item: Body) => Number(item?.step) === step.step);
      const percent = blank(raw?.percent) ? 0 : Number(raw.percent);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new BadRequestException(`Avanço de "${step.title}": informe de 0 a 100`);
      return { step: step.step, title: step.title, percent: Math.round(percent) };
    });

    const rawOccurrences = Array.isArray(body.occurrences) ? body.occurrences : [];
    if (rawOccurrences.length > 30) throw new BadRequestException('Ocorrências demais');
    const occurrences: Occurrence[] = rawOccurrences.map((raw: Body) => {
      const type = String(raw?.type ?? 'outro');
      if (!(OCCURRENCE_TYPES as readonly string[]).includes(type)) throw new BadRequestException('Tipo de ocorrência inválido');
      const description = text(raw?.description, 1000);
      if (!description) throw new BadRequestException('Descreva a ocorrência');
      return { type, description, hoursLost: hoursOf(raw?.hoursLost, 'Horas paradas') };
    });

    const rawPhotos = Array.isArray(body.photos) ? body.photos : [];
    if (rawPhotos.length > 30) throw new BadRequestException('No máximo 30 fotos por RDO');
    const photos: Photo[] = rawPhotos.map((raw: Body) => {
      const url = String(raw?.url ?? '').trim();
      if (!/^https:\/\/[^\s"'<>]+$/i.test(url) || url.length > 600) throw new BadRequestException('Foto inválida');
      return { url, caption: clean(raw?.caption, 200) };
    });

    return {
      startTime, endTime, breakMinutes, weatherEnd, startCondition, endCondition, startNote: clean(body.startNote, 500) || null, endNote: clean(body.endNote, 500) || null,
      shift, weather, crew: crew as unknown as Prisma.InputJsonValue, activities: text(body.activities, 5000) || null,
      progress: progress as unknown as Prisma.InputJsonValue, occurrences: occurrences as unknown as Prisma.InputJsonValue,
      equipment: text(body.equipment, 2000) || null, photos: photos as unknown as Prisma.InputJsonValue, notes: text(body.notes, 5000) || null,
    };
  }

  private assertDate(order: Service_Order, date: string) {
    if (date > today()) throw new BadRequestException('O RDO não pode ser de um dia que ainda não chegou');
    const started = iso(order.startedAt);
    if (started && date < started) throw new BadRequestException(`A obra começou em ${started.split('-').reverse().join('/')}: o RDO não pode ser anterior`);
    const finished = iso(order.finishedAt);
    if (finished && date > finished) throw new BadRequestException(`A obra terminou em ${finished.split('-').reverse().join('/')}: o RDO não pode ser posterior`);
  }

  private duplicate(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Já existe um RDO deste dia e turno nesta obra: abra o que já foi criado');
    throw error;
  }

  async create(actor: OrderActor, orderId: number, body: Body) {
    const order = await this.orderOf(actor, orderId);
    if (order.status !== 'em_execucao' && order.status !== 'concluida') {
      throw new ConflictException(order.status === 'encerrada' || order.status === 'cancelada' ? 'Esta ordem de serviço não recebe mais RDO' : 'A obra ainda não começou: inicie a execução da OS para lançar o RDO');
    }
    const date = dateOf(body.date, 'Data');
    this.assertDate(order, date);
    await this.assertCrewLinks(actor.companyId, body);
    const created = await this.prisma.service_DailyReport
      .create({ data: { companyId: actor.companyId, orderId, date: asDate(date), createdByUserId: actor.userId || null, ...this.dataOf(body, order) } })
      .catch((error) => this.duplicate(error));
    return this.present(created, order);
  }

  async update(actor: OrderActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    if (row.status === 'fechado') throw new ConflictException('RDO fechado: reabra, com o motivo, para corrigir');
    const order = await this.orderOf(actor, row.orderId);
    const date = blank(body.date) ? iso(row.date)! : dateOf(body.date, 'Data');
    this.assertDate(order, date);
    await this.assertCrewLinks(actor.companyId, body);
    const saved = await this.prisma.service_DailyReport.update({ where: { id }, data: { date: asDate(date), ...this.dataOf(body, order) } }).catch((error) => this.duplicate(error));
    return this.present(saved, order);
  }

  /** Fecha o RDO: a partir daqui ele não é editado. */
  async close(actor: OrderActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    await this.orderOf(actor, row.orderId);
    if (row.status === 'fechado') throw new ConflictException('Este RDO já está fechado');
    const crew = (row.crew as unknown as CrewMember[]) ?? [];
    // dia parado não tem equipe nem atividade: nesse caso a ocorrência ou o clima explicam
    const stopped = row.weather === 'impraticavel' || ((row.occurrences as unknown as Occurrence[]) ?? []).length > 0;
    if (!crew.length && !row.activities && !stopped) throw new BadRequestException('Informe a equipe do dia ou o que foi feito antes de fechar. Se o dia foi parado, registre a ocorrência ou o clima.');
    // dia trabalhado fecha com a hora de entrada e de saída: é delas que saem a jornada e as estatísticas
    if (crew.length && (!row.startTime || !row.endTime)) throw new BadRequestException('Informe a hora de entrada e a hora de saída antes de fechar o RDO.');
    const noReason = crew.find((member) => this.leftEarly(member, row) && !member.leaveReason);
    if (noReason) throw new BadRequestException(`Informe por que ${noReason.name} saiu antes.`);
    const saved = await this.prisma.service_DailyReport.update({ where: { id }, data: { status: 'fechado', closedAt: new Date(), closedByUserId: actor.userId || null, returnNote: null, returnedAt: null, returnedByUserId: null } });
    return this.present(saved, await this.orderOf(actor, row.orderId));
  }

  /** Reabre um RDO fechado para correção; o motivo fica no histórico. */
  async reopen(actor: OrderActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    await this.orderOf(actor, row.orderId);
    if (row.status !== 'fechado') throw new ConflictException('Este RDO não está fechado');
    const note = clean(body.note, 500);
    if (!note) throw new BadRequestException('Informe o motivo da correção');
    const saved = await this.prisma.$transaction(async (tx) => {
      await recordFlowEvent(tx, 'service_report', { companyId: row.companyId, entityId: row.id, type: 'reaberto', from: 'fechado', to: 'rascunho', userId: actor.userId, note });
      return tx.service_DailyReport.update({ where: { id }, data: { status: 'rascunho', closedAt: null, closedByUserId: null } });
    });
    return this.present(saved, await this.orderOf(actor, row.orderId));
  }

  /**
   * Devolve o RDO para quem preencheu corrigir: volta a ser rascunho (se estava
   * fechado) e leva o motivo, que aparece na tela e na esteira de quem preencheu
   * até ele fechar de novo. Fica no histórico como "devolvido".
   */
  async sendBack(actor: OrderActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    const order = await this.orderOf(actor, row.orderId);
    const note = clean(body.note, 500);
    if (!note) throw new BadRequestException('Informe o que precisa ser corrigido');
    const saved = await this.prisma.$transaction(async (tx) => {
      await recordFlowEvent(tx, 'service_report', { companyId: row.companyId, entityId: row.id, type: 'devolvido', from: row.status, to: 'rascunho', userId: actor.userId, note });
      return tx.service_DailyReport.update({
        where: { id }, data: { status: 'rascunho', closedAt: null, closedByUserId: null, returnNote: note, returnedAt: new Date(), returnedByUserId: actor.userId || null },
      });
    });
    return this.present(saved, order);
  }

  /**
   * O que falta no diário das obras em execução: dias sem RDO (nos últimos
   * `days` dias, sem contar domingo, a menos que `sundays`), rascunhos de dias
   * que já passaram e RDOs devolvidos que ainda não voltaram.
   */
  async pending(actor: OrderActor, query: { days?: number; orderId?: number | null; sundays?: boolean }) {
    const days = Math.min(31, Math.max(1, Math.round(Number(query.days) || 7)));
    const now = today();
    const visible = await ordersVisibleTo(this.prisma, actor);
    const orders = await this.prisma.service_Order.findMany({
      where: { companyId: actor.companyId, status: 'em_execucao', inactiveAt: null, AND: [visible], ...(query.orderId ? { id: query.orderId } : {}) },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }], take: 200,
    });
    const first = iso(new Date(asDate(now).getTime() - (days - 1) * 86400000))!;
    const reports = orders.length
      ? await this.prisma.service_DailyReport.findMany({ where: { orderId: { in: orders.map((order) => order.id) }, inactiveAt: null, OR: [{ date: { gte: asDate(first) } }, { status: 'rascunho' }] }, orderBy: [{ date: 'asc' }] })
      : [];
    const users = await this.namesOf([...orders.map((order) => order.responsibleUserId), ...reports.map((report) => report.createdByUserId)]);
    const customers = await this.prisma.customer.findMany({ where: { id: { in: orders.map((order) => order.customerId) } }, select: { id: true, name: true } });
    const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
    const rows = orders.map((order) => {
      const mine = reports.filter((report) => report.orderId === order.id);
      const has = new Set(mine.map((report) => iso(report.date)));
      const start = iso(order.startedAt) && iso(order.startedAt)! > first ? iso(order.startedAt)! : first;
      const missing: string[] = [];
      for (let day = start; day <= now; day = iso(new Date(asDate(day).getTime() + 86400000))!) {
        if (!query.sundays && asDate(day).getUTCDay() === 0) continue;
        if (!has.has(day)) missing.push(day);
      }
      const last = [...mine].reverse().find((report) => report.createdByUserId);
      return {
        id: order.id, number: order.number, title: order.title, customer: customerName.get(order.customerId) ?? '',
        responsible: order.responsibleUserId ? { id: order.responsibleUserId, name: users.get(order.responsibleUserId) ?? null } : null,
        lastFiller: last?.createdByUserId ? { id: last.createdByUserId, name: users.get(last.createdByUserId) ?? null } : null,
        missingDays: missing,
        drafts: mine.filter((report) => report.status === 'rascunho' && !report.returnedAt && iso(report.date)! < now).map((report) => ({ id: report.id, date: iso(report.date)!, shift: report.shift, by: report.createdByUserId ? users.get(report.createdByUserId) ?? null : null })),
        returned: mine.filter((report) => report.status === 'rascunho' && report.returnedAt).map((report) => ({ id: report.id, date: iso(report.date)!, note: report.returnNote, at: report.returnedAt, by: report.createdByUserId ? users.get(report.createdByUserId) ?? null : null })),
      };
    });
    return { today: now, from: first, days, sundays: !!query.sundays, orders: rows };
  }

  /**
   * Pontos para conferir num RDO, calculados aqui para não depender de quem lê:
   * o que falta preencher, horas fora do comum, avanço que voltou, gente fora da
   * equipe escalada e ocorrências que pedem providência.
   */
  async findings(actor: OrderActor, id: number): Promise<string[]> {
    const row = await this.byId(actor.companyId, id);
    const order = await this.orderOf(actor, row.orderId);
    const out: string[] = [];
    const crew = (row.crew as unknown as CrewMember[]) ?? [];
    const occurrences = (row.occurrences as unknown as Occurrence[]) ?? [];
    const photos = (row.photos as unknown as Photo[]) ?? [];
    const stopped = row.weather === 'impraticavel' || row.startCondition === 'impedido' || occurrences.some((item) => item.type === 'paralisacao');
    const date = iso(row.date)!;
    if (row.status === 'rascunho' && date < today()) out.push(`Rascunho de ${date.split('-').reverse().join('/')} ainda não foi fechado.`);
    if (!crew.length && !stopped) out.push('Sem equipe do dia e sem paralisação registrada.');
    if (!row.activities?.trim() && !stopped) out.push('Não diz o que foi feito no dia.');
    else if (row.activities && row.activities.trim().length < 25) out.push('A descrição do que foi feito está curta demais para acompanhar a obra.');
    if (!photos.length && !stopped) out.push('Sem fotos.');
    if (crew.length && (!row.startTime || !row.endTime)) out.push('Falta a hora de entrada ou de saída.');
    if (crew.length && !row.endCondition) out.push('Falta a condição da frente de trabalho na saída.');
    for (const member of crew) {
      const total = (member.hours || 0) + (member.overtime || 0);
      if (total > 12) out.push(`${member.name} está com ${round2(total)} h no dia (acima de 12 h).`);
      if (!total && !stopped) out.push(`${member.name} está na equipe com 0 hora.`);
      if (!member.role) out.push(`${member.name} está sem função.`);
      if (this.leftEarly(member, row) && !member.leaveReason) out.push(`${member.name} saiu antes sem motivo informado.`);
    }
    const team = ((order.team as unknown as Array<{ employeeId?: number | null; name?: string }>) ?? []);
    if (team.length) {
      const ids = new Set(team.map((member) => member.employeeId).filter(Boolean));
      const names = new Set(team.map((member) => norm(member.name ?? '')).filter(Boolean));
      const outside = crew.filter((member) => (member.employeeId ? !ids.has(member.employeeId) : !names.has(norm(member.name))));
      if (outside.length) out.push(`Fora da equipe escalada na OS: ${outside.map((member) => member.name).join(', ')}.`);
    }
    for (const item of occurrences) {
      if (!item.description?.trim()) out.push(`Ocorrência de ${item.type.replace('_', ' ')} sem descrição.`);
      if (item.type === 'acidente') out.push('Acidente registrado: confira se a CAT e a investigação foram feitas.');
      if (item.type === 'quase_acidente') out.push('Quase acidente registrado: confira se a causa foi tratada.');
      if (item.type === 'paralisacao' && !item.hoursLost) out.push('Paralisação sem horas perdidas.');
    }
    const previous = await this.prisma.service_DailyReport.findFirst({ where: { orderId: row.orderId, inactiveAt: null, date: { lt: row.date } }, orderBy: [{ date: 'desc' }, { id: 'desc' }] });
    if (previous) {
      const before = new Map(((previous.progress as unknown as StepProgress[]) ?? []).map((item) => [item.step, item.percent]));
      for (const item of (row.progress as unknown as StepProgress[]) ?? []) {
        const old = before.get(item.step);
        if (old !== undefined && item.percent < old) out.push(`O avanço de "${item.title}" caiu de ${old}% para ${item.percent}% em relação ao RDO anterior.`);
      }
    }
    if (row.returnedAt) out.push(`Devolvido para correção: ${row.returnNote}`);
    return out;
  }

  /** Apaga um rascunho (RDO fechado não é apagado). */
  async remove(actor: OrderActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    await this.orderOf(actor, row.orderId);
    if (row.status === 'fechado') throw new ConflictException('RDO fechado não é apagado: reabra para corrigir');
    await this.prisma.service_DailyReport.delete({ where: { id } });
    return { id };
  }
}
