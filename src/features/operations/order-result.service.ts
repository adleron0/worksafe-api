import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ServiceOrderStatus, Service_Order } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { stockCostOfOrder } from 'src/features/stock/movement.service';
import { DailyReportService } from './daily-report.service';

/**
 * Resultado da OS: o que foi orçado na proposta contra o que a obra realmente
 * custou e faturou, e a projeção de como ela termina.
 *
 * Nada é digitado aqui. A receita vem das parcelas faturadas da venda; a mão de
 * obra, das horas dos RDOs; locações, materiais, terceiros e outros, dos pedidos
 * de compra e das contas a pagar ligadas à obra. Ao encerrar a OS o resultado é
 * guardado como estava e deixa de mudar.
 */
export interface ResultActor { companyId: number; canSeeCosts: boolean }
export interface ResultLine { key: string; label: string; budget: number; realized: number; committed: number; projected: number; note: string | null }
export interface Figures { revenue: number; cost: number; profit: number; margin: number | null }
export interface OrderResult {
  status: ServiceOrderStatus; frozen: boolean; computedAt: string;
  progress: { done: number | null; planned: number | null };
  revenue: { budget: number; invoiced: number; received: number; toInvoice: number };
  lines: ResultLine[];
  totals: { budget: Figures; realized: Figures; projected: Figures };
  pending: string[];
}
interface BudgetShape { revenue?: number; cost?: number; tax?: number; commission?: number; groups?: Array<{ type: string; label: string; cost: number }> }

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** Etapas em que a obra já terminou: a projeção passa a ser o que foi gasto e comprometido. */
const DONE: ServiceOrderStatus[] = ['concluida', 'encerrada', 'cancelada'];
/** Pedido aprovado conta como comprometido; comprado ou recebido, como realizado. */
const SPENT = ['comprado', 'recebido'];
/** Abaixo disso o avanço ainda não diz nada sobre o ritmo do gasto. */
const MIN_PROGRESS = 0.05;
const NOT_INVOICED = ['cancelled', 'declined', 'chargeback'];
/** Grupo do pedido de compra → linha do resultado e grupo do orçamento da proposta. */
const PURCHASE_LINES = [
  { key: 'locacao', label: 'Locações', group: 'locacao', budgetType: 'locacao' },
  { key: 'material', label: 'Materiais', group: 'material', budgetType: 'material' },
  { key: 'terceiros', label: 'Terceiros', group: 'terceiros', budgetType: null },
  { key: 'outros', label: 'Outros', group: 'outros', budgetType: 'avulso' },
] as const;

function stockNote(stock: { sent: number; returned: number; lost: number; ppe: number }) {
  const parts = [stock.sent ? `${money(stock.sent)} saíram do estoque` : '', stock.returned ? `${money(stock.returned)} de sobras devolvidas` : '',
    stock.lost ? `${money(stock.lost)} de equipamento perdido` : '', stock.ppe ? `${money(stock.ppe)} de EPI` : ''].filter(Boolean);
  return `Estoque: ${parts.join(', ')}`;
}

function figures(revenue: number, cost: number): Figures {
  const profit = round2(revenue - cost);
  return { revenue: round2(revenue), cost: round2(cost), profit, margin: revenue > 0 ? round2((profit / revenue) * 100) : null };
}

@Injectable()
export class OrderResultService {
  constructor(private readonly prisma: PrismaService, private readonly reports: DailyReportService) {}

