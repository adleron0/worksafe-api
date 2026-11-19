import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { pendingLines } from 'src/features/stock/rental.service';
import { classLabel } from './purchase-order.service';

/**
 * Resultado de uma venda que não é obra: a Ordem de Locação e a turma.
 *
 * Mesma ideia do resultado da OS, mais curto: a receita vem do que foi faturado
 * (contas a receber da venda) e o custo, dos pedidos de compra ligados a ela
 * (frete, sublocação, material de curso, instrutor de fora…). Imposto pela
 * alíquota da proposta e a comissão que entrou na carteira.
 *
 * Turma: a receita é a das inscrições pagas (turma aberta) mais a parte dela nas
 * vendas ligadas (turma fechada ou vagas de empresa). Uma venda ligada a N turmas
 * reparte a receita igualmente entre elas.
 */
export interface SaleResultActor { companyId: number; canSeeCosts: boolean }
export interface SaleLine { key: string; label: string; realized: number; committed: number; note: string | null }
export interface SaleFigures { revenue: number; cost: number; profit: number; margin: number | null }
export interface SaleResult {
  kind: 'locacao' | 'turma'; id: number; number: string; customer: string | null;
  contracts: Array<{ id: number; number: string; share: number }>;
  revenue: { contracted: number; invoiced: number; received: number; toInvoice: number };
  lines: SaleLine[];
  totals: { realized: SaleFigures; projected: SaleFigures };
  pending: string[];
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const NOT_INVOICED = ['cancelled', 'declined', 'chargeback'];
const SPENT = ['comprado', 'recebido'];
const GROUPS = [
  { key: 'locacao', label: 'Locações e sublocações' },
  { key: 'material', label: 'Materiais' },
  { key: 'terceiros', label: 'Terceiros' },
  { key: 'outros', label: 'Outros (frete, despesas)' },
] as const;

function figures(revenue: number, cost: number): SaleFigures {
  const profit = round2(revenue - cost);
  return { revenue: round2(revenue), cost: round2(cost), profit, margin: revenue > 0 ? round2((profit / revenue) * 100) : null };
}
type Rec = { value: unknown; status: string; commissionValue: unknown };

@Injectable()
export class SaleResultService {
  constructor(private readonly prisma: PrismaService) {}

  private assertCosts(actor: SaleResultActor) {
    if (!actor.canSeeCosts) throw new ForbiddenException('Você não tem permissão para ver custos e resultado');
  }

  /** Turmas ligadas a uma venda: a fechada (venda da turma) e as das vagas de empresa. */
  private async classesOfContract(contractId: number): Promise<number[]> {
    const [billing, subscriptions, reservations] = await Promise.all([
      this.prisma.commercial_ClassBilling.findMany({ where: { contractId, mode: 'contrato' }, select: { classId: true } }),
      this.prisma.courseClassSubscription.findMany({ where: { contractId, classId: { not: null } }, select: { classId: true }, distinct: ['classId'] }),
      this.prisma.courseClassReservation.findMany({ where: { contractId }, select: { classId: true }, distinct: ['classId'] }),
    ]);
    return [...new Set([...billing, ...subscriptions, ...reservations].map((row) => row.classId).filter((id): id is number => !!id))];
  }

