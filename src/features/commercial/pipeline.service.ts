import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ordersVisibleTo } from 'src/features/operations/service-order.service';
import { TeamEntry, orderPeriod } from 'src/features/hr/allocation';
import { documentIssues } from 'src/features/hr/document.queries';
import { DOCUMENTS_VIEW_PERMISSION, EmployeeDocumentService } from 'src/features/hr/document.service';
import { CompanyFileService, FILES_MANAGE_PERMISSION, FILES_VIEW_PERMISSION, FILES_WRITE_PERMISSION } from 'src/features/files/file.service';
import { ContractService } from './contract.service';

/**
 * "Minha esteira": o que está esperando pela pessoa, em cada área em que ela
 * atua. Cada bloco só existe para quem tem a permissão daquela área, e a lista
 * respeita o "só as minhas" das ordens de serviço.
 */
export interface PipelineActor { userId: number; companyId: number; permissions: string[] }
export interface PipelineItem { id: number; title: string; subtitle: string; link: string; value: number | null; late: boolean }
export interface PipelineBlock { key: string; area: string; title: string; hint: string; count: number; total: number | null; link: string; items: PipelineItem[] }

const TOP = 5;
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const br = (value: string | null) => (value ? value.split('-').reverse().join('/') : '');
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
/** Hoje no horário de Brasília (UTC−3). */
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

@Injectable()
export class PipelineService {
  constructor(private readonly prisma: PrismaService, private readonly contracts: ContractService, private readonly documents: EmployeeDocumentService, private readonly files: CompanyFileService) {}

  async mine(actor: PipelineActor): Promise<{ today: string; blocks: PipelineBlock[] }> {
    const can = (permission: string) => actor.permissions.includes(permission);
    const now = today();
    const blocks: Array<Promise<PipelineBlock[]>> = [];
    if (can('list_comercial')) blocks.push(this.followUps(actor, now));
    if (can('list_ordens_de_servico')) blocks.push(this.orders(actor, now, can('update_ordens_de_servico'), can('update_rdo')));
    if (can('list_ordens_de_servico')) blocks.push(this.teamDocuments(actor, now));
    if (can('list_pedidos_de_compra')) blocks.push(this.purchases(actor, can('approve_pedidos_de_compra'), can('update_pedidos_de_compra')));
    if (can('list_financeiro')) blocks.push(this.billing(actor), this.payables(actor, now));
    // RH: documentos de funcionários vencidos, a vencer e obrigatórios faltando
    if (can(DOCUMENTS_VIEW_PERMISSION)) blocks.push(this.documents.pipelineBlocks(actor.companyId));
    // Empresa: documentos da empresa vencidos, a vencer e obrigatórios faltando, só nas pastas que a pessoa vê
    if (can(FILES_VIEW_PERMISSION)) blocks.push(this.files.pipelineBlocks({ userId: actor.userId, companyId: actor.companyId, canWrite: can(FILES_WRITE_PERMISSION), canManage: can(FILES_MANAGE_PERMISSION) }));
    return { today: now, blocks: (await Promise.all(blocks)).flat() };
  }

  /** Comercial: os retornos da pessoa que venceram ou são para hoje. */
  private async followUps(actor: PipelineActor, now: string): Promise<PipelineBlock[]> {
    const where: Prisma.Commercial_ActivityWhereInput = { companyId: actor.companyId, inactiveAt: null, doneAt: null, userId: actor.userId, dueDate: { lte: asDate(now) } };
    const [count, rows] = await Promise.all([
      this.prisma.commercial_Activity.count({ where }),
      this.prisma.commercial_Activity.findMany({ where, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: TOP }),
    ]);
    const [customers, proposals] = await Promise.all([
      this.prisma.customer.findMany({ where: { id: { in: rows.map((row) => row.customerId) } }, select: { id: true, name: true } }),
      this.prisma.commercial_Proposal.findMany({ where: { id: { in: rows.map((row) => row.proposalId).filter((id): id is number => !!id) } }, select: { id: true, number: true } }),
    ]);
    const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
    const proposalNumber = new Map(proposals.map((proposal) => [proposal.id, proposal.number]));
    return [{
      key: 'retornos', area: 'Comercial', title: 'Retornos para fazer', hint: 'Contatos marcados para hoje ou que já passaram do dia', count, total: null, link: '/comercial/acompanhamento',
      items: rows.map((row) => {
        const due = iso(row.dueDate);
        return {
          id: row.id, title: customerName.get(row.customerId) ?? 'Cliente', value: null, late: !!due && due < now,
          subtitle: [row.subject, row.proposalId ? proposalNumber.get(row.proposalId) : null, due === now ? 'hoje' : `era para ${br(due)}`].filter(Boolean).join(' · '),
          link: row.proposalId ? `/comercial/propostas/${row.proposalId}` : '/comercial/acompanhamento',
        };
      }),
    }];
  }