  /** Calcula o resultado da OS como está agora. */
  async compute(order: Service_Order): Promise<OrderResult> {
    const budget = (order.budget as BudgetShape | null) ?? {};
    const groupBudget = (type: string) => Number((budget.groups ?? []).find((group) => group.type === type)?.cost ?? 0);
    const revenueBudget = Number(budget.revenue ?? 0);
    const finished = DONE.includes(order.status);

    const [diary, records, installments, purchases, payables, stock] = await Promise.all([
      this.reports.summaryOf(order, true),
      this.prisma.financialRecords.findMany({ where: { contractId: order.contractId, inactiveAt: null, status: { notIn: NOT_INVOICED as never } }, select: { value: true, status: true, commissionValue: true } }),
      this.prisma.commercial_ContractInstallment.findMany({ where: { contractId: order.contractId }, select: { value: true, financialRecordId: true } }),
      this.prisma.purchase_Order.findMany({ where: { serviceOrderId: order.id, inactiveAt: null, status: { in: ['solicitado', 'aprovado', ...SPENT] } }, select: { group: true, status: true, total: true } }),
      // despesas lançadas direto no Financeiro para esta obra (as dos pedidos já contam pelo pedido)
      this.prisma.financial_Payable.findMany({ where: { serviceOrderId: order.id, purchaseOrderId: null, inactiveAt: null }, select: { value: true } }),
      // material que saiu do estoque para a obra (menos as sobras), perdas e EPI marcados para a obra
      stockCostOfOrder(this.prisma, order.id),
    ]);

    const invoiced = round2(records.reduce((sum, record) => sum + Number(record.value ?? 0), 0));
    const received = round2(records.filter((record) => record.status === 'received').reduce((sum, record) => sum + Number(record.value ?? 0), 0));
    const open = installments.filter((installment) => !installment.financialRecordId);
    const toInvoice = round2(open.reduce((sum, installment) => sum + Number(installment.value), 0));
    const progress = diary.progress.done === null ? null : diary.progress.done / 100;

    const lines: ResultLine[] = [];
    // mão de obra: horas dos RDOs × custo hora; a projeção segue o ritmo do avanço físico
    const labor = diary.labor ?? { cost: 0, budget: 0, withoutCost: [] as string[] };
    const laborBudget = groupBudget('mao_de_obra');
    const laborByPace = progress !== null && progress >= MIN_PROGRESS;
    lines.push({
      key: 'mao_de_obra', label: 'Mão de obra', budget: laborBudget, realized: labor.cost, committed: 0,
      projected: round2(finished ? labor.cost : laborByPace ? Math.max(labor.cost, labor.cost / progress!) : Math.max(laborBudget, labor.cost)),
      note: finished ? null : laborByPace ? `No ritmo atual: ${money(labor.cost)} gastos com ${round2(progress! * 100)}% da obra feita` : 'Sem avanço lançado: a projeção usa o orçado',
    });
    // compras: comprado ou recebido é realizado; aprovado é comprometido
    const direct = round2(payables.reduce((sum, payable) => sum + Number(payable.value), 0));
    for (const line of PURCHASE_LINES) {
      const mine = purchases.filter((purchase) => purchase.group === line.group);
      const total = (statuses: string[]) => round2(mine.filter((purchase) => statuses.includes(purchase.status)).reduce((sum, purchase) => sum + Number(purchase.total), 0));
      const lineBudget = line.budgetType ? groupBudget(line.budgetType) : 0;
      const realized = round2(total(SPENT) + (line.key === 'outros' ? direct : 0) + (line.key === 'material' ? stock.total : 0));
      const committed = total(['aprovado']);
      // linha sem orçamento e sem gasto não diz nada
      if (!lineBudget && !realized && !committed) continue;
      lines.push({
        key: line.key, label: line.label, budget: lineBudget, realized, committed,
        projected: round2(finished ? realized + committed : Math.max(lineBudget, realized + committed)),
        note: line.key === 'outros' && direct > 0 ? `Inclui ${money(direct)} lançados direto em Contas a Pagar para esta obra`
          : line.key === 'material' && (stock.sent || stock.returned || stock.lost || stock.ppe) ? stockNote(stock) : null,
      });
    }
    // parte do custo da proposta que não é serviço (treinamento em proposta mista): fica como foi orçada
    const tracked = lines.reduce((sum, line) => sum + line.budget, 0);
    const untracked = round2(Number(budget.cost ?? tracked) - tracked);
    if (untracked > 0.01) lines.push({ key: 'demais', label: 'Demais custos da proposta', budget: untracked, realized: 0, committed: 0, projected: untracked, note: 'Não acompanhado pela OS: considerado como foi orçado' });
    // imposto pela alíquota da proposta sobre o que foi faturado; comissão é a que entrou na carteira do vendedor
    const taxBudget = Number(budget.tax ?? 0);
    const tax = revenueBudget > 0 ? round2((taxBudget / revenueBudget) * invoiced) : 0;
    lines.push({ key: 'imposto', label: 'Impostos', budget: taxBudget, realized: tax, committed: 0, projected: Math.max(taxBudget, tax), note: 'Realizado estimado pela alíquota da proposta sobre o faturado' });
    const commissionBudget = Number(budget.commission ?? 0);
    const commission = round2(records.reduce((sum, record) => sum + Number(record.commissionValue ?? 0), 0));
    if (commissionBudget > 0 || commission > 0) lines.push({ key: 'comissao', label: 'Comissão', budget: commissionBudget, realized: commission, committed: 0, projected: Math.max(commissionBudget, commission), note: null });

    const sum = (key: 'budget' | 'realized' | 'projected') => lines.reduce((total, line) => total + line[key], 0);
    const pending: string[] = [];
    if (open.length) pending.push(`${plural(open.length, 'parcela ainda não faturada', 'parcelas ainda não faturadas')} (${money(toInvoice)})`);
    if (invoiced - received > 0.005) pending.push(`${money(invoiced - received)} faturados e ainda não recebidos`);
    const waiting = purchases.filter((purchase) => purchase.status === 'solicitado');
    if (waiting.length) pending.push(`${plural(waiting.length, 'pedido de compra aguardando', 'pedidos de compra aguardando')} aprovação (${money(waiting.reduce((total, purchase) => total + Number(purchase.total), 0))}), fora da conta`);
    const approved = purchases.filter((purchase) => purchase.status === 'aprovado');
    if (approved.length) pending.push(`${plural(approved.length, 'pedido de compra aprovado e ainda não comprado', 'pedidos de compra aprovados e ainda não comprados')}`);
    if (diary.drafts) pending.push(`${plural(diary.drafts, 'RDO em rascunho', 'RDOs em rascunho')}`);
    if (labor.withoutCost.length) pending.push(`Horas sem custo, de função fora do orçamento: ${labor.withoutCost.join(', ')}`);

    return {
      status: order.status, frozen: false, computedAt: new Date().toISOString(),
      progress: { done: diary.progress.done, planned: diary.progress.planned },
      revenue: { budget: round2(revenueBudget), invoiced, received, toInvoice },
      lines,
      totals: { budget: figures(revenueBudget, sum('budget')), realized: figures(invoiced, sum('realized')), projected: figures(Math.max(revenueBudget, invoiced), sum('projected')) },
      pending,
    };
  }

