import { entityFilter } from 'src/features/company-entity/entity.field';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ServiceOrderStatus, Service_Order } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { FlowDefinition, assertMove, listFlowEvents, recordFlowEvent } from 'src/common/flow/flow';
import { SHIFTS, orderPeriod, teamOptions } from 'src/features/hr/allocation';
import { OrderResultService } from './order-result.service';
import { Schedule, donePercent, parseSchedule, plannedPercent, stepsOf as scheduleSteps } from './order-schedule';

/**
 * Ordem de serviço: a obra que nasce de uma proposta de serviço aceita.
 *
 * Nada é digitado de novo: o escopo (itens sem preço), o cronograma e o custo
 * orçado vêm da proposta. A operação mobiliza, agenda, executa e conclui; a
 * conclusão libera para faturar as parcelas "após a conclusão".
 */
type Tx = Prisma.TransactionClient;
type Body = Record<string, any>;
export interface OrderActor { userId: number; companyId: number; canSeeCosts: boolean; seesAll: boolean; canSeeValues?: boolean }
/** Quem tem vê todas as OS; quem não tem vê só as suas. */
export const ALL_ORDERS_PERMISSION = 'all_ordens_de_servico';

/**
 * "Só as minhas": sem a permissão de ver todas, a pessoa enxerga as OS em que é
 * responsável, em que está escalada na equipe, ou que nasceram de uma venda sua.
 */
export async function ordersVisibleTo(prisma: PrismaService, actor: Pick<OrderActor, 'userId' | 'companyId' | 'seesAll'>): Promise<Prisma.Service_OrderWhereInput> {
  if (actor.seesAll) return {};
  const [sold, employee] = await Promise.all([
    prisma.commercial_Contract.findMany({ where: { companyId: actor.companyId, sellerId: actor.userId }, select: { id: true }, take: 2000 }),
    // o funcionário ligado a este usuário: quem foi escalado pelo cadastro vê a OS mesmo que o login tenha sido ligado depois
    actor.userId ? prisma.hr_Employee.findFirst({ where: { companyId: actor.companyId, userId: actor.userId }, select: { id: true } }) : null,
  ]);
  return { OR: [
    { responsibleUserId: actor.userId },
    { team: { array_contains: [{ userId: actor.userId }] } },
    ...(employee ? [{ team: { array_contains: [{ employeeId: employee.id }] } }] : []),
    ...(sold.length ? [{ contractId: { in: sold.map((contract) => contract.id) } }] : []),
  ] };
}

export const SERVICE_ORDER_FLOW: FlowDefinition<ServiceOrderStatus> = {
  entity: 'service_order',
  labels: {
    a_liberar: 'A liberar', a_mobilizar: 'A mobilizar', agendada: 'Agendada', em_execucao: 'Em execução',
    concluida: 'Concluída', encerrada: 'Encerrada', cancelada: 'Cancelada',
  },
  moves: {
    a_liberar: ['a_mobilizar', 'cancelada'],
    a_mobilizar: ['agendada', 'a_liberar', 'cancelada'],
    agendada: ['em_execucao', 'a_mobilizar', 'cancelada'],
    em_execucao: ['concluida', 'agendada', 'cancelada'],
    concluida: ['encerrada', 'em_execucao'],
    encerrada: ['concluida'],
    cancelada: ['a_mobilizar'],
  },
};
const STATUSES = Object.keys(SERVICE_ORDER_FLOW.labels) as ServiceOrderStatus[];
/** Conferência padrão da mobilização; cada OS pode ganhar itens. */
const DEFAULT_CHECKLIST = [
  'Equipe definida', 'Materiais separados', 'Equipamentos reservados', 'Documentação de acesso enviada ao cliente', 'Data confirmada com o cliente',
];
const GROUP_LABEL: Record<string, string> = { mao_de_obra: 'Mão de obra', locacao: 'Locações', material: 'Materiais', avulso: 'Outros' };

export interface ChecklistItem { id: string; title: string; done: boolean; doneAt: string | null; doneBy: string | null }
/** `employeeId` liga a pessoa ao cadastro de funcionários; sem ele é pessoa avulsa (nome digitado). `from`/`to`: período dela dentro da obra. */
export interface TeamMember { name: string; role: string; userId?: number | null; employeeId?: number | null; professionalId?: number | null; from?: string | null; to?: string | null; shift?: string | null }

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const text = (value: unknown, max = 10000) => String(value ?? '').trim().slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
/** Hoje no horário de Brasília (UTC−3). */
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
function dateOf(value: unknown, label: string): string {
  const raw = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(String(value ?? '').trim())?.[1] ?? '';
  if (!raw || Number.isNaN(asDate(raw).getTime()) || iso(asDate(raw)) !== raw) throw new BadRequestException(`${label}: informe uma data válida`);
  return raw;
}
const newId = () => Math.random().toString(36).slice(2, 10);

