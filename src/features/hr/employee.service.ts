import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Hr_Employee, Hr_EmployeeEvent, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { allocationToday, allocationWindow, workedDays } from './allocation';

/**
 * Funcionários: quem trabalha para a empresa, as funções que exerce e o
 * histórico (férias, afastamento, suspensão, advertência, desligamento).
 *
 * A função é a mesma da base de cálculo do Comercial (`Commercial_Professional`),
 * para o custo de mão de obra do RDO casar pelo cadastro. A situação não é
 * gravada: sai do histórico a cada leitura. Dados pessoais e o histórico só
 * saem para quem tem a permissão de cada um.
 */
type Body = Record<string, any>;
export interface EmployeeActor { userId: number; companyId: number; seesPersonal: boolean; seesOccurrences: boolean; writesOccurrences: boolean }
export const PERSONAL_PERMISSION = 'view_dados_pessoais_funcionarios';
export const OCCURRENCES_VIEW_PERMISSION = 'view_ocorrencias_funcionarios';
export const OCCURRENCES_WRITE_PERMISSION = 'update_ocorrencias_funcionarios';

export const CONTRACT_TYPES = [
  { id: 'clt', name: 'CLT' }, { id: 'pj', name: 'PJ' }, { id: 'temporario', name: 'Temporário' }, { id: 'estagio', name: 'Estágio' },
];
/** O que alguém lança no histórico. `period`: tem começo e fim e deixa a pessoa indisponível. */
export const EVENT_TYPES = [
  { id: 'ferias', name: 'Férias', period: true, endRequired: true },
  { id: 'afastamento', name: 'Afastamento', period: true, endRequired: false },
  { id: 'suspensao', name: 'Suspensão', period: true, endRequired: true },
  { id: 'advertencia', name: 'Advertência', period: false, endRequired: false },
  { id: 'desligamento', name: 'Desligamento', period: false, endRequired: false },
];
const EVENT_LABEL: Record<string, string> = { ...Object.fromEntries(EVENT_TYPES.map((type) => [type.id, type.name])), mudanca_funcao: 'Mudança de função' };
export type EmployeeStatus = 'ativo' | 'ferias' | 'afastado' | 'suspenso' | 'desligado';
export const STATUS_LABEL: Record<EmployeeStatus | 'indisponivel', string> = {
  ativo: 'Ativo', ferias: 'De férias', afastado: 'Afastado', suspenso: 'Suspenso', desligado: 'Desligado', indisponivel: 'Indisponível',
};
const STATUS_OF_EVENT: Record<string, EmployeeStatus> = { afastamento: 'afastado', suspensao: 'suspenso', ferias: 'ferias' };
/** Dois registros valendo no mesmo dia: vale o mais forte. */
const STATUS_ORDER: EmployeeStatus[] = ['afastado', 'suspenso', 'ferias'];

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const text = (value: unknown, max = 1000) => String(value ?? '').trim().slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
/** Hoje no horário de Brasília (UTC−3). */
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
function dateOf(value: unknown, label: string): string {
  const raw = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(String(value ?? '').trim())?.[1] ?? '';
  if (!raw || Number.isNaN(asDate(raw).getTime()) || iso(asDate(raw)) !== raw) throw new BadRequestException(`${label}: informe uma data válida`);
  return raw;
}

/** CPF com os dois dígitos verificadores certos. */
export function validCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digit = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index++) sum += Number(value[index]) * (length + 1 - index);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
}

type EventRow = Pick<Hr_EmployeeEvent, 'type' | 'startDate' | 'endDate'>;
/** Situação em um dia: desligado pela data; senão o registro de período que cobre o dia; senão ativo. */
export function statusOn(employee: Pick<Hr_Employee, 'terminationDate'>, events: EventRow[], day: string): { status: EmployeeStatus; until: string | null } {
  const termination = iso(employee.terminationDate);
  if (termination && termination <= day) return { status: 'desligado', until: null };
  const covering = events
    .filter((event) => STATUS_OF_EVENT[event.type] && iso(event.startDate)! <= day && (!event.endDate || iso(event.endDate)! >= day))
    .sort((a, b) => STATUS_ORDER.indexOf(STATUS_OF_EVENT[a.type]) - STATUS_ORDER.indexOf(STATUS_OF_EVENT[b.type]));
  if (!covering.length) return { status: 'ativo', until: null };
  return { status: STATUS_OF_EVENT[covering[0].type], until: iso(covering[0].endDate) };
}