  /** Monta o resultado com a receita já apurada e os pedidos do destino. */
  private async build(base: Omit<SaleResult, 'lines' | 'totals' | 'pending'>, records: Array<Rec & { share: number }>, companyId: number, purchasesWhere: { rentalId: number } | { classId: number }, taxRate: number, extraPending: string[]) {
    const purchases = await this.prisma.purchase_Order.findMany({
      where: { companyId, ...purchasesWhere, inactiveAt: null, status: { in: ['solicitado', 'aprovado', ...SPENT] } },
      select: { group: true, status: true, total: true },
    });
    const lines: SaleLine[] = [];
    for (const group of GROUPS) {
      const mine = purchases.filter((p) => p.group === group.key);
      const sum = (statuses: string[]) => round2(mine.filter((p) => statuses.includes(p.status)).reduce((total, p) => total + Number(p.total), 0));
      const realized = sum(SPENT), committed = sum(['aprovado']);
      if (realized || committed) lines.push({ key: group.key, label: group.label, realized, committed, note: null });
    }
    const invoiced = base.revenue.invoiced;
    const tax = round2(invoiced * taxRate);
    if (tax > 0) lines.push({ key: 'imposto', label: 'Impostos', realized: tax, committed: 0, note: 'Estimado pela alíquota da proposta sobre o faturado' });
    const commission = round2(records.reduce((sum, r) => sum + Number(r.commissionValue ?? 0) * r.share, 0));
    if (commission > 0) lines.push({ key: 'comissao', label: 'Comissão', realized: commission, committed: 0, note: null });

    const realizedCost = lines.reduce((sum, line) => sum + line.realized, 0);
    const projectedRevenue = Math.max(base.revenue.contracted, invoiced + base.revenue.toInvoice);
    const projectedCost = realizedCost + lines.reduce((sum, line) => sum + line.committed, 0) + round2((projectedRevenue - invoiced) * taxRate);
    const pending = [...extraPending];
    if (invoiced - base.revenue.received > 0.005) pending.push(`${money(invoiced - base.revenue.received)} faturados e ainda não recebidos`);
    const waiting = purchases.filter((p) => p.status === 'solicitado');
    if (waiting.length) pending.push(`${plural(waiting.length, 'pedido de compra aguardando', 'pedidos de compra aguardando')} aprovação (${money(waiting.reduce((t, p) => t + Number(p.total), 0))}), fora da conta`);
    const approved = purchases.filter((p) => p.status === 'aprovado');
    if (approved.length) pending.push(plural(approved.length, 'pedido de compra aprovado e ainda não comprado', 'pedidos de compra aprovados e ainda não comprados'));
    return { ...base, lines, totals: { realized: figures(invoiced, realizedCost), projected: figures(projectedRevenue, projectedCost) }, pending };
  }

  private sumOf(records: Array<Rec & { share: number }>, onlyReceived = false) {
    return round2(records.filter((r) => !onlyReceived || r.status === 'received').reduce((sum, r) => sum + Number(r.value ?? 0) * r.share, 0));
  }

  private async taxRateOf(contractIds: number[]) {
    if (!contractIds.length) return 0;
    const contracts = await this.prisma.commercial_Contract.findMany({ where: { id: { in: contractIds } }, select: { proposalId: true } });
    const proposals = await this.prisma.commercial_Proposal.findMany({ where: { id: { in: contracts.map((c) => c.proposalId) } }, select: { total: true, totalTax: true } });
    const total = proposals.reduce((s, p) => s + Number(p.total), 0);
    return total > 0 ? proposals.reduce((s, p) => s + Number(p.totalTax), 0) / total : 0;
  }