@Injectable()
export class ServiceOrderService {
  constructor(private readonly prisma: PrismaService, private readonly results: OrderResultService) {}

  // ------------------------------------------------------------------ criação

  /**
   * OS da venda fechada de um serviço. Chamar duas vezes devolve a mesma.
   * Nasce "A liberar" enquanto faltar o pedido do cliente; com ele, "A mobilizar".
   */
  async createFromContract(tx: Tx, contractId: number, userId?: number | null): Promise<{ id: number; number: string } | null> {
    const existing = await tx.service_Order.findUnique({ where: { contractId }, select: { id: true, number: true } });
    if (existing) return existing;
    const contract = await tx.commercial_Contract.findUniqueOrThrow({ where: { id: contractId } });
    // só venda de serviço abre OS: treinamento segue pelas turmas e locação pela ordem de locação
    if (contract.kind !== 'servico' || contract.status === 'cancelado') return null;
    const proposal = await tx.commercial_Proposal.findUniqueOrThrow({
      where: { id: contract.proposalId },
      include: { sections: { orderBy: [{ order: 'asc' }, { id: 'asc' }], include: { items: { orderBy: [{ order: 'asc' }, { id: 'asc' }] } } }, customer: { include: { city: true, state: true } } },
    });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(740121::int, ${contract.companyId}::int)`;
    const again = await tx.service_Order.findUnique({ where: { contractId }, select: { id: true, number: true } });
    if (again) return again;

    const year = contract.acceptedAt.getFullYear();
    const last = await tx.service_Order.aggregate({ where: { companyId: contract.companyId, year }, _max: { sequence: true } });
    const sequence = (last._max.sequence ?? 0) + 1;

    // escopo: o que foi vendido, sem preço; treinamento fica de fora
    const scope = proposal.sections
      .map((section) => ({
        title: section.title, kind: section.kind,
        items: section.items.filter((item) => item.type !== 'treinamento').map((item) => ({
          type: item.type, description: item.description, unit: item.unit, quantity: Number(item.quantity),
          workDays: item.type === 'mao_de_obra' ? item.workDays ?? proposal.workDays : null,
          hoursPerDay: item.hoursPerDay === null ? null : Number(item.hoursPerDay), overtimeHours: Number(item.overtimeHours),
          night: item.night, weekend: item.weekend, travel: item.travel,
        })),
      }))
      .filter((section) => section.items.length > 0);
    // custo orçado por grupo (só serviço) e a receita da proposta
    const groups = new Map<string, number>();
    for (const section of proposal.sections) for (const item of section.items) {
      if (item.type === 'treinamento') continue;
      groups.set(item.type, round2((groups.get(item.type) ?? 0) + Number(item.cost)));
    }
    const budget = {
      revenue: Number(proposal.total), cost: Number(proposal.totalCost), tax: Number(proposal.totalTax), commission: Number(proposal.commission), profit: Number(proposal.profit),
      groups: [...groups.entries()].map(([type, cost]) => ({ type, label: GROUP_LABEL[type] ?? type, cost })),
    };
    const customer = proposal.customer as typeof proposal.customer & { address?: string | null; addressNumber?: number | string | null; neighborhood?: string | null };
    const location = [customer.address, customer.neighborhood, [customer.city?.name, customer.state?.uf].filter(Boolean).join('/')].filter(Boolean).join(' · ').slice(0, 300) || null;
    const released = Boolean(contract.customerOrderNumber);

    const created = await tx.service_Order.create({ data: {
      companyId: contract.companyId, number: `OS-${year}-${String(sequence).padStart(4, '0')}`, year, sequence,
      contractId, proposalId: contract.proposalId, customerId: contract.customerId,
      title: contract.title, description: proposal.description, status: released ? 'a_mobilizar' : 'a_liberar',
      contactName: proposal.contactName, contactPhone: proposal.contactPhone, contactEmail: proposal.contactEmail, location,
      scope: scope as unknown as Prisma.InputJsonValue, schedule: (proposal.schedule ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      budget: budget as unknown as Prisma.InputJsonValue,
      checklist: DEFAULT_CHECKLIST.map((title) => ({ id: newId(), title, done: false, doneAt: null, doneBy: null })) as unknown as Prisma.InputJsonValue,
    } });
    await recordFlowEvent(tx, SERVICE_ORDER_FLOW.entity, {
      companyId: contract.companyId, entityId: created.id, type: 'criada', to: created.status, userId,
      note: released ? `Proposta aceita com o pedido do cliente ${contract.customerOrderNumber}` : 'Proposta aceita; aguardando o pedido do cliente',
    });
    return { id: created.id, number: created.number };
  }

  /** O pedido do cliente chegou: a OS que esperava por ele segue para a mobilização. */
  async onCustomerOrder(contractId: number, userId?: number | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const contract = await tx.commercial_Contract.findUnique({ where: { id: contractId }, select: { customerOrderNumber: true, companyId: true } });
      if (!contract?.customerOrderNumber) return;
      const moved = await tx.service_Order.updateMany({ where: { contractId, status: 'a_liberar', inactiveAt: null }, data: { status: 'a_mobilizar' } });
      if (!moved.count) return;
      const order = await tx.service_Order.findUniqueOrThrow({ where: { contractId }, select: { id: true } });
      await recordFlowEvent(tx, SERVICE_ORDER_FLOW.entity, {
        companyId: contract.companyId, entityId: order.id, type: 'liberada', from: 'a_liberar', to: 'a_mobilizar', userId,
        note: `Pedido do cliente ${contract.customerOrderNumber} informado`,
      });
    });
  }

  /** Vendas de serviço fechadas antes de existir OS ganham a sua na primeira abertura do quadro. */
  private async backfill(companyId: number): Promise<void> {
    const pending = await this.prisma.commercial_Contract.findMany({
      where: { companyId, kind: 'servico', status: 'vigente', inactiveAt: null, id: { notIn: (await this.prisma.service_Order.findMany({ where: { companyId }, select: { contractId: true } })).map((o) => o.contractId) } },
      select: { id: true },
    });
    for (const contract of pending) await this.prisma.$transaction((tx) => this.createFromContract(tx, contract.id));
  }

  /** OS de uma venda fechada (para a proposta e o faturamento mostrarem em que pé está). */
  async ofContract(contractId: number) {
    return this.prisma.service_Order.findUnique({ where: { contractId }, select: { id: true, number: true, status: true } });
  }

  // ------------------------------------------------------------------ leitura

  private async byId(actor: OrderActor, id: number): Promise<Service_Order> {
    const row = await this.prisma.service_Order.findFirst({ where: { id, companyId: actor.companyId, AND: [await ordersVisibleTo(this.prisma, actor)] } });
    if (!row) throw new NotFoundException('Ordem de serviço não encontrada');
    return row;
  }

  /** Atrasada: passou da data marcada e ainda não andou. */
  private lateOf(row: Pick<Service_Order, 'status' | 'plannedStart' | 'plannedEnd'>): boolean {
    const now = today();
    if (row.status === 'a_mobilizar' || row.status === 'agendada') return !!row.plannedStart && iso(row.plannedStart)! < now;
    if (row.status === 'em_execucao') return !!row.plannedEnd && iso(row.plannedEnd)! < now;
    return false;
  }

  async list(actor: OrderActor, query: Record<string, string>) {
    await this.backfill(actor.companyId);
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 20));
    const term = clean(query.search, 80);
    const customerIds = term ? (await this.prisma.customer.findMany({
      where: { companyId: actor.companyId, OR: [{ name: { contains: term, mode: 'insensitive' } }, { corporateName: { contains: term, mode: 'insensitive' } }] }, select: { id: true }, take: 200,
    })).map((customer) => customer.id) : [];
    const scope: Prisma.Service_OrderWhereInput = {
      companyId: actor.companyId, inactiveAt: null, AND: [await ordersVisibleTo(this.prisma, actor)],
      ...(Number(query.responsibleUserId) > 0 ? { responsibleUserId: Number(query.responsibleUserId) } : {}),
      ...entityFilter(query.entityId),
      ...(term ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } }, { customerId: { in: customerIds } }] } : {}),
    };
    const status = STATUSES.includes(query.status as ServiceOrderStatus) ? (query.status as ServiceOrderStatus) : undefined;
    // canceladas só aparecem quando pedidas
    let where: Prisma.Service_OrderWhereInput = { ...scope, status: status ?? { not: 'cancelada' } };
    // "sem RDO hoje": obras em execução que ainda não têm RDO lançado no dia
    if (query.noReportToday === '1') {
      const withReport = await this.prisma.service_DailyReport.findMany({ where: { companyId: actor.companyId, date: asDate(today()), inactiveAt: null }, select: { orderId: true } });
      where = { ...scope, status: 'em_execucao', id: { notIn: withReport.map((report) => report.orderId) } };
    }
    const [rows, total, groups] = await Promise.all([
      this.prisma.service_Order.findMany({ where, orderBy: [{ plannedStart: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }], skip: page * limit, take: limit }),
      this.prisma.service_Order.count({ where }),
      this.prisma.service_Order.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    ]);
    const [customers, users, proposals, contracts] = await Promise.all([
      this.prisma.customer.findMany({ where: { id: { in: rows.map((row) => row.customerId) } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: rows.map((row) => row.responsibleUserId).filter((id): id is number => !!id) } }, select: { id: true, name: true } }),
      this.prisma.commercial_Proposal.findMany({ where: { id: { in: rows.map((row) => row.proposalId) } }, select: { id: true, number: true } }),
      this.prisma.commercial_Contract.findMany({ where: { id: { in: rows.map((row) => row.contractId) } }, select: { id: true, customerOrderNumber: true } }),
    ]);
    const customerOf = new Map(customers.map((c) => [c.id, c]));
    const userOf = new Map(users.map((u) => [u.id, u.name]));
    const proposalOf = new Map(proposals.map((p) => [p.id, p]));
    const orderNumberOf = new Map(contracts.map((c) => [c.id, c.customerOrderNumber]));
    // obra andando: avanço × previsto e o RDO de hoje, para a lista mostrar sem abrir
    const running = rows.filter((row) => ['em_execucao', 'concluida'].includes(row.status));
    const reports = running.length ? await this.prisma.service_DailyReport.findMany({
      where: { orderId: { in: running.map((row) => row.id) }, inactiveAt: null }, orderBy: [{ date: 'asc' }, { id: 'asc' }], select: { orderId: true, date: true, status: true, progress: true },
    }) : [];
    const now = today();
    const progressOf = new Map(running.map((row) => {
      const mine = reports.filter((report) => report.orderId === row.id);
      const last = new Map<number, number>();
      for (const report of mine) for (const item of (report.progress as unknown as Array<{ step: number; percent: number }>) ?? []) last.set(item.step, item.percent);
      const todays = mine.filter((report) => iso(report.date) === now);
      return [row.id, {
        done: donePercent(row.schedule as Schedule | null, last),
        planned: row.startedAt ? plannedPercent(row.schedule as Schedule | null, iso(row.startedAt)!, iso(row.finishedAt) ?? now) : null,
        todayReport: row.status !== 'em_execucao' ? null : todays.length === 0 ? 'nenhum' : todays.every((report) => report.status === 'fechado') ? 'fechado' : 'rascunho',
        lastReport: mine.length ? iso(mine[mine.length - 1].date) : null,
      }];
    }));
    return {
      total,
      rows: rows.map((row) => {
        const checklist = (row.checklist as unknown as ChecklistItem[]) ?? [];
        return {
          id: row.id, number: row.number, entityId: row.entityId, status: row.status, title: row.title, customer: customerOf.get(row.customerId) ?? { id: row.customerId, name: '' },
          proposal: proposalOf.get(row.proposalId) ?? null, customerOrderNumber: orderNumberOf.get(row.contractId) ?? null,
          plannedStart: iso(row.plannedStart), plannedEnd: iso(row.plannedEnd), startedAt: iso(row.startedAt), finishedAt: iso(row.finishedAt),
          responsible: row.responsibleUserId ? userOf.get(row.responsibleUserId) ?? null : null, location: row.location,
          checklist: { done: checklist.filter((item) => item.done).length, total: checklist.length }, late: this.lateOf(row), progress: progressOf.get(row.id) ?? null,
        };
      }),
      summary: Object.fromEntries(groups.map((g) => [g.status, g._count._all])),
    };
  }

  private async present(row: Service_Order, actor: OrderActor) {
    const [customer, proposal, contract, responsible, events] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: row.customerId }, select: { id: true, name: true, corporateName: true, cnpj: true, phone: true, email: true } }),
      this.prisma.commercial_Proposal.findUnique({ where: { id: row.proposalId }, select: { id: true, number: true } }),
      this.prisma.commercial_Contract.findUnique({ where: { id: row.contractId }, select: { id: true, number: true, customerOrderNumber: true, customerOrderDate: true, customerOrderUrl: true, customerOrderFileName: true } }),
      row.responsibleUserId ? this.prisma.user.findUnique({ where: { id: row.responsibleUserId }, select: { id: true, name: true } }) : null,
      listFlowEvents(this.prisma, SERVICE_ORDER_FLOW.entity, row.id),
    ]);
    const userIds = [...new Set(events.map((event) => event.userId).filter((id): id is number => !!id))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const userName = new Map(users.map((user) => [user.id, user.name]));
    return {
      id: row.id, number: row.number, entityId: row.entityId, status: row.status, statusLabel: SERVICE_ORDER_FLOW.labels[row.status], nextStatuses: SERVICE_ORDER_FLOW.moves[row.status],
      title: row.title, description: row.description, statusNote: row.statusNote, late: this.lateOf(row),
      customer, proposal,
      contract: contract ? { id: contract.id, number: contract.number } : null,
      customerOrder: contract ? { number: contract.customerOrderNumber, date: iso(contract.customerOrderDate), fileUrl: contract.customerOrderUrl, fileName: contract.customerOrderFileName } : null,
      contactName: row.contactName, contactPhone: row.contactPhone, contactEmail: row.contactEmail, location: row.location,
      // ponto no mapa: o da própria obra, o do local da empresa ou, sem eles, o do cliente
      point: await this.pointOf(row),
      responsible, team: (row.team as unknown as TeamMember[]) ?? [],
      plannedStart: iso(row.plannedStart), plannedEnd: iso(row.plannedEnd), startedAt: iso(row.startedAt), finishedAt: iso(row.finishedAt),
      scope: row.scope, schedule: row.schedule, baseline: row.baseline, checklist: (row.checklist as unknown as ChecklistItem[]) ?? [],
      safety: row.safety, publicEnabled: row.publicEnabled, canSeeValues: !!actor.canSeeValues,
      notes: row.notes, conclusionNotes: row.conclusionNotes, closedAt: row.closedAt,
      // custo orçado e receita: só com a permissão de custos
      canSeeCosts: actor.canSeeCosts, budget: actor.canSeeCosts ? row.budget : null,
      events: events.map((event) => ({ id: event.id, type: event.type, from: event.fromStage, to: event.toStage, note: event.note, at: event.createdAt, user: event.userId ? userName.get(event.userId) ?? null : null })),
    };
  }

  /** O ponto de uma OS no mapa e de onde ele vem. */
  private async pointOf(row: Pick<Service_Order, 'latitude' | 'longitude' | 'placeId' | 'customerId'>) {
    const [place, customer] = await Promise.all([
      row.placeId ? this.prisma.company_Place.findUnique({ where: { id: row.placeId }, select: { id: true, name: true, latitude: true, longitude: true } }) : null,
      this.prisma.customer.findUnique({ where: { id: row.customerId }, select: { latitude: true, longitude: true } }),
    ]);
    const own = row.latitude !== null && row.longitude !== null ? { latitude: row.latitude, longitude: row.longitude } : null;
    const fromPlace = place?.latitude !== null && place?.latitude !== undefined && place.longitude !== null ? { latitude: place.latitude, longitude: place.longitude as number } : null;
    const fromCustomer = customer?.latitude !== null && customer?.latitude !== undefined && customer.longitude !== null ? { latitude: customer.latitude, longitude: customer.longitude as number } : null;
    const used = own ?? fromPlace ?? fromCustomer;
    return {
      latitude: used?.latitude ?? null, longitude: used?.longitude ?? null, source: own ? 'obra' : fromPlace ? 'local' : fromCustomer ? 'cliente' : null,
      own, place: place ? { id: place.id, name: place.name } : null, customer: fromCustomer,
    };
  }

  async get(actor: OrderActor, id: number) {
    return this.present(await this.byId(actor, id), actor);
  }

  async options(actor: OrderActor) {
    const users = await this.prisma.user.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    return { users, stages: STATUSES.map((id) => ({ id, name: SERVICE_ORDER_FLOW.labels[id] })), moves: SERVICE_ORDER_FLOW.moves };
  }

  // ------------------------------------------------------------------ alteração

  private checklistOf(value: unknown, previous: ChecklistItem[], userName: string): ChecklistItem[] {
    if (!Array.isArray(value)) throw new BadRequestException('Conferência inválida');
    if (value.length > 60) throw new BadRequestException('Itens demais na conferência');
    const before = new Map(previous.map((item) => [item.id, item]));
    return value.map((raw) => {
      const title = clean((raw as Body)?.title, 160);
      if (!title) throw new BadRequestException('Item da conferência sem descrição');
      const old = before.get(String((raw as Body)?.id ?? ''));
      const done = (raw as Body)?.done === true;
      // quem marcou e quando só mudam quando o item muda de estado
      const kept = old && old.done === done;
      return { id: old?.id ?? newId(), title, done, doneAt: kept ? old.doneAt : done ? new Date().toISOString() : null, doneBy: kept ? old.doneBy : done ? userName : null };
    });
  }

  /**
   * Equipe escalada. A pessoa vem do cadastro de funcionários (`employeeId`) ou é
   * avulsa (só o nome). O nome e a função ficam gravados como texto: são a
   * fotografia da escala, mesmo que o cadastro mude depois.
   */
  private async teamOf(companyId: number, value: unknown): Promise<TeamMember[]> {
    if (!Array.isArray(value)) throw new BadRequestException('Equipe inválida');
    if (value.length > 60) throw new BadRequestException('Pessoas demais na equipe');
    const id = (raw: unknown) => (Number(raw) > 0 ? Number(raw) : null);
    const employeeIds = [...new Set(value.map((raw) => id((raw as Body)?.employeeId)).filter((item): item is number => !!item))];
    const professionalIds = [...new Set(value.map((raw) => id((raw as Body)?.professionalId)).filter((item): item is number => !!item))];
    const employees = await this.prisma.hr_Employee.findMany({
      where: { id: { in: employeeIds }, companyId },
      select: { id: true, name: true, userId: true, roles: { where: { isPrimary: true }, select: { professional: { select: { id: true, name: true } } } } },
    });
    const professionals = await this.prisma.commercial_Professional.findMany({ where: { id: { in: professionalIds }, companyId }, select: { id: true, name: true } });
    if (employees.length !== employeeIds.length) throw new BadRequestException('Pessoa da equipe não encontrada no cadastro de funcionários');
    if (professionals.length !== professionalIds.length) throw new BadRequestException('Função da equipe não encontrada no cadastro de profissionais');
    const employeeOf = new Map(employees.map((employee) => [employee.id, employee]));
    const professionalOf = new Map(professionals.map((professional) => [professional.id, professional]));
    const seen = new Set<number>();
    const team: TeamMember[] = [];
    for (const raw of value as Body[]) {
      const employee = id(raw?.employeeId) ? employeeOf.get(id(raw?.employeeId)!) : null;
      if (employee) {
        if (seen.has(employee.id)) throw new BadRequestException(`${employee.name} está duas vezes na equipe`);
        seen.add(employee.id);
      }
      const primary = employee?.roles[0]?.professional ?? null;
      const professional = id(raw?.professionalId) ? professionalOf.get(id(raw?.professionalId)!) : null;
      const name = clean(raw?.name, 120) || employee?.name || '';
      if (!name) continue;
      const from = blank(raw?.from) ? null : dateOf(raw.from, `Período de ${name}`);
      const to = blank(raw?.to) ? null : dateOf(raw.to, `Período de ${name}`);
      if (from && to && to < from) throw new BadRequestException(`Período de ${name}: o fim não pode ser antes do início`);
      team.push({
        name, role: clean(raw?.role, 80) || professional?.name || primary?.name || '',
        // pelo cadastro, o usuário é o do funcionário; pessoa avulsa pode ser ligada direto a um usuário, como antes
        userId: employee ? employee.userId ?? null : id(raw?.userId),
        ...(employee ? { employeeId: employee.id, professionalId: professional?.id ?? primary?.id ?? null, from, to } : {}),
        // parte do dia em que a pessoa fica nesta obra; sem ela, o dia inteiro
        ...(employee && !blank(raw?.shift) && raw.shift !== 'integral' ? { shift: this.shiftOrFail(raw.shift, name) } : {}),
      });
    }
    const userIds = [...new Set(team.filter((member) => !member.employeeId).map((member) => member.userId).filter((item): item is number => !!item))];
    if (userIds.length) {
      const found = await this.prisma.user.count({ where: { id: { in: userIds }, companyId } });
      if (found !== userIds.length) throw new BadRequestException('Pessoa da equipe ligada a um usuário que não existe');
    }
    return team;
  }

  private shiftOrFail(value: unknown, name: string): string {
    if (!SHIFTS.some((shift) => shift.id === value)) throw new BadRequestException(`Parte do dia de ${name}: escolha dia inteiro, manhã, tarde ou noite`);
    return String(value);
  }

  /** Quem da equipe está ligado ao cadastro, a função de cada um nesta obra e até quando a obra vai: a base dos documentos da equipe. */
  async linkedTeam(actor: OrderActor, id: number) {
    const row = await this.byId(actor, id);
    const team = ((row.team as unknown as TeamMember[]) ?? []).filter((member) => member?.employeeId);
    const customer = await this.prisma.customer.findUnique({ where: { id: row.customerId }, select: { name: true } });
    return {
      id: row.id, number: row.number, title: row.title, customer: customer?.name ?? null, until: orderPeriod(row, today()).end,
      employeeIds: team.map((member) => member.employeeId as number), role: new Map(team.map((member) => [member.employeeId as number, member.role])),
      outside: ((row.team as unknown as TeamMember[]) ?? []).filter((member) => !member?.employeeId).map((member) => member.name),
    };
  }

  /** Quem pode ser escalado nesta obra: livre, em outra obra, de férias, e pendências de documento até o fim dela. */
  async teamOptions(actor: OrderActor, id: number, query: Record<string, string>, seesReason = false) {
    const row = await this.byId(actor, id);
    const from = blank(query.from) ? iso(row.startedAt) ?? iso(row.plannedStart) : dateOf(query.from, 'Início');
    const to = blank(query.to) ? iso(row.finishedAt) ?? iso(row.plannedEnd) ?? from : dateOf(query.to, 'Fim');
    const [employees, professionals] = await Promise.all([
      teamOptions(this.prisma, actor.companyId, { from, to, exceptOrderId: id, seesReason }),
      this.prisma.commercial_Professional.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    return { from, to, employees, professionals };
  }

  async update(actor: OrderActor, id: number, body: Body) {
    const row = await this.byId(actor, id);
    if (row.status === 'cancelada' || row.status === 'encerrada') throw new ConflictException(`Ordem de serviço ${SERVICE_ORDER_FLOW.labels[row.status].toLowerCase()}: reabra para alterar`);
    const data: Prisma.Service_OrderUncheckedUpdateInput = {};
    const date = (key: 'plannedStart' | 'plannedEnd', label: string) => {
      if (key in body) data[key] = blank(body[key]) ? null : asDate(dateOf(body[key], label));
    };
    date('plannedStart', 'Início previsto');
    date('plannedEnd', 'Término previsto');
    const start = 'plannedStart' in body ? (blank(body.plannedStart) ? null : String(body.plannedStart).slice(0, 10)) : iso(row.plannedStart);
    const end = 'plannedEnd' in body ? (blank(body.plannedEnd) ? null : String(body.plannedEnd).slice(0, 10)) : iso(row.plannedEnd);
    if (start && end && end < start) throw new BadRequestException('O término previsto não pode ser antes do início');
    if ('responsibleUserId' in body) {
      if (blank(body.responsibleUserId)) data.responsibleUserId = null;
      else {
        const user = await this.prisma.user.findFirst({ where: { id: Number(body.responsibleUserId), companyId: actor.companyId, inactiveAt: null }, select: { id: true } });
        if (!user) throw new BadRequestException('Responsável não encontrado');
        data.responsibleUserId = user.id;
      }
    }
    if ('team' in body) data.team = (await this.teamOf(actor.companyId, body.team)) as unknown as Prisma.InputJsonValue;
    if ('checklist' in body) {
      const me = actor.userId ? await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }) : null;
      data.checklist = this.checklistOf(body.checklist, (row.checklist as unknown as ChecklistItem[]) ?? [], me?.name ?? 'Usuário') as unknown as Prisma.InputJsonValue;
    }
    for (const [key, max] of [['location', 300], ['contactName', 160], ['contactPhone', 60], ['contactEmail', 255]] as const) {
      if (key in body) data[key] = clean(body[key], max) || null;
    }
    // ponto próprio da obra no mapa: as duas coordenadas, ou as duas em branco para voltar a valer o ponto do cliente
    if ('latitude' in body || 'longitude' in body) {
      const empty = blank(body.latitude) && blank(body.longitude);
      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      if (!empty && (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)) throw new BadRequestException('Ponto no mapa inválido');
      data.latitude = empty ? null : Math.round(latitude * 1e6) / 1e6;
      data.longitude = empty ? null : Math.round(longitude * 1e6) / 1e6;
    }
    if ('placeId' in body) {
      if (blank(body.placeId)) data.placeId = null;
      else {
        const place = await this.prisma.company_Place.findFirst({ where: { id: Number(body.placeId), companyId: actor.companyId }, select: { id: true } });
        if (!place) throw new BadRequestException('Local não encontrado');
        data.placeId = place.id;
      }
    }
    if ('notes' in body) data.notes = text(body.notes, 5000) || null;
    if ('safety' in body) data.safety = text(body.safety, 5000) || null;
    if ('schedule' in body) Object.assign(data, await this.scheduleOf(row, body.schedule));
    if ('conclusionNotes' in body) data.conclusionNotes = text(body.conclusionNotes, 5000) || null;
    await this.prisma.service_Order.update({ where: { id }, data });
    return this.get(actor, id);
  }

  /**
   * Replanejar: o cronograma da OS vira o vigente e o da proposta fica guardado
   * como linha de base (só na primeira vez). O RDO guarda o avanço pelo número
   * da etapa, então etapas que já têm avanço não podem sair do cronograma.
   */
  private async scheduleOf(row: Service_Order, value: unknown): Promise<Prisma.Service_OrderUncheckedUpdateInput> {
    let schedule: Schedule;
    try { schedule = parseSchedule(value); } catch (error) { throw new BadRequestException((error as Error).message); }
    const reports = await this.prisma.service_DailyReport.findMany({ where: { orderId: row.id, inactiveAt: null }, select: { progress: true } });
    const used = reports.reduce((max, report) => Math.max(max, ...((report.progress as unknown as Array<{ step: number; percent: number }>) ?? []).filter((item) => item.percent > 0).map((item) => item.step)), -1);
    if ((schedule.steps ?? []).length <= used) {
      const title = scheduleSteps(row.schedule as Schedule | null)[used]?.title ?? `etapa ${used + 1}`;
      throw new BadRequestException(`A etapa "${title}" já tem avanço lançado no RDO e não pode sair do cronograma`);
    }
    // compara os dois já normalizados: a ordem das chaves no JSON da proposta não pode contar como mudança
    let before: Schedule | null = null;
    try { before = row.schedule ? parseSchedule(row.schedule) : null; } catch { before = null; }
    const changed = JSON.stringify(schedule) !== JSON.stringify(before);
    if (!changed) return {};
    // replanejar é mudar etapas, início ou duração; só escrever o que fazer em cada etapa não é
    const dates = (value: Schedule | null) => JSON.stringify({ unit: value?.unit ?? 'dia', steps: (value?.steps ?? []).map((step) => [step.title, step.start, step.duration]) });
    const replanned = dates(schedule) !== dates(before);
    return {
      schedule: schedule as unknown as Prisma.InputJsonValue,
      ...(row.baseline || !row.schedule || !replanned ? {} : { baseline: row.schedule as Prisma.InputJsonValue }),
    };
  }

  /**
   * Passagem de etapa. Cada uma pede o que precisa: agendar pede a data de
   * início; iniciar e concluir registram a data real; cancelar pede o motivo.
   */
  async move(actor: OrderActor, id: number, body: Body) {
    const row = await this.byId(actor, id);
    const target = String(body.status) as ServiceOrderStatus;
    if (!STATUSES.includes(target)) throw new BadRequestException('Etapa inválida');
    assertMove(SERVICE_ORDER_FLOW, row.status, target);
    const note = clean(body.note, 500) || null;
    const data: Prisma.Service_OrderUncheckedUpdateInput = { status: target, statusNote: note };
    const now = today();
    const forward = STATUSES.indexOf(target) > STATUSES.indexOf(row.status);

    if (target === 'cancelada' && !note) throw new BadRequestException('Informe o motivo do cancelamento');
    if (target === 'agendada' && forward) {
      const start = blank(body.plannedStart) ? iso(row.plannedStart) : dateOf(body.plannedStart, 'Início previsto');
      if (!start) throw new BadRequestException('Informe a data de início para agendar');
      const end = blank(body.plannedEnd) ? iso(row.plannedEnd) : dateOf(body.plannedEnd, 'Término previsto');
      if (end && end < start) throw new BadRequestException('O término previsto não pode ser antes do início');
      data.plannedStart = asDate(start);
      data.plannedEnd = end ? asDate(end) : null;
    }
    if (target === 'em_execucao' && forward) {
      const started = blank(body.date) ? now : dateOf(body.date, 'Início');
      if (started > now) throw new BadRequestException('O início não pode ser no futuro');
      data.startedAt = asDate(started);
    }
    if (target === 'concluida' && forward) {
      const finished = blank(body.date) ? now : dateOf(body.date, 'Conclusão');
      if (finished > now) throw new BadRequestException('A conclusão não pode ser no futuro');
      if (row.startedAt && finished < iso(row.startedAt)!) throw new BadRequestException('A conclusão não pode ser antes do início');
      data.finishedAt = asDate(finished);
      if ('conclusionNotes' in body) data.conclusionNotes = text(body.conclusionNotes, 5000) || null;
    }
    // voltar uma etapa desfaz a data que a etapa tinha registrado
    if (!forward && row.status === 'em_execucao') data.startedAt = null;
    if (!forward && row.status === 'concluida') data.finishedAt = null;
    // encerrar congela o resultado (orçado × realizado); reabrir volta a calcular
    if (target === 'encerrada') { data.result = await this.results.frozen(row); data.closedAt = new Date(); }
    if (row.status === 'encerrada') { data.result = Prisma.DbNull; data.closedAt = null; }

    await this.prisma.$transaction(async (tx) => {
      // só anda se ainda estiver onde a tela viu: dois cliques não andam duas etapas
      const moved = await tx.service_Order.updateMany({ where: { id, status: row.status }, data });
      if (!moved.count) throw new ConflictException('A ordem de serviço já mudou de etapa: atualize a tela');
      // a conclusão libera o faturamento das parcelas "após a conclusão"; reabrir segura de novo
      if (target === 'concluida' && forward) {
        await tx.commercial_Contract.update({ where: { id: row.contractId }, data: { endDate: data.finishedAt as Date, ...(row.startedAt ? { startDate: row.startedAt } : {}) } });
      }
      if (!forward && row.status === 'concluida') await tx.commercial_Contract.update({ where: { id: row.contractId }, data: { endDate: null } });
      await recordFlowEvent(tx, SERVICE_ORDER_FLOW.entity, { companyId: row.companyId, entityId: id, type: forward ? 'avancou' : target === 'cancelada' ? 'cancelada' : 'voltou', from: row.status, to: target, userId: actor.userId, note });
    });
    return this.get(actor, id);
  }
}
