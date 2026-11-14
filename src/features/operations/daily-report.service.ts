import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Service_DailyReport, Service_Order } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { recordFlowEvent } from 'src/common/flow/flow';
import type { PricingSnapshot } from 'src/features/commercial/commercial.service';
import { computeBase, professionalCost } from 'src/features/commercial/pricing/engine';
import { OrderActor } from './service-order.service';

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

export interface CrewMember { name: string; role: string; hours: number; overtime: number }
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
function hoursOf(value: unknown, label: string, max = 24): number {
  if (blank(value)) return 0;
  const out = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(out) || out < 0 || out > max) throw new BadRequestException(`${label}: informe um número de horas entre 0 e ${max}`);
  return round2(out);
}

@Injectable()
export class DailyReportService {
  constructor(private readonly prisma: PrismaService) {}

  private async orderOf(companyId: number, orderId: number): Promise<Service_Order> {
    const order = await this.prisma.service_Order.findFirst({ where: { id: orderId, companyId } });
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

  /**
   * Mão de obra orçada por função: horas e custo hora, recalculados da fotografia
   * da base de cálculo guardada na proposta (o mesmo número que formou o preço).
   */
  private async laborOf(order: Service_Order) {
    const proposal = await this.prisma.commercial_Proposal.findUnique({
      where: { id: order.proposalId },
      select: { snapshot: true, workDays: true, items: { where: { type: 'mao_de_obra' }, select: { description: true, professionalId: true, quantity: true, workDays: true, hoursPerDay: true, overtimeHours: true } } },
    });
    const byRole = new Map<string, { role: string; budgetHours: number; budgetOvertime: number; hourCost: number; overtimePerHour: number }>();
    if (!proposal) return { byRole, hoursPerDay: 8 };
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
      const entry = byRole.get(key) ?? { role: item.description, budgetHours: 0, budgetOvertime: 0, hourCost: cost?.hourCost ?? 0, overtimePerHour: cost?.overtimePerHour ?? 0 };
      entry.budgetHours = round2(entry.budgetHours + hours);
      entry.budgetOvertime = round2(entry.budgetOvertime + Number(item.overtimeHours) * quantity);
      byRole.set(key, entry);
    }
    return { byRole, hoursPerDay };
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
      const key = norm(member.role || 'Sem função');
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

  private brief(row: Service_DailyReport, userName: Map<number, string>) {
    const crew = (row.crew as unknown as CrewMember[]) ?? [];
    return {
      id: row.id, orderId: row.orderId, date: iso(row.date)!, shift: row.shift, shiftLabel: SHIFT_LABEL[row.shift] ?? row.shift, weather: row.weather, status: row.status,
      people: crew.length, hours: round2(crew.reduce((sum, member) => sum + member.hours, 0)), overtime: round2(crew.reduce((sum, member) => sum + member.overtime, 0)),
      activities: row.activities ? row.activities.slice(0, 200) : null,
      occurrences: ((row.occurrences as unknown as Occurrence[]) ?? []).length, photos: ((row.photos as unknown as Photo[]) ?? []).length,
      createdBy: row.createdByUserId ? userName.get(row.createdByUserId) ?? null : null, closedAt: row.closedAt,
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
    const order = await this.orderOf(actor.companyId, orderId);
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
    const [rows, running] = await Promise.all([
      this.prisma.service_DailyReport.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: [{ date: 'desc' }, { id: 'desc' }], take: limit }),
      this.prisma.service_Order.findMany({ where: { companyId: actor.companyId, status: 'em_execucao', inactiveAt: null }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] }),
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
    const names = await this.namesOf([row.createdByUserId, row.closedByUserId]);
    const steps = this.stepsOf(order);
    const saved = new Map(((row.progress as unknown as StepProgress[]) ?? []).map((item) => [item.step, item.percent]));
    return {
      id: row.id, date: iso(row.date)!, shift: row.shift, weather: row.weather, status: row.status, editable: row.status !== 'fechado',
      crew: (row.crew as unknown as CrewMember[]) ?? [], activities: row.activities,
      progress: steps.map((step) => ({ step: step.step, title: step.title, percent: saved.get(step.step) ?? 0 })),
      occurrences: (row.occurrences as unknown as Occurrence[]) ?? [], equipment: row.equipment, photos: (row.photos as unknown as Photo[]) ?? [], notes: row.notes,
      createdBy: row.createdByUserId ? names.get(row.createdByUserId) ?? null : null, closedAt: row.closedAt, closedBy: row.closedByUserId ? names.get(row.closedByUserId) ?? null : null,
      order: await this.orderBrief(order), roles: this.rolesOf(order),
    };
  }

  async get(actor: OrderActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    return this.present(row, await this.orderOf(actor.companyId, row.orderId));
  }

  /** RDO em branco de um dia: a equipe escalada na OS e o avanço como estava no último RDO. */
  async template(actor: OrderActor, orderId: number, query: Record<string, string>) {
    const order = await this.orderOf(actor.companyId, orderId);
    const date = blank(query.date) ? today() : dateOf(query.date, 'Data');
    const [labor, previous] = await Promise.all([
      this.laborOf(order),
      this.prisma.service_DailyReport.findFirst({ where: { orderId, inactiveAt: null, date: { lte: asDate(date) } }, orderBy: [{ date: 'desc' }, { id: 'desc' }] }),
    ]);
    const last = new Map(((previous?.progress as unknown as StepProgress[]) ?? []).map((item) => [item.step, item.percent]));
    // a equipe de ontem é o melhor palpite para hoje; sem RDO anterior, a equipe escalada na OS
    const yesterday = (previous?.crew as unknown as CrewMember[]) ?? [];
    const team = ((order.team as unknown as Array<{ name: string; role: string }>) ?? []).map((member) => ({ name: member.name, role: member.role, hours: labor.hoursPerDay, overtime: 0 }));
    return {
      id: null, date, shift: 'integral', weather: 'bom', status: 'rascunho', editable: true,
      crew: yesterday.length ? yesterday.map((member) => ({ ...member, overtime: 0 })) : team, activities: null,
      progress: this.stepsOf(order).map((step) => ({ step: step.step, title: step.title, percent: last.get(step.step) ?? 0 })),
      occurrences: [], equipment: previous?.equipment ?? null, photos: [], notes: null,
      createdBy: null, closedAt: null, closedBy: null, order: await this.orderBrief(order), roles: this.rolesOf(order), hoursPerDay: labor.hoursPerDay,
    };
  }

  // ------------------------------------------------------------------ escrita

  private dataOf(body: Body, order: Service_Order): Omit<Prisma.Service_DailyReportUncheckedCreateInput, 'companyId' | 'orderId' | 'date'> {
    const shift = blank(body.shift) ? 'integral' : String(body.shift);
    if (!(REPORT_SHIFTS as readonly string[]).includes(shift)) throw new BadRequestException('Turno inválido');
    const weather = blank(body.weather) ? 'bom' : String(body.weather);
    if (!(REPORT_WEATHERS as readonly string[]).includes(weather)) throw new BadRequestException('Clima inválido');

    const rawCrew = Array.isArray(body.crew) ? body.crew : [];
    if (rawCrew.length > 80) throw new BadRequestException('Pessoas demais na equipe do dia');
    const crew: CrewMember[] = rawCrew
      .map((raw: Body) => ({ name: clean(raw?.name, 120), role: clean(raw?.role, 80), hours: hoursOf(raw?.hours, 'Horas'), overtime: hoursOf(raw?.overtime, 'Horas extras', 16) }))
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
    const order = await this.orderOf(actor.companyId, orderId);
    if (order.status !== 'em_execucao' && order.status !== 'concluida') {
      throw new ConflictException(order.status === 'encerrada' || order.status === 'cancelada' ? 'Esta ordem de serviço não recebe mais RDO' : 'A obra ainda não começou: inicie a execução da OS para lançar o RDO');
    }
    const date = dateOf(body.date, 'Data');
    this.assertDate(order, date);
    const created = await this.prisma.service_DailyReport
      .create({ data: { companyId: actor.companyId, orderId, date: asDate(date), createdByUserId: actor.userId || null, ...this.dataOf(body, order) } })
      .catch((error) => this.duplicate(error));
    return this.present(created, order);
  }

  async update(actor: OrderActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    if (row.status === 'fechado') throw new ConflictException('RDO fechado: reabra, com o motivo, para corrigir');
    const order = await this.orderOf(actor.companyId, row.orderId);
    const date = blank(body.date) ? iso(row.date)! : dateOf(body.date, 'Data');
    this.assertDate(order, date);
    const saved = await this.prisma.service_DailyReport.update({ where: { id }, data: { date: asDate(date), ...this.dataOf(body, order) } }).catch((error) => this.duplicate(error));
    return this.present(saved, order);
  }

  /** Fecha o RDO: a partir daqui ele não é editado. */
  async close(actor: OrderActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    if (row.status === 'fechado') throw new ConflictException('Este RDO já está fechado');
    const crew = (row.crew as unknown as CrewMember[]) ?? [];
    // dia parado não tem equipe nem atividade: nesse caso a ocorrência ou o clima explicam
    const stopped = row.weather === 'impraticavel' || ((row.occurrences as unknown as Occurrence[]) ?? []).length > 0;
    if (!crew.length && !row.activities && !stopped) throw new BadRequestException('Informe a equipe do dia ou o que foi feito antes de fechar. Se o dia foi parado, registre a ocorrência ou o clima.');
    const saved = await this.prisma.service_DailyReport.update({ where: { id }, data: { status: 'fechado', closedAt: new Date(), closedByUserId: actor.userId || null } });
    return this.present(saved, await this.orderOf(actor.companyId, row.orderId));
  }

  /** Reabre um RDO fechado para correção; o motivo fica no histórico. */
  async reopen(actor: OrderActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    if (row.status !== 'fechado') throw new ConflictException('Este RDO não está fechado');
    const note = clean(body.note, 500);
    if (!note) throw new BadRequestException('Informe o motivo da correção');
    const saved = await this.prisma.$transaction(async (tx) => {
      await recordFlowEvent(tx, 'service_report', { companyId: row.companyId, entityId: row.id, type: 'reaberto', from: 'fechado', to: 'rascunho', userId: actor.userId, note });
      return tx.service_DailyReport.update({ where: { id }, data: { status: 'rascunho', closedAt: null, closedByUserId: null } });
    });
    return this.present(saved, await this.orderOf(actor.companyId, row.orderId));
  }

  /** Apaga um rascunho (RDO fechado não é apagado). */
  async remove(actor: OrderActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    if (row.status === 'fechado') throw new ConflictException('RDO fechado não é apagado: reabra para corrigir');
    await this.prisma.service_DailyReport.delete({ where: { id } });
    return { id };
  }
}