  /** O que fica guardado na OS encerrada. */
  async frozen(order: Service_Order): Promise<Prisma.InputJsonValue> {
    return { ...(await this.compute({ ...order, status: 'encerrada' })), frozen: true } as unknown as Prisma.InputJsonValue;
  }

  private assertCosts(actor: ResultActor) {
    if (!actor.canSeeCosts) throw new ForbiddenException('Você não tem permissão para ver custos e resultado');
  }

  private resultOf(order: Service_Order): Promise<OrderResult> | OrderResult {
    return order.status === 'encerrada' && order.result ? (order.result as unknown as OrderResult) : this.compute(order);
  }

  /** Resultado de uma OS: o congelado, se ela está encerrada; senão, o de agora. */
  async of(actor: ResultActor, id: number) {
    this.assertCosts(actor);
    const order = await this.prisma.service_Order.findFirst({ where: { id, companyId: actor.companyId } });
    if (!order) throw new NotFoundException('Ordem de serviço não encontrada');
    return { ...(await this.resultOf(order)), closedAt: order.closedAt };
  }

  /** Resumo para a gestão: o resultado de cada obra e o total. */
  async list(actor: ResultActor, query: Record<string, string>) {
    this.assertCosts(actor);
    const term = String(query.search ?? '').trim().slice(0, 80);
    const view = ['andamento', 'terminadas'].includes(query.view) ? query.view : 'todas';
    const status: Prisma.Service_OrderWhereInput['status'] = view === 'andamento' ? { in: ['a_liberar', 'a_mobilizar', 'agendada', 'em_execucao'] }
      : view === 'terminadas' ? { in: ['concluida', 'encerrada'] } : { not: 'cancelada' };
    const customerIds = term ? (await this.prisma.customer.findMany({ where: { companyId: actor.companyId, name: { contains: term, mode: 'insensitive' } }, select: { id: true }, take: 200 })).map((customer) => customer.id) : [];
    const orders = await this.prisma.service_Order.findMany({
      where: {
        companyId: actor.companyId, inactiveAt: null, status,
        ...(term ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } }, { customerId: { in: customerIds } }] } : {}),
      },
      orderBy: { id: 'desc' }, take: 100,
    });
    const customers = await this.prisma.customer.findMany({ where: { id: { in: orders.map((order) => order.customerId) } }, select: { id: true, name: true } });
    const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
    const rows = [];
    for (const order of orders) {
      const result = await this.resultOf(order);
      rows.push({
        id: order.id, number: order.number, title: order.title, status: order.status, customer: customerName.get(order.customerId) ?? '',
        frozen: result.frozen, progress: result.progress.done, pending: result.pending.length,
        budget: result.totals.budget, realized: result.totals.realized, projected: result.totals.projected,
      });
    }
    const total = (pick: (row: (typeof rows)[number]) => number) => round2(rows.reduce((sum, row) => sum + pick(row), 0));
    return {
      rows,
      totals: {
        orders: rows.length,
        budget: figures(total((row) => row.budget.revenue), total((row) => row.budget.cost)),
        realized: figures(total((row) => row.realized.revenue), total((row) => row.realized.cost)),
        projected: figures(total((row) => row.projected.revenue), total((row) => row.projected.cost)),
        // obras que caminham para fechar abaixo do que foi orçado
        below: rows.filter((row) => row.projected.profit < row.budget.profit - 0.005).length,
      },
    };
  }
}