type EmployeeFull = Hr_Employee & { roles: Array<{ professionalId: number; isPrimary: boolean; professional: { id: number; name: string } }>; events: Hr_EmployeeEvent[] };
const INCLUDE = {
  roles: { orderBy: [{ isPrimary: 'desc' as const }, { id: 'asc' as const }], include: { professional: { select: { id: true, name: true } } } },
  events: { where: { inactiveAt: null }, orderBy: [{ startDate: 'desc' as const }, { id: 'desc' as const }] },
};

@Injectable()
export class EmployeeService {
  constructor(private readonly prisma: PrismaService) {}

  private async byId(actor: EmployeeActor, id: number): Promise<EmployeeFull> {
    const row = await this.prisma.hr_Employee.findFirst({ where: { id, companyId: actor.companyId }, include: INCLUDE });
    if (!row) throw new NotFoundException('Funcionário não encontrado');
    return row;
  }

  // ------------------------------------------------------------------ leitura

  /** Sem a permissão do histórico, afastamento e suspensão viram só "indisponível". */
  private shownStatus(actor: EmployeeActor, status: EmployeeStatus): EmployeeStatus | 'indisponivel' {
    return !actor.seesOccurrences && (status === 'afastado' || status === 'suspenso') ? 'indisponivel' : status;
  }

  private brief(actor: EmployeeActor, row: EmployeeFull, day: string) {
    const { status, until } = statusOn(row, row.events, day);
    const shown = this.shownStatus(actor, status);
    return {
      id: row.id, name: row.name, registration: row.registration, phone: row.phone, contractType: row.contractType,
      roles: row.roles.map((role) => ({ id: role.professional.id, name: role.professional.name, isPrimary: role.isPrimary })),
      primaryRole: row.roles.find((role) => role.isPrimary)?.professional.name ?? row.roles[0]?.professional.name ?? null,
      status: shown, statusLabel: STATUS_LABEL[shown], statusUntil: until,
      admissionDate: iso(row.admissionDate), terminationDate: iso(row.terminationDate), hasUser: !!row.userId, inactive: !!row.inactiveAt,
    };
  }