  /** Resultado da Ordem de Locação: medições faturadas (ou períodos da locação antiga) contra os pedidos ligados a ela. */
  async ofRental(actor: SaleResultActor, id: number): Promise<SaleResult> {
    this.assertCosts(actor);
    const rental = await this.prisma.stock_Rental.findFirst({ where: { id, companyId: actor.companyId, inactiveAt: null }, include: { lines: true, charges: true } });
    if (!rental) throw new NotFoundException('Ordem de locação não encontrada');
    const contract = rental.contractId ? await this.prisma.commercial_Contract.findUnique({ where: { id: rental.contractId }, select: { id: true, number: true, value: true } }) : null;
    // caução não é receita: fica fora (é conta própria, sem contrato)
    const chargeRecordIds = rental.charges.filter((c) => c.kind !== 'caucao' && c.financialRecordId).map((c) => c.financialRecordId!);
    const records = await this.prisma.financialRecords.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, status: { notIn: NOT_INVOICED as never }, OR: [...(contract ? [{ contractId: contract.id }] : []), { id: { in: chargeRecordIds } }] },
      select: { value: true, status: true, commissionValue: true },
    });
    const shared = records.map((r) => ({ ...r, share: 1 }));
    const pendingOfRental = pendingLines(rental).filter((line) => line.kind !== 'abatimento');
    const toInvoice = round2(pendingOfRental.reduce((sum, line) => sum + line.value, 0));
    const customer = await this.prisma.customer.findUnique({ where: { id: rental.customerId }, select: { name: true } });
    const extra = pendingOfRental.length ? [`${plural(pendingOfRental.length, 'cobrança vencida ainda não faturada', 'cobranças vencidas ainda não faturadas')} (${money(toInvoice)})`] : [];
    return this.build({
      kind: 'locacao', id: rental.id, number: rental.number, customer: customer?.name ?? null,
      contracts: contract ? [{ id: contract.id, number: contract.number, share: 1 }] : [],
      revenue: { contracted: contract ? Number(contract.value) : 0, invoiced: this.sumOf(shared), received: this.sumOf(shared, true), toInvoice },
    }, shared, actor.companyId, { rentalId: rental.id }, await this.taxRateOf(contract ? [contract.id] : []), extra);
  }

  /** Resultado da turma: inscrições pagas e a parte dela nas vendas ligadas, contra os pedidos de compra da turma. */
  async ofClass(actor: SaleResultActor, id: number): Promise<SaleResult> {
    this.assertCosts(actor);
    const row = await this.prisma.courseClass.findFirst({ where: { id, companyId: actor.companyId, inactiveAt: null }, select: { id: true, name: true, initialDate: true, customerId: true } });
    if (!row) throw new NotFoundException('Turma não encontrada');
    const [billing, subscriptions, reservations] = await Promise.all([
      this.prisma.commercial_ClassBilling.findUnique({ where: { classId: id } }),
      this.prisma.courseClassSubscription.findMany({ where: { classId: id }, select: { id: true, contractId: true } }),
      this.prisma.courseClassReservation.findMany({ where: { classId: id, contractId: { not: null } }, select: { contractId: true } }),
    ]);
    const contractIds = [...new Set([billing?.mode === 'contrato' ? billing.contractId : null, ...subscriptions.map((s) => s.contractId), ...reservations.map((r) => r.contractId)].filter((x): x is number => !!x))];
    const contracts = contractIds.length ? await this.prisma.commercial_Contract.findMany({ where: { id: { in: contractIds }, companyId: actor.companyId }, select: { id: true, number: true, value: true } }) : [];
    const shares = new Map<number, number>();
    for (const contract of contracts) shares.set(contract.id, 1 / Math.max(1, (await this.classesOfContract(contract.id)).length));

    const [byContract, bySubscription, installments] = await Promise.all([
      contracts.length ? this.prisma.financialRecords.findMany({
        where: { companyId: actor.companyId, inactiveAt: null, contractId: { in: contracts.map((c) => c.id) }, status: { notIn: NOT_INVOICED as never } },
        select: { value: true, status: true, commissionValue: true, contractId: true },
      }) : [],
      // inscrição paga pelo site (turma aberta); as que vieram de uma venda já contam pela venda
      this.prisma.financialRecords.findMany({
        where: { companyId: actor.companyId, inactiveAt: null, contractId: null, subscriptionId: { in: subscriptions.map((s) => s.id) }, status: { notIn: NOT_INVOICED as never } },
        select: { value: true, status: true, commissionValue: true },
      }),
      contracts.length ? this.prisma.commercial_ContractInstallment.findMany({ where: { contractId: { in: contracts.map((c) => c.id) }, financialRecordId: null }, select: { contractId: true, value: true } }) : [],
    ]);
    const records = [...byContract.map((r) => ({ ...r, share: shares.get(r.contractId!) ?? 1 })), ...bySubscription.map((r) => ({ ...r, share: 1 }))];
    const toInvoice = round2((installments as Array<{ contractId: number; value: unknown }>).reduce((sum: number, i) => sum + Number(i.value) * (shares.get(i.contractId) ?? 1), 0));
    const contracted = round2(contracts.reduce((sum, c) => sum + Number(c.value) * (shares.get(c.id) ?? 1), 0) + this.sumOf(bySubscription.map((r) => ({ ...r, share: 1 }))));
    const customer = row.customerId ? await this.prisma.customer.findUnique({ where: { id: row.customerId }, select: { name: true } }) : null;
    const extra: string[] = [];
    if (installments.length) extra.push(`${plural(installments.length, 'parcela da venda ainda não faturada', 'parcelas da venda ainda não faturadas')} (${money(toInvoice)} da parte desta turma)`);
    if (billing?.mode === 'sem_cobranca') extra.push(`Turma sem cobrança${billing.reason ? `: ${billing.reason}` : ''}`);
    if (row.customerId && !billing) extra.push('Turma fechada sem venda ligada: a receita não aparece aqui');
    return this.build({
      kind: 'turma', id: row.id, number: classLabel(row), customer: customer?.name ?? null,
      contracts: contracts.map((c) => ({ id: c.id, number: c.number, share: round2((shares.get(c.id) ?? 1) * 100) / 100 })),
      revenue: { contracted, invoiced: this.sumOf(records), received: this.sumOf(records, true), toInvoice },
    }, records, actor.companyId, { classId: row.id }, await this.taxRateOf(contracts.map((c) => c.id)), extra);
  }
}