  /** Operação: OS para mobilizar, OS atrasadas e obras sem o RDO de hoje. */
  private async orders(actor: PipelineActor, now: string, canMove: boolean, canReport: boolean): Promise<PipelineBlock[]> {
    const visible = await ordersVisibleTo(this.prisma, { userId: actor.userId, companyId: actor.companyId, seesAll: actor.permissions.includes('all_ordens_de_servico') });
    const base: Prisma.Service_OrderWhereInput = { companyId: actor.companyId, inactiveAt: null, AND: [visible] };
    const date = asDate(now);
    const late: Prisma.Service_OrderWhereInput = { ...base, OR: [{ status: { in: ['a_mobilizar', 'agendada'] }, plannedStart: { lt: date } }, { status: 'em_execucao', plannedEnd: { lt: date } }] };
    const [toMobilize, lateRows, running] = await Promise.all([
      canMove ? this.prisma.service_Order.findMany({ where: { ...base, status: 'a_mobilizar' }, orderBy: [{ plannedStart: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }], take: 200 }) : [],
      this.prisma.service_Order.findMany({ where: late, orderBy: [{ plannedStart: 'asc' }, { id: 'asc' }], take: 200 }),
      canReport ? this.prisma.service_Order.findMany({ where: { ...base, status: 'em_execucao' }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }], take: 200 }) : [],
    ]);
    const reported = running.length
      ? new Set((await this.prisma.service_DailyReport.findMany({ where: { orderId: { in: running.map((order) => order.id) }, date, inactiveAt: null }, select: { orderId: true } })).map((report) => report.orderId))
      : new Set<number>();
    const noReport = running.filter((order) => !reported.has(order.id));
    const all = [...toMobilize, ...lateRows, ...noReport];
    const customers = await this.prisma.customer.findMany({ where: { id: { in: all.map((order) => order.customerId) } }, select: { id: true, name: true } });
    const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
    const item = (order: (typeof all)[number], note: string, isLate = false): PipelineItem => ({
      id: order.id, title: customerName.get(order.customerId) ?? order.number, subtitle: [order.number, order.title, note].filter(Boolean).join(' · '),
      link: `/servicos/ordens-de-servico/${order.id}`, value: null, late: isLate,
    });
    const out: PipelineBlock[] = [];
    if (canMove) out.push({
      key: 'os_mobilizar', area: 'Operação', title: 'OS para mobilizar', hint: 'Separar equipe e materiais e marcar a data', count: toMobilize.length, total: null, link: '/servicos/ordens-de-servico',
      items: toMobilize.slice(0, TOP).map((order) => item(order, order.plannedStart ? `início previsto ${br(iso(order.plannedStart))}` : 'sem data marcada', !!order.plannedStart && iso(order.plannedStart)! < now)),
    });
    out.push({
      key: 'os_atrasadas', area: 'Operação', title: 'OS atrasadas', hint: 'Passaram da data marcada e ainda não andaram', count: lateRows.length, total: null, link: '/servicos/ordens-de-servico',
      items: lateRows.slice(0, TOP).map((order) => item(order, order.status === 'em_execucao' ? `término previsto ${br(iso(order.plannedEnd))}` : `início previsto ${br(iso(order.plannedStart))}`, true)),
    });
    if (canReport) out.push({
      key: 'rdo_hoje', area: 'Operação', title: 'Obras sem o RDO de hoje', hint: 'Obras em execução que ainda não têm o relatório do dia', count: noReport.length, total: null, link: '/servicos/diario-de-obra',
      items: noReport.slice(0, TOP).map((order) => item(order, `começou em ${br(iso(order.startedAt))}`)),
    });
    return out;
  }

  /**
   * Operação: gente escalada em obra que ainda vai acontecer (ou está acontecendo) com
   * documento vencido, obrigatório faltando ou que vence antes do fim da obra.
   * Mostra só o nome e o tipo do documento; o arquivo continua atrás da permissão de RH.
   */
  private async teamDocuments(actor: PipelineActor, now: string): Promise<PipelineBlock[]> {
    const visible = await ordersVisibleTo(this.prisma, { userId: actor.userId, companyId: actor.companyId, seesAll: actor.permissions.includes('all_ordens_de_servico') });
    const orders = await this.prisma.service_Order.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, status: { in: ['a_mobilizar', 'agendada', 'em_execucao'] }, AND: [visible] },
      orderBy: [{ plannedStart: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }], take: 300,
    });
    const items: PipelineItem[] = [];
    for (const order of orders) {
      const team = ((order.team as unknown as TeamEntry[]) ?? []).filter((member) => member?.employeeId);
      if (!team.length) continue;
      const until = orderPeriod(order, now).end;
      const issues = await documentIssues(this.prisma, actor.companyId, team.map((member) => member.employeeId as number), now, until);
      for (const member of team) {
        const serious = (issues.get(member.employeeId as number) ?? []).filter((issue) => issue.kind !== 'a_vencer');
        if (!serious.length) continue;
        const text = serious.slice(0, 3).map((issue) => `${issue.typeName} ${issue.kind === 'vencido' ? 'vencido' : issue.kind === 'faltando' ? 'faltando' : `vence em ${br(issue.expiryDate)}`}`).join(', ');
        items.push({ id: order.id * 100000 + (member.employeeId as number), title: member.name, subtitle: `${order.number} · ${text}${serious.length > 3 ? ` e mais ${serious.length - 3}` : ''}`, link: `/servicos/ordens-de-servico/${order.id}`, value: null, late: serious.some((issue) => issue.kind === 'vencido') });
      }
    }
    // só aparece quando há o que resolver
    if (!items.length) return [];
    return [{
      key: 'equipe_documentos', area: 'Operação', title: 'Equipe escalada com documento pendente', hint: 'Vencido, faltando ou que vence antes do fim da obra', count: items.length, total: null, link: '/servicos/ordens-de-servico',
      items: items.slice(0, TOP),
    }];
  }

  /** Suprimentos: o que espera aprovação (para quem aprova), o que já pode ser comprado e o que falta receber. */
  private async purchases(actor: PipelineActor, canApprove: boolean, canUpdate: boolean): Promise<PipelineBlock[]> {
    const stages = [
      ...(canApprove ? [{ status: 'solicitado', key: 'compras_aprovar', title: 'Compras para aprovar', hint: 'Pedidos esperando a sua decisão' }] : []),
      ...(canUpdate ? [
        { status: 'aprovado', key: 'compras_comprar', title: 'Compras aprovadas para fazer', hint: 'Já aprovadas: falta fechar com o fornecedor' },
        { status: 'comprado', key: 'compras_receber', title: 'Compras para receber', hint: 'Compradas e ainda não entregues' },
      ] : []),
    ];
    return Promise.all(stages.map(async (stage) => {
      const where: Prisma.Purchase_OrderWhereInput = { companyId: actor.companyId, inactiveAt: null, status: stage.status };
      const [sum, rows] = await Promise.all([
        this.prisma.purchase_Order.aggregate({ where, _count: { _all: true }, _sum: { total: true } }),
        this.prisma.purchase_Order.findMany({ where, orderBy: [{ neededBy: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }], take: TOP }),
      ]);
      return {
        key: stage.key, area: 'Suprimentos', title: stage.title, hint: stage.hint, count: sum._count._all, total: round2(Number(sum._sum.total ?? 0)), link: '/suprimentos/pedidos-de-compra',
        items: rows.map((row) => ({
          id: row.id, title: row.title, subtitle: [row.number, row.neededBy ? `precisa até ${br(iso(row.neededBy))}` : null].filter(Boolean).join(' · '),
          link: `/suprimentos/pedidos-de-compra/${row.id}`, value: Number(row.total), late: false,
        })),
      };
    }));
  }

  /** Financeiro: parcelas de vendas fechadas já liberadas para faturar. */
  private async billing(actor: PipelineActor): Promise<PipelineBlock[]> {
    const queue = await this.contracts.billingQueue({ userId: actor.userId, companyId: actor.companyId }, {});
    const rows = queue.rows.filter((row) => row.stage === 'liberada');
    return [{
      key: 'faturar', area: 'Financeiro', title: 'Parcelas para faturar', hint: 'Vendas fechadas com parcela liberada: falta emitir a nota', count: rows.length,
      total: round2(rows.reduce((sum, row) => sum + row.value, 0)), link: '/financeiro/faturar',
      items: rows.slice(0, TOP).map((row) => ({
        id: row.id, title: row.customer.name, subtitle: [row.contractNumber, row.total > 1 ? `parcela ${row.number}/${row.total}` : 'pagamento único', row.title].join(' · '),
        link: '/financeiro/faturar', value: row.value, late: false,
      })),
    }];
  }

  /** Financeiro: contas a pagar atrasadas e as que vencem nos próximos 7 dias. */
  private async payables(actor: PipelineActor, now: string): Promise<PipelineBlock[]> {
    const start = asDate(now);
    const week = new Date(start.getTime() + 8 * 86400000);
    const open = { companyId: actor.companyId, inactiveAt: null, status: 'aberta' };
    const block = async (key: string, title: string, hint: string, dueDate: Prisma.DateTimeFilter, isLate: boolean): Promise<PipelineBlock> => {
      const where: Prisma.Financial_PayableWhereInput = { ...open, dueDate };
      const [sum, rows] = await Promise.all([
        this.prisma.financial_Payable.aggregate({ where, _count: { _all: true }, _sum: { value: true } }),
        this.prisma.financial_Payable.findMany({ where, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: TOP, include: { supplier: { select: { name: true } } } }),
      ]);
      return {
        key, area: 'Financeiro', title, hint, count: sum._count._all, total: round2(Number(sum._sum.value ?? 0)), link: '/financeiro/pagar',
        items: rows.map((row) => ({
          id: row.id, title: row.description, subtitle: [row.supplier?.name, `vence ${br(iso(row.dueDate))}`].filter(Boolean).join(' · '), link: '/financeiro/pagar', value: Number(row.value), late: isLate,
        })),
      };
    };
    return Promise.all([
      block('pagar_atrasadas', 'Contas a pagar atrasadas', 'Venceram e ainda estão em aberto', { lt: start }, true),
      block('pagar_semana', 'Contas a pagar da semana', 'Vencem de hoje até daqui a 7 dias', { gte: start, lt: week }, false),
    ]);
  }
}