  /**
   * Lista com a situação de hoje. A situação é calculada, então o filtro por
   * ela é feito depois de ler os funcionários da empresa (são dezenas, não milhares).
   */
  async list(actor: EmployeeActor, query: Record<string, string>) {
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 20));
    const term = clean(query.search, 80);
    const termDigits = digits(term);
    const professionalId = Number(query.professionalId) > 0 ? Number(query.professionalId) : null;
    const where: Prisma.Hr_EmployeeWhereInput = {
      companyId: actor.companyId,
      // inativos (cadastrados por engano) só aparecem quando pedidos
      inactiveAt: query.inactive === 'true' ? { not: null } : null,
      ...(professionalId ? { roles: { some: { professionalId } } } : {}),
      ...(term ? { OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { registration: { contains: term, mode: 'insensitive' } },
        // busca por CPF só para quem pode ver o CPF
        ...(actor.seesPersonal && termDigits.length >= 3 ? [{ cpf: { contains: termDigits } }] : []),
      ] } : {}),
    };
    const all = await this.prisma.hr_Employee.findMany({ where, include: INCLUDE, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 5000 });
    const day = today();
    const rows = all.map((row) => this.brief(actor, row, day));
    const summary: Record<string, number> = {};
    for (const row of rows) summary[row.status] = (summary[row.status] ?? 0) + 1;
    const wanted = clean(query.status, 20);
    // sem filtro, quem já foi desligado fica fora da lista (aparece no filtro "Desligado")
    const filtered = wanted ? rows.filter((row) => row.status === wanted) : rows.filter((row) => row.status !== 'desligado');
    return { total: filtered.length, rows: filtered.slice(page * limit, page * limit + limit), summary };
  }

  private presentEvent(event: Hr_EmployeeEvent, userName: Map<number, string>) {
    return {
      id: event.id, type: event.type, typeLabel: EVENT_LABEL[event.type] ?? event.type, startDate: iso(event.startDate)!, endDate: iso(event.endDate), reason: event.reason,
      // mudança de função é registrada pelo sistema e não é apagada à mão
      removable: event.type !== 'mudanca_funcao',
      createdBy: event.createdByUserId ? userName.get(event.createdByUserId) ?? null : null, createdAt: event.createdAt,
    };
  }

  private async present(actor: EmployeeActor, row: EmployeeFull) {
    const day = today();
    const userIds = [...new Set([row.userId, ...row.events.map((event) => event.createdByUserId)].filter((id): id is number => !!id))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
    const userName = new Map(users.map((user) => [user.id, user.name]));
    const linked = row.userId ? users.find((user) => user.id === row.userId) ?? null : null;
    return {
      ...this.brief(actor, row, day),
      notes: row.notes, user: linked ? { id: linked.id, name: linked.name, email: linked.email } : null,
      // dados pessoais: só com a permissão; sem ela a tela mostra que existem, sem o conteúdo
      canSeePersonal: actor.seesPersonal,
      cpf: actor.seesPersonal ? row.cpf : null, rg: actor.seesPersonal ? row.rg : null, birthDate: actor.seesPersonal ? iso(row.birthDate) : null,
      email: actor.seesPersonal ? row.email : null, emergencyName: actor.seesPersonal ? row.emergencyName : null, emergencyPhone: actor.seesPersonal ? row.emergencyPhone : null,
      // histórico: completo só com a permissão; sem ela, só os períodos em que a pessoa não está disponível
      canSeeOccurrences: actor.seesOccurrences, canWriteOccurrences: actor.writesOccurrences,
      events: actor.seesOccurrences ? row.events.map((event) => this.presentEvent(event, userName)) : [],
      unavailable: row.events
        .filter((event) => STATUS_OF_EVENT[event.type] && (!event.endDate || iso(event.endDate)! >= day))
        .map((event) => ({ startDate: iso(event.startDate)!, endDate: iso(event.endDate), label: actor.seesOccurrences || event.type === 'ferias' ? EVENT_LABEL[event.type] : STATUS_LABEL.indisponivel }))
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    };
  }

  async get(actor: EmployeeActor, id: number) {
    return this.present(actor, await this.byId(actor, id));
  }

  /** O que as telas precisam para montar filtros e formulários. */
  async options(actor: EmployeeActor) {
    const [professionals, users, linked] = await Promise.all([
      this.prisma.commercial_Professional.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      this.prisma.hr_Employee.findMany({ where: { companyId: actor.companyId, userId: { not: null } }, select: { id: true, userId: true } }),
    ]);
    const employeeOfUser = new Map(linked.map((row) => [row.userId!, row.id]));
    return {
      professionals, contractTypes: CONTRACT_TYPES, eventTypes: EVENT_TYPES,
      statuses: (['ativo', 'ferias', ...(actor.seesOccurrences ? ['afastado', 'suspenso'] : ['indisponivel']), 'desligado'] as Array<keyof typeof STATUS_LABEL>).map((id) => ({ id, name: STATUS_LABEL[id] })),
      // usuário já ligado a um funcionário leva o id dele, para a tela não oferecer de novo
      users: users.map((user) => ({ id: user.id, name: user.name, employeeId: employeeOfUser.get(user.id) ?? null })),
      canSeePersonal: actor.seesPersonal, canSeeOccurrences: actor.seesOccurrences, canWriteOccurrences: actor.writesOccurrences,
    };
  }

  // ------------------------------------------------------------------ alocação

  /**
   * O mapa de alocação: para cada funcionário, onde está escalado (equipe das OS),
   * os dias em que trabalhou (RDOs) e quando está indisponível (férias, afastamento,
   * suspensão). Nada disso é gravado: sai da OS, do RDO e do histórico.
   */
  async allocation(actor: EmployeeActor, query: Record<string, string>, employeeId?: number) {
    const day = allocationToday();
    const from = blank(query.from) ? day : dateOf(query.from, 'Início');
    const to = blank(query.to) ? iso(new Date(asDate(from).getTime() + 27 * 86400000))! : dateOf(query.to, 'Fim');
    if (to < from) throw new BadRequestException('O fim não pode ser antes do início');
    if ((asDate(to).getTime() - asDate(from).getTime()) / 86400000 > 800) throw new BadRequestException('Período grande demais: até 800 dias');
    const employees = await this.prisma.hr_Employee.findMany({
      // quem saiu antes da janela não aparece; quem saiu no meio dela aparece até a data
      where: { companyId: actor.companyId, inactiveAt: null, ...(employeeId ? { id: employeeId } : {}), OR: [{ terminationDate: null }, { terminationDate: { gte: asDate(from) } }] },
      include: INCLUDE, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 2000,
    });
    if (employeeId && !employees.length) throw new NotFoundException('Funcionário não encontrado');
    const ids = new Set(employees.map((employee) => employee.id));
    const [window, worked] = await Promise.all([allocationWindow(this.prisma, actor.companyId, from, to, day), workedDays(this.prisma, actor.companyId, from, to)]);
    const orderIds = [...new Set([...window.spans, ...window.undated].map((span) => span.orderId))];
    const orders = orderIds.length ? await this.prisma.service_Order.findMany({ where: { id: { in: orderIds } }, select: { id: true, customerId: true, location: true } }) : [];
    const customers = orders.length ? await this.prisma.customer.findMany({ where: { id: { in: orders.map((order) => order.customerId) } }, select: { id: true, name: true } }) : [];
    const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
    const orderInfo = new Map(orders.map((order) => [order.id, { customer: customerName.get(order.customerId) ?? null, location: order.location }]));
    const present = (span: (typeof window.spans)[number]) => ({ ...span, customer: orderInfo.get(span.orderId)?.customer ?? null, location: orderInfo.get(span.orderId)?.location ?? null });
    return {
      today: day, from, to,
      employees: employees.map((employee) => ({ ...this.brief(actor, employee, day), terminationDate: iso(employee.terminationDate) })),
      spans: window.spans.filter((span) => ids.has(span.employeeId)).map(present),
      // atividades fora de OS (aula, treinamento, atividade no CT...)
      activities: window.activities.filter((span) => ids.has(span.employeeId)),
      undated: window.undated.filter((span) => ids.has(span.employeeId)).map(present),
      // o tipo (afastamento, suspensão) só para quem pode ver o histórico; férias todos veem
      unavailable: window.unavailable.filter((span) => ids.has(span.employeeId)).map((span) => ({
        employeeId: span.employeeId, start: span.start, end: span.end, label: actor.seesOccurrences || span.type === 'ferias' ? span.label : STATUS_LABEL.indisponivel,
      })),
      worked: worked.filter((row) => ids.has(row.employeeId)),
    };
  }

  // ------------------------------------------------------------------ escrita

  /** Funções: ids do cadastro de Profissionais; uma é a principal (a primeira, se nenhuma for marcada). */
  private async rolesOf(companyId: number, value: unknown, primary: unknown): Promise<Array<{ professionalId: number; isPrimary: boolean }>> {
    if (!Array.isArray(value)) throw new BadRequestException('Funções inválidas');
    const ids = [...new Set(value.map((raw) => Number((raw as Body)?.id ?? raw)).filter((id) => Number.isInteger(id) && id > 0))];
    if (ids.length > 20) throw new BadRequestException('Funções demais para uma pessoa');
    if (ids.length) {
      const found = await this.prisma.commercial_Professional.count({ where: { id: { in: ids }, companyId } });
      if (found !== ids.length) throw new BadRequestException('Função não encontrada no cadastro de profissionais');
    }
    const wanted = Number(primary) > 0 && ids.includes(Number(primary)) ? Number(primary) : ids[0];
    return ids.map((professionalId) => ({ professionalId, isPrimary: professionalId === wanted }));
  }

  private async dataOf(actor: EmployeeActor, body: Body, current: Hr_Employee | null): Promise<Prisma.Hr_EmployeeUncheckedUpdateInput> {
    const data: Prisma.Hr_EmployeeUncheckedUpdateInput = {};
    if ('name' in body || !current) {
      const name = clean(body.name, 160);
      if (name.length < 3) throw new BadRequestException('Informe o nome completo');
      data.name = name;
    }
    for (const [key, max] of [['phone', 30], ['registration', 30]] as const) if (key in body) data[key] = clean(body[key], max) || null;
    if ('notes' in body) data.notes = text(body.notes, 1000) || null;
    if ('contractType' in body) {
      if (!CONTRACT_TYPES.some((type) => type.id === body.contractType)) throw new BadRequestException('Tipo de vínculo inválido');
      data.contractType = String(body.contractType);
    }
    if ('admissionDate' in body) {
      const admission = blank(body.admissionDate) ? null : dateOf(body.admissionDate, 'Admissão');
      const termination = iso(current?.terminationDate);
      if (admission && termination && admission > termination) throw new BadRequestException('A admissão não pode ser depois do desligamento');
      data.admissionDate = admission ? asDate(admission) : null;
    }
    if ('userId' in body) {
      if (blank(body.userId)) data.userId = null;
      else {
        const user = await this.prisma.user.findFirst({ where: { id: Number(body.userId), companyId: actor.companyId }, select: { id: true } });
        if (!user) throw new BadRequestException('Usuário não encontrado');
        const taken = await this.prisma.hr_Employee.findFirst({ where: { userId: user.id, ...(current ? { id: { not: current.id } } : {}) }, select: { name: true } });
        if (taken) throw new ConflictException(`Este usuário já está ligado a ${taken.name}`);
        data.userId = user.id;
      }
    }
    // dados pessoais: quem não pode ver também não altera (a tela não os tem para devolver)
    if (actor.seesPersonal) {
      if ('cpf' in body) {
        const cpf = digits(body.cpf);
        if (cpf && !validCpf(cpf)) throw new BadRequestException('CPF inválido');
        if (cpf) {
          const taken = await this.prisma.hr_Employee.findFirst({ where: { companyId: actor.companyId, cpf, ...(current ? { id: { not: current.id } } : {}) }, select: { name: true } });
          if (taken) throw new ConflictException(`Já existe um funcionário com este CPF: ${taken.name}`);
        }
        data.cpf = cpf || null;
      }
      if ('rg' in body) data.rg = clean(body.rg, 30) || null;
      if ('birthDate' in body) {
        const birth = blank(body.birthDate) ? null : dateOf(body.birthDate, 'Nascimento');
        if (birth && birth > today()) throw new BadRequestException('O nascimento não pode ser no futuro');
        data.birthDate = birth ? asDate(birth) : null;
      }
      if ('email' in body) {
        const email = clean(body.email, 160).toLowerCase();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('E-mail inválido');
        data.email = email || null;
      }
      if ('emergencyName' in body) data.emergencyName = clean(body.emergencyName, 120) || null;
      if ('emergencyPhone' in body) data.emergencyPhone = clean(body.emergencyPhone, 30) || null;
    }
    return data;
  }

  async create(actor: EmployeeActor, body: Body) {
    const data = await this.dataOf(actor, body, null);
    const roles = await this.rolesOf(actor.companyId, body.roles ?? [], body.primaryRoleId);
    const created = await this.prisma.hr_Employee.create({
      data: { ...(data as Prisma.Hr_EmployeeUncheckedCreateInput), companyId: actor.companyId, roles: { create: roles } },
    });
    return this.get(actor, created.id);
  }

  async update(actor: EmployeeActor, id: number, body: Body) {
    const row = await this.byId(actor, id);
    const data = await this.dataOf(actor, body, row);
    const roles = 'roles' in body ? await this.rolesOf(actor.companyId, body.roles, body.primaryRoleId) : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.hr_Employee.update({ where: { id }, data });
      if (!roles) return;
      const before = row.roles.find((role) => role.isPrimary) ?? null;
      const after = roles.find((role) => role.isPrimary) ?? null;
      await tx.hr_EmployeeRole.deleteMany({ where: { employeeId: id } });
      if (roles.length) await tx.hr_EmployeeRole.createMany({ data: roles.map((role) => ({ ...role, employeeId: id })) });
      // trocar a função principal de quem já tinha uma fica no histórico
      if (before && after && before.professionalId !== after.professionalId) {
        const next = await tx.commercial_Professional.findUnique({ where: { id: after.professionalId }, select: { name: true } });
        await tx.hr_EmployeeEvent.create({ data: {
          companyId: row.companyId, employeeId: id, type: 'mudanca_funcao', startDate: asDate(today()),
          reason: `De ${before.professional.name} para ${next?.name ?? 'outra função'}`, createdByUserId: actor.userId || null,
        } });
      }
    });
    return this.get(actor, id);
  }

  /** Inativar é para cadastro feito por engano; quem saiu da empresa é desligado pelo histórico. */
  async setActive(actor: EmployeeActor, id: number, active: boolean) {
    await this.byId(actor, id);
    await this.prisma.hr_Employee.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } });
    return this.get(actor, id);
  }

  // ------------------------------------------------------------------ histórico

  private assertOccurrences(actor: EmployeeActor) {
    if (!actor.writesOccurrences) throw new ForbiddenException('Você não tem permissão para lançar no histórico do funcionário');
  }

  /** Lança férias, afastamento, suspensão, advertência ou desligamento. */
  async addEvent(actor: EmployeeActor, id: number, body: Body) {
    this.assertOccurrences(actor);
    const row = await this.byId(actor, id);
    const type = EVENT_TYPES.find((item) => item.id === body.type);
    if (!type) throw new BadRequestException('Tipo de registro inválido');
    const start = dateOf(body.startDate, type.period ? 'Início' : 'Data');
    const end = type.period && !blank(body.endDate) ? dateOf(body.endDate, 'Fim') : null;
    if (type.endRequired && !end) throw new BadRequestException(`${type.name}: informe até quando`);
    if (end && end < start) throw new BadRequestException('O fim não pode ser antes do início');
    const admission = iso(row.admissionDate);
    if (admission && start < admission) throw new BadRequestException(`A pessoa foi admitida em ${admission.split('-').reverse().join('/')}: o registro não pode ser anterior`);
    const reason = text(body.reason, 1000) || null;
    if ((type.id === 'advertencia' || type.id === 'suspensao' || type.id === 'desligamento') && !reason) throw new BadRequestException(`${type.name}: informe o motivo`);

    const termination = iso(row.terminationDate);
    if (type.id === 'desligamento') {
      if (termination) throw new ConflictException('Este funcionário já está desligado');
    } else if (termination && start > termination) {
      throw new BadRequestException('A pessoa já foi desligada nessa data');
    }
    if (type.period) {
      // dois períodos do mesmo tipo não se sobrepõem (férias dentro de férias é erro de digitação)
      const clash = row.events.find((event) => event.type === type.id && iso(event.startDate)! <= (end ?? '9999-12-31') && (!event.endDate || iso(event.endDate)! >= start));
      if (clash) throw new ConflictException(`Já existe ${type.name.toLowerCase()} lançada nesse período`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.hr_EmployeeEvent.create({ data: {
        companyId: row.companyId, employeeId: id, type: type.id, startDate: asDate(start), endDate: end ? asDate(end) : null, reason, createdByUserId: actor.userId || null,
      } });
      if (type.id === 'desligamento') await tx.hr_Employee.update({ where: { id }, data: { terminationDate: asDate(start) } });
    });
    return this.get(actor, id);
  }

  /** Encerra um afastamento em aberto (a pessoa voltou) ou corrige o fim de um período. */
  async endEvent(actor: EmployeeActor, id: number, eventId: number, body: Body) {
    this.assertOccurrences(actor);
    const row = await this.byId(actor, id);
    const event = row.events.find((item) => item.id === eventId);
    if (!event) throw new NotFoundException('Registro não encontrado');
    if (!STATUS_OF_EVENT[event.type]) throw new BadRequestException('Este registro não tem período');
    const end = dateOf(body.endDate, 'Fim');
    if (end < iso(event.startDate)!) throw new BadRequestException('O fim não pode ser antes do início');
    await this.prisma.hr_EmployeeEvent.update({ where: { id: eventId }, data: { endDate: asDate(end) } });
    return this.get(actor, id);
  }

  /** Tira um registro lançado por engano. Tirar o desligamento readmite a pessoa. */
  async removeEvent(actor: EmployeeActor, id: number, eventId: number) {
    this.assertOccurrences(actor);
    const row = await this.byId(actor, id);
    const event = row.events.find((item) => item.id === eventId);
    if (!event) throw new NotFoundException('Registro não encontrado');
    if (event.type === 'mudanca_funcao') throw new BadRequestException('A mudança de função é registrada pelo sistema e não é apagada');
    await this.prisma.$transaction(async (tx) => {
      await tx.hr_EmployeeEvent.update({ where: { id: eventId }, data: { inactiveAt: new Date() } });
      if (event.type === 'desligamento') await tx.hr_Employee.update({ where: { id }, data: { terminationDate: null } });
    });
    return this.get(actor, id);
  }
}
