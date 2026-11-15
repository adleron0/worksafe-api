import { Prisma, ServiceOrderStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { DocumentIssue, documentIssues } from './document.queries';
import { STATUS_LABEL } from './employee.service';

/**
 * Alocação: onde cada funcionário está escalado e quando está indisponível.
 *
 * Nada é gravado para isso. A alocação sai da equipe da OS (com as datas da
 * obra, ou o período da pessoa dentro dela) e a indisponibilidade sai do
 * histórico do funcionário (férias, afastamento, suspensão).
 */
type Db = PrismaService | Prisma.TransactionClient;
export interface TeamEntry { name: string; role: string; userId?: number | null; employeeId?: number | null; professionalId?: number | null; from?: string | null; to?: string | null }
export interface AllocationSpan {
  employeeId: number; orderId: number; number: string; title: string; status: ServiceOrderStatus; role: string;
  /** null = a obra ainda não tem data marcada */
  start: string | null; end: string | null;
}
export interface UnavailableSpan { employeeId: number; type: string; label: string; start: string; end: string | null }

const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
export const allocationToday = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const later = (a: string, b: string) => (a > b ? a : b);
const UNAVAILABLE_TYPES = ['ferias', 'afastamento', 'suspensao'];
const UNAVAILABLE_LABEL: Record<string, string> = { ferias: 'Férias', afastamento: 'Afastamento', suspensao: 'Suspensão' };
/** Dois períodos se cruzam? Fim em branco = sem data para acabar. */
export const overlaps = (aStart: string, aEnd: string | null, bStart: string, bEnd: string | null) => aStart <= (bEnd ?? '9999-12-31') && bStart <= (aEnd ?? '9999-12-31');

type OrderRow = { id: number; number: string; title: string; status: ServiceOrderStatus; team: Prisma.JsonValue; plannedStart: Date | null; plannedEnd: Date | null; startedAt: Date | null; finishedAt: Date | null };

/** O período de uma obra para o mapa: datas reais quando já começou; previstas antes disso. */
export function orderPeriod(order: Pick<OrderRow, 'status' | 'plannedStart' | 'plannedEnd' | 'startedAt' | 'finishedAt'>, today: string): { start: string | null; end: string | null } {
  const start = iso(order.startedAt) ?? iso(order.plannedStart);
  if (!start) return { start: null, end: null };
  const finished = iso(order.finishedAt);
  if (finished) return { start, end: later(finished, start) };
  const planned = iso(order.plannedEnd);
  // em execução e passou do previsto: a pessoa continua lá até a obra ser concluída
  if (order.status === 'em_execucao') return { start, end: later(planned ?? today, today) };
  return { start, end: planned ? later(planned, start) : start };
}

/** As alocações que saem da equipe de cada OS (só quem está ligado ao cadastro). */
export function spansOf(orders: OrderRow[], today: string): AllocationSpan[] {
  const out: AllocationSpan[] = [];
  for (const order of orders) {
    const period = orderPeriod(order, today);
    for (const member of ((order.team as unknown as TeamEntry[]) ?? [])) {
      if (!member?.employeeId) continue;
      // período da pessoa dentro da obra, quando informado; senão a obra inteira
      const start = member.from ?? period.start;
      const end = member.to ?? period.end ?? start;
      out.push({ employeeId: member.employeeId, orderId: order.id, number: order.number, title: order.title, status: order.status, role: member.role, start: start ?? null, end: start ? end ?? start : null });
    }
  }
  return out;
}

const ACTIVE_ORDER: Prisma.Service_OrderWhereInput = { inactiveAt: null, status: { not: 'cancelada' }, team: { not: Prisma.DbNull } };

/** Alocações e indisponibilidades que tocam uma janela de datas. */
export async function allocationWindow(prisma: Db, companyId: number, from: string, to: string, today = allocationToday()) {
  const [orders, events] = await Promise.all([
    prisma.service_Order.findMany({
      where: { companyId, ...ACTIVE_ORDER, OR: [{ plannedStart: null, startedAt: null }, { plannedStart: { lte: asDate(to) } }, { startedAt: { lte: asDate(to) } }] },
      select: { id: true, number: true, title: true, status: true, team: true, plannedStart: true, plannedEnd: true, startedAt: true, finishedAt: true }, take: 3000,
    }),
    prisma.hr_EmployeeEvent.findMany({
      where: { companyId, inactiveAt: null, type: { in: UNAVAILABLE_TYPES }, startDate: { lte: asDate(to) }, OR: [{ endDate: null }, { endDate: { gte: asDate(from) } }] },
      select: { employeeId: true, type: true, startDate: true, endDate: true },
    }),
  ]);
  const all = spansOf(orders, today);
  return {
    spans: all.filter((span) => span.start && overlaps(span.start, span.end, from, to)),
    undated: all.filter((span) => !span.start),
    unavailable: events.map((event): UnavailableSpan => ({ employeeId: event.employeeId, type: event.type, label: UNAVAILABLE_LABEL[event.type] ?? STATUS_LABEL.indisponivel, start: iso(event.startDate)!, end: iso(event.endDate) })),
  };
}

export interface TeamOption {
  id: number; name: string; userId: number | null; roles: Array<{ id: number; name: string; isPrimary: boolean }>;
  /** Outras obras em que a pessoa está escalada no período. */
  busy: Array<{ orderId: number; number: string; title: string; start: string | null; end: string | null }>;
  /** Férias, afastamento ou suspensão no período (sem o motivo). */
  unavailable: Array<{ label: string; start: string; end: string | null }>;
  documents: DocumentIssue[];
  free: boolean;
}

/**
 * Quem pode ser escalado numa obra, com o que importa para decidir: livre no
 * período, em outra obra, de férias, e pendências de documento até o fim da obra.
 * Nada bloqueia; a tela avisa.
 */
export async function teamOptions(prisma: Db, companyId: number, input: { from: string | null; to: string | null; exceptOrderId?: number; seesReason?: boolean }): Promise<TeamOption[]> {
  const today = allocationToday();
  const from = input.from ?? today;
  const to = input.to ?? from;
  const employees = await prisma.hr_Employee.findMany({
    where: { companyId, inactiveAt: null, OR: [{ terminationDate: null }, { terminationDate: { gt: asDate(from) } }] },
    orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 2000,
    select: { id: true, name: true, userId: true, roles: { orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }], select: { isPrimary: true, professional: { select: { id: true, name: true } } } } },
  });
  const ids = employees.map((employee) => employee.id);
  const [window, issues] = await Promise.all([allocationWindow(prisma, companyId, from, to, today), documentIssues(prisma, companyId, ids, today, to)]);
  return employees.map((employee) => {
    const busy = window.spans.filter((span) => span.employeeId === employee.id && span.orderId !== input.exceptOrderId).map(({ orderId, number, title, start, end }) => ({ orderId, number, title, start, end }));
    const unavailable = window.unavailable.filter((span) => span.employeeId === employee.id && overlaps(span.start, span.end, from, to))
      // o tipo (suspensão, afastamento) só aparece para quem pode ver o histórico; férias todos veem
      .map((span) => ({ label: input.seesReason || span.type === 'ferias' ? span.label : STATUS_LABEL.indisponivel, start: span.start, end: span.end }));
    return {
      id: employee.id, name: employee.name, userId: employee.userId,
      roles: employee.roles.map((role) => ({ id: role.professional.id, name: role.professional.name, isPrimary: role.isPrimary })),
      busy, unavailable, documents: issues.get(employee.id) ?? [], free: !busy.length && !unavailable.length,
    };
  });
}

export interface WorkedDay { employeeId: number; date: string; orderId: number; hours: number }

/** Os dias em que cada funcionário trabalhou de fato, conforme os RDOs lançados na janela. */
export async function workedDays(prisma: Db, companyId: number, from: string, to: string): Promise<WorkedDay[]> {
  const reports = await prisma.service_DailyReport.findMany({
    where: { companyId, inactiveAt: null, date: { gte: asDate(from), lte: asDate(to) } }, select: { orderId: true, date: true, crew: true }, take: 10000,
  });
  const byKey = new Map<string, WorkedDay>();
  for (const report of reports) for (const member of ((report.crew as unknown as Array<{ employeeId?: number | null; hours?: number; overtime?: number }>) ?? [])) {
    if (!member?.employeeId) continue;
    const date = iso(report.date)!;
    // dois turnos no mesmo dia e na mesma obra somam
    const key = `${member.employeeId}|${date}|${report.orderId}`;
    const row = byKey.get(key) ?? { employeeId: member.employeeId, date, orderId: report.orderId, hours: 0 };
    row.hours = Math.round((row.hours + (Number(member.hours) || 0) + (Number(member.overtime) || 0)) * 100) / 100;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}
