import { Injectable } from '@nestjs/common';
import { Prisma, financialRecordsStatus } from '@prisma/client';
import { brDate, buildXlsx } from 'src/common/xlsx';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  Query, amount, bucketOf, day, dueWindows, ints, month, monthEnd, moneyText, ordering, paging, range, round, todayBr, withDescendants, words,
} from './ledger.filters';
import { RecurrenceService } from './recurrence.service';

const PAYABLE_VIEWS = ['abertas', 'atrasadas', 'hoje', 'semana', 'depois', 'pagas', 'excluidas', 'todas'] as const;
const RECEIVABLE_VIEWS = ['abertas', 'atrasadas', 'hoje', 'semana', 'depois', 'recebidas', 'canceladas', 'excluidas', 'todas'] as const;
const PAYMENT_METHODS = ['transferencia', 'pix', 'boleto', 'cartaoCredito', 'dinheiro', 'outro'] as const;
export const OPEN_RECEIVABLE: financialRecordsStatus[] = ['waiting', 'overdue', 'processing'];
const LOST_RECEIVABLE: financialRecordsStatus[] = ['cancelled', 'declined', 'chargeback'];
const EXPORT_LIMIT = 5000;

const METHOD_LABEL: Record<string, string> = {
  transferencia: 'Transferência', pix: 'PIX', boleto: 'Boleto', cartaoCredito: 'Cartão de crédito', dinheiro: 'Dinheiro', outro: 'Outro',
};
const STATUS_LABEL: Record<string, string> = {
  processing: 'Processando', waiting: 'Aguardando', received: 'Recebido', declined: 'Recusado', chargeback: 'Estorno', cancelled: 'Cancelado', overdue: 'Vencido',
};
const n = (value: unknown) => (value === null || value === undefined ? null : Number(value));

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService, private readonly recurrences: RecurrenceService) {}

  // ------------------------------------------------------------ contas a pagar

  /** Tudo o que filtra, menos a visão (os cartões mostram todas as faixas do mesmo recorte). */
  private async payableBase(companyId: number, query: Query): Promise<Prisma.Financial_PayableWhereInput> {
    const and: Prisma.Financial_PayableWhereInput[] = [{ companyId }];
    const q = String(query.q ?? '').trim();
    if (q) {
      const or: Prisma.Financial_PayableWhereInput[] = [
        { description: { contains: q, mode: 'insensitive' } },
        { documentNumber: { contains: q, mode: 'insensitive' } },
        { observations: { contains: q, mode: 'insensitive' } },
        { supplier: { name: { contains: q, mode: 'insensitive' } } },
        { supplier: { legalName: { contains: q, mode: 'insensitive' } } },
      ];
      const digits = q.replace(/\D/g, '');
      if (/^\d+$/.test(q) && Number(q) < 2147483647) or.push({ id: Number(q) });
      if (digits.length >= 11 && /^[\d./-]+$/.test(q)) or.push({ supplier: { document: digits } });
      const money = moneyText(q);
      if (money !== null && /[,.]/.test(q)) or.push({ value: money });
      and.push({ OR: or });
    }
    const due = range(day(query.dueFrom, 'Data inicial do vencimento'), day(query.dueTo, 'Data final do vencimento'));
    if (due) and.push({ dueDate: due });
    const paid = range(day(query.paidFrom, 'Data inicial do pagamento'), day(query.paidTo, 'Data final do pagamento'));
    if (paid) and.push({ status: 'paga', paidAt: paid });
    const accrualFrom = month(query.accrualFrom, 'Competência inicial');
    const accrualTo = month(query.accrualTo, 'Competência final');
    if (accrualFrom || accrualTo) and.push({ accrualDate: { ...(accrualFrom ? { gte: accrualFrom } : {}), ...(accrualTo ? { lte: accrualTo } : {}) } });
    const suppliers = ints(query.supplierId);
    if (suppliers.length) and.push({ supplierId: { in: suppliers } });
    if (query.supplierId === 'none') and.push({ supplierId: null });
    const accounts = await withDescendants(this.prisma, companyId, ints(query.chartAccountId));
    if (accounts.length) and.push({ chartAccountId: { in: accounts } });
    if (query.chartAccountId === 'none') and.push({ chartAccountId: null });
    const centers = ints(query.costCenterId);
    if (centers.length) and.push({ costCenterId: { in: centers } });
    if (query.costCenterId === 'none') and.push({ costCenterId: null });
    const banks = ints(query.bankAccountId);
    if (banks.length) and.push({ bankAccountId: { in: banks } });
    const methods = words(query.paymentMethod, PAYMENT_METHODS);
    if (methods.length) and.push({ paymentMethod: { in: methods } });
    const orders = ints(query.serviceOrderId);
    if (orders.length) and.push({ serviceOrderId: { in: orders } });
    const origins = words(query.origin, ['manual', 'pedido_compra', 'recorrencia']);
    if (origins.length) {
      const plain = origins.filter((o) => o !== 'recorrencia');
      and.push({ OR: [...(plain.length ? [{ origin: { in: plain }, recurrenceId: null }] : []), ...(origins.includes('recorrencia') ? [{ recurrenceId: { not: null } }] : [])] });
    }
    const minValue = amount(query.minValue, 'Valor mínimo');
    const maxValue = amount(query.maxValue, 'Valor máximo');
    if (minValue !== null) and.push({ value: { gte: minValue } });
    if (maxValue !== null) and.push({ value: { lte: maxValue } });
    if (query.receipt === 'com') and.push({ receiptUrl: { not: null } });
    if (query.receipt === 'sem') and.push({ receiptUrl: null });
    if (query.installments === 'sim') and.push({ groupKey: { not: null } });
    if (query.groupKey) and.push({ groupKey: String(query.groupKey) });
    const recurrence = ints(query.recurrenceId);
    if (recurrence.length) and.push({ recurrenceId: { in: recurrence } });
    return { AND: and };
  }

  private payableView(view: string, today: string): Prisma.Financial_PayableWhereInput {
    const windows = dueWindows(today);
    const open = { status: 'aberta', inactiveAt: null };
    switch (view) {
      case 'atrasadas': return { ...open, dueDate: windows.overdue };
      case 'hoje': return { ...open, dueDate: windows.dueToday };
      case 'semana': return { ...open, dueDate: windows.dueWeek };
      case 'depois': return { ...open, dueDate: windows.later };
      case 'pagas': return { status: 'paga', inactiveAt: null };
      case 'excluidas': return { inactiveAt: { not: null } };
      case 'todas': return { inactiveAt: null };
      default: return open;
    }
  }

  private payableSort(view: string, query: Query) {
    const fallback: [string, 'asc' | 'desc'] = view === 'pagas' ? ['paidAt', 'desc'] : view === 'excluidas' || view === 'todas' ? ['dueDate', 'desc'] : ['dueDate', 'asc'];
    return ordering(query, ['dueDate', 'paidAt', 'value', 'createdAt', 'description', 'id'], fallback);
  }

  private readonly payableInclude = {
    supplier: { select: { id: true, name: true, document: true, pixKey: true } },
    serviceOrder: { select: { id: true, number: true } },
    chartAccount: { select: { id: true, code: true, name: true } },
    costCenter: { select: { id: true, name: true } },
    bankAccount: { select: { id: true, name: true, type: true } },
    recurrence: { select: { id: true, inactiveAt: true, endDate: true } },
  } satisfies Prisma.Financial_PayableInclude;

  async payables(companyId: number, query: Query) {
    await this.recurrences.ensure(companyId);
    const view = words(query.view, PAYABLE_VIEWS)[0] ?? 'abertas';
    const today = todayBr();
    const base = await this.payableBase(companyId, query);
    const where = { AND: [base, this.payableView(view, today)] };
    const { skip, limit } = paging(query);
    const [rows, total, summary] = await Promise.all([
      this.prisma.financial_Payable.findMany({ where, include: this.payableInclude, orderBy: this.payableSort(view, query), skip, take: limit }),
      this.prisma.financial_Payable.count({ where }),
      this.payableSummary(base, query, today),
    ]);
    return { today, view, rows, total, summary };
  }

  /** Cartões: faixas do que está em aberto e o que foi pago (no período pedido ou, sem período, no mês). */
  private async payableSummary(base: Prisma.Financial_PayableWhereInput, query: Query, today: string) {
    const windows = dueWindows(today);
    const open = { status: 'aberta', inactiveAt: null };
    const sum = async (where: Prisma.Financial_PayableWhereInput, field: 'value' | 'paidValue' = 'value') => {
      const result = await this.prisma.financial_Payable.aggregate({ where: { AND: [base, where] }, _count: { _all: true }, _sum: { [field]: true } as never });
      return bucketOf(result._count._all, (result._sum as Record<string, unknown>)?.[field]);
    };
    const hasPaidPeriod = Boolean(query.paidFrom || query.paidTo);
    const currentMonth = today.slice(0, 7);
    const paidWhere: Prisma.Financial_PayableWhereInput = {
      status: 'paga', inactiveAt: null,
      ...(hasPaidPeriod ? {} : { paidAt: range(`${currentMonth}-01`, monthEnd(currentMonth)) }),
    };
    const [overdue, dueToday, dueWeek, later, paid, openAll] = await Promise.all([
      sum({ ...open, dueDate: windows.overdue }), sum({ ...open, dueDate: windows.dueToday }),
      sum({ ...open, dueDate: windows.dueWeek }), sum({ ...open, dueDate: windows.later }),
      sum(paidWhere, 'paidValue'), sum(open),
    ]);
    return { overdue, dueToday, dueWeek, later, paid, open: openAll, paidPeriod: hasPaidPeriod ? 'filtro' : currentMonth };
  }

  async exportPayables(companyId: number, query: Query) {
    const view = words(query.view, PAYABLE_VIEWS)[0] ?? 'abertas';
    const today = todayBr();
    const ids = ints(query.ids);
    const where = ids.length
      ? { companyId, id: { in: ids } }
      : { AND: [await this.payableBase(companyId, query), this.payableView(view, today)] };
    const rows = await this.prisma.financial_Payable.findMany({ where, include: this.payableInclude, orderBy: this.payableSort(view, query), take: EXPORT_LIMIT });
    const situation = (row: (typeof rows)[number]) => {
      if (row.inactiveAt) return 'Excluída';
      if (row.status === 'paga') return 'Paga';
      const due = row.dueDate.toISOString().slice(0, 10);
      return due < today ? 'Atrasada' : due === today ? 'Vence hoje' : 'A vencer';
    };
    return buildXlsx([{
      name: 'Contas a pagar',
      columns: [
        { header: 'Código', width: 9 }, { header: 'Descrição', width: 38 }, { header: 'Fornecedor', width: 30 }, { header: 'CNPJ/CPF', width: 18 },
        { header: 'Parcela', width: 9 }, { header: 'Vencimento', width: 12 }, { header: 'Competência', width: 12 }, { header: 'Valor', width: 14 },
        { header: 'Situação', width: 12 }, { header: 'Pagamento', width: 12 }, { header: 'Valor pago', width: 14 }, { header: 'Juros', width: 12 },
        { header: 'Multa', width: 12 }, { header: 'Desconto', width: 12 }, { header: 'Forma', width: 16 }, { header: 'Conta de saída', width: 22 },
        { header: 'Plano de contas', width: 32 }, { header: 'Centro de custo', width: 20 }, { header: 'OS', width: 12 }, { header: 'Nº documento', width: 18 },
        { header: 'Linha digitável', width: 50 }, { header: 'Observações', width: 40 },
      ],
      rows: rows.map((row) => [
        row.id, row.description, row.supplier?.name ?? '', row.supplier?.document ?? '',
        row.installmentNumber && row.installmentTotal ? `${row.installmentNumber}/${row.installmentTotal}` : '',
        { date: row.dueDate }, row.accrualDate, { money: Number(row.value) }, situation(row), { date: row.paidAt },
        row.paidValue === null ? '' : { money: Number(row.paidValue) },
        row.interestValue === null ? '' : { money: Number(row.interestValue) },
        row.fineValue === null ? '' : { money: Number(row.fineValue) },
        row.discountValue === null ? '' : { money: Number(row.discountValue) },
        row.paymentMethod ? METHOD_LABEL[row.paymentMethod] ?? row.paymentMethod : '', row.bankAccount?.name ?? '',
        row.chartAccount ? `${row.chartAccount.code} ${row.chartAccount.name}` : '', row.costCenter?.name ?? '', row.serviceOrder?.number ?? '',
        row.documentNumber ?? '', row.barcode ?? '', row.observations ?? '',
      ]),
    }]);
  }

  // ------------------------------------------------------------ contas a receber

  private async receivableBase(companyId: number, query: Query): Promise<Prisma.FinancialRecordsWhereInput> {
    const and: Prisma.FinancialRecordsWhereInput[] = [{ companyId }];
    const q = String(query.q ?? '').trim();
    if (q) {
      const or: Prisma.FinancialRecordsWhereInput[] = [
        { description: { contains: q, mode: 'insensitive' } },
        { observations: { contains: q, mode: 'insensitive' } },
        { invoiceNumber: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { trainee: { name: { contains: q, mode: 'insensitive' } } },
      ];
      const digits = q.replace(/\D/g, '');
      if (/^\d+$/.test(q) && Number(q) < 2147483647) or.push({ id: Number(q) });
      if (digits.length === 14) or.push({ customer: { cnpj: digits } });
      if (digits.length === 11) or.push({ trainee: { cpf: digits } });
      const money = moneyText(q);
      if (money !== null && /[,.]/.test(q)) or.push({ value: money });
      and.push({ OR: or });
    }
    const due = range(day(query.dueFrom, 'Data inicial do vencimento'), day(query.dueTo, 'Data final do vencimento'));
    if (due) and.push({ dueDate: due });
    const paid = range(day(query.paidFrom, 'Data inicial do recebimento'), day(query.paidTo, 'Data final do recebimento'));
    if (paid) and.push({ status: 'received', paidAt: paid });
    const accrualFrom = month(query.accrualFrom, 'Competência inicial');
    const accrualTo = month(query.accrualTo, 'Competência final');
    if (accrualFrom || accrualTo) and.push({ accrualDate: { ...(accrualFrom ? { gte: accrualFrom } : {}), ...(accrualTo ? { lte: accrualTo } : {}) } });
    const customers = ints(query.customerId);
    if (customers.length) and.push({ customerId: { in: customers } });
    const trainees = ints(query.traineeId);
    if (trainees.length) and.push({ traineeId: { in: trainees } });
    const sellers = ints(query.sellerId);
    if (sellers.length) and.push({ sellerId: { in: sellers } });
    const accounts = await withDescendants(this.prisma, companyId, ints(query.chartAccountId));
    if (accounts.length) and.push({ chartAccountId: { in: accounts } });
    if (query.chartAccountId === 'none') and.push({ chartAccountId: null });
    const centers = ints(query.costCenterId);
    if (centers.length) and.push({ costCenterId: { in: centers } });
    if (query.costCenterId === 'none') and.push({ costCenterId: null });
    const banks = ints(query.bankAccountId);
    if (banks.length) and.push({ bankAccountId: { in: banks } });
    const methods = words(query.paymentMethod, PAYMENT_METHODS);
    if (methods.length) and.push({ paymentMethod: { in: methods as never } });
    const gateways = words(query.gateway, ['manual', 'asaas', 'infinitePay', 'stripe', 'efi', 'mercadoPago', 'pagSeguro', 'paypal']);
    if (gateways.length) and.push({ gateway: { in: gateways as never } });
    const statuses = words(query.status, Object.keys(STATUS_LABEL));
    if (statuses.length) and.push({ status: { in: statuses as financialRecordsStatus[] } });
    const origins = words(query.origin, ['inscricao', 'contrato', 'manual', 'recorrencia']);
    if (origins.length) {
      and.push({ OR: origins.map((origin): Prisma.FinancialRecordsWhereInput => {
        if (origin === 'inscricao') return { subscriptionId: { not: null } };
        if (origin === 'contrato') return { contractId: { not: null } };
        if (origin === 'recorrencia') return { recurrenceId: { not: null } };
        return { gateway: 'manual', subscriptionId: null, contractId: null, recurrenceId: null };
      }) });
    }
    const minValue = amount(query.minValue, 'Valor mínimo');
    const maxValue = amount(query.maxValue, 'Valor máximo');
    if (minValue !== null) and.push({ value: { gte: minValue } });
    if (maxValue !== null) and.push({ value: { lte: maxValue } });
    if (query.invoice === 'com') and.push({ invoiceNumber: { not: null } });
    if (query.invoice === 'sem') and.push({ invoiceNumber: null });
    const contracts = ints(query.contractId);
    if (contracts.length) and.push({ contractId: { in: contracts } });
    const recurrence = ints(query.recurrenceId);
    if (recurrence.length) and.push({ recurrenceId: { in: recurrence } });
    return { AND: and };
  }

  private receivableView(view: string, today: string): Prisma.FinancialRecordsWhereInput {
    const windows = dueWindows(today);
    const open = { status: { in: OPEN_RECEIVABLE }, inactiveAt: null };
    switch (view) {
      case 'atrasadas': return { ...open, dueDate: windows.overdue };
      case 'hoje': return { ...open, dueDate: windows.dueToday };
      case 'semana': return { ...open, dueDate: windows.dueWeek };
      case 'depois': return { ...open, OR: [{ dueDate: windows.later }, { dueDate: null }] };
      case 'recebidas': return { status: 'received', inactiveAt: null };
      case 'canceladas': return { status: { in: LOST_RECEIVABLE }, inactiveAt: null };
      case 'excluidas': return { inactiveAt: { not: null } };
      case 'todas': return { inactiveAt: null };
      default: return open;
    }
  }

  private receivableSort(view: string, query: Query) {
    const fallback: [string, 'asc' | 'desc'] = view === 'recebidas' ? ['paidAt', 'desc'] : ['abertas', 'atrasadas', 'hoje', 'semana', 'depois'].includes(view) ? ['dueDate', 'asc'] : ['dueDate', 'desc'];
    return ordering(query, ['dueDate', 'paidAt', 'value', 'createdAt', 'id', 'invoiceIssuedAt'], fallback);
  }

  private readonly receivableInclude = {
    trainee: { select: { id: true, name: true, cpf: true, email: true, phone: true } },
    customer: { select: { id: true, name: true, cnpj: true, email: true, phone: true } },
    subscription: { select: { id: true, name: true, email: true, phone: true } },
    seller: { select: { id: true, name: true } },
    chartAccount: { select: { id: true, code: true, name: true } },
    costCenter: { select: { id: true, name: true } },
    bankAccount: { select: { id: true, name: true, type: true } },
    recurrence: { select: { id: true, inactiveAt: true, endDate: true } },
  } satisfies Prisma.FinancialRecordsInclude;

  async receivables(companyId: number, query: Query) {
    await this.recurrences.ensure(companyId);
    const view = words(query.view, RECEIVABLE_VIEWS)[0] ?? 'abertas';
    const today = todayBr();
    const base = await this.receivableBase(companyId, query);
    const where = { AND: [base, this.receivableView(view, today)] };
    const { skip, limit } = paging(query);
    const [rows, total, summary] = await Promise.all([
      this.prisma.financialRecords.findMany({ where, include: this.receivableInclude, omit: { key: true, requestData: true, responseData: true, errorData: true }, orderBy: this.receivableSort(view, query), skip, take: limit }),
      this.prisma.financialRecords.count({ where }),
      this.receivableSummary(base, query, today),
    ]);
    return { today, view, rows, total, summary };
  }

  private async receivableSummary(base: Prisma.FinancialRecordsWhereInput, query: Query, today: string) {
    const windows = dueWindows(today);
    const open = { status: { in: OPEN_RECEIVABLE }, inactiveAt: null };
    const sum = async (where: Prisma.FinancialRecordsWhereInput) => {
      const result = await this.prisma.financialRecords.aggregate({ where: { AND: [base, where] }, _count: { _all: true }, _sum: { value: true } });
      return bucketOf(result._count._all, result._sum.value);
    };
    const hasPaidPeriod = Boolean(query.paidFrom || query.paidTo);
    const currentMonth = today.slice(0, 7);
    const receivedWhere: Prisma.FinancialRecordsWhereInput = {
      status: 'received', inactiveAt: null,
      ...(hasPaidPeriod ? {} : { paidAt: range(`${currentMonth}-01`, monthEnd(currentMonth)) }),
    };
    const receivedSum = async () => {
      const rows = await this.prisma.financialRecords.findMany({ where: { AND: [base, receivedWhere] }, select: { value: true, netValue: true, receivedValue: true } });
      return bucketOf(rows.length, rows.reduce((acc, r) => acc + Number(r.receivedValue ?? r.netValue ?? r.value ?? 0), 0));
    };
    const [overdue, dueToday, dueWeek, later, received, lost, openAll] = await Promise.all([
      sum({ ...open, dueDate: windows.overdue }), sum({ ...open, dueDate: windows.dueToday }),
      sum({ ...open, dueDate: windows.dueWeek }), sum({ ...open, OR: [{ dueDate: windows.later }, { dueDate: null }] }),
      receivedSum(), sum({ status: { in: LOST_RECEIVABLE }, inactiveAt: null }), sum(open),
    ]);
    return { overdue, dueToday, dueWeek, later, received, lost, open: openAll, paidPeriod: hasPaidPeriod ? 'filtro' : currentMonth };
  }

  async exportReceivables(companyId: number, query: Query) {
    const view = words(query.view, RECEIVABLE_VIEWS)[0] ?? 'abertas';
    const today = todayBr();
    const ids = ints(query.ids);
    const where = ids.length
      ? { companyId, id: { in: ids } }
      : { AND: [await this.receivableBase(companyId, query), this.receivableView(view, today)] };
    const rows = await this.prisma.financialRecords.findMany({ where, include: this.receivableInclude, orderBy: this.receivableSort(view, query), take: EXPORT_LIMIT });
    const situation = (row: (typeof rows)[number]) => {
      if (row.inactiveAt) return 'Excluída';
      if (OPEN_RECEIVABLE.includes(row.status) && row.dueDate && row.dueDate.toISOString().slice(0, 10) < today) return 'Vencido';
      return STATUS_LABEL[row.status] ?? row.status;
    };
    return buildXlsx([{
      name: 'Contas a receber',
      columns: [
        { header: 'Código', width: 9 }, { header: 'Cliente / aluno', width: 34 }, { header: 'CNPJ/CPF', width: 18 }, { header: 'Descrição', width: 34 },
        { header: 'Parcela', width: 9 }, { header: 'Vencimento', width: 12 }, { header: 'Competência', width: 12 }, { header: 'Valor', width: 14 },
        { header: 'Valor líquido', width: 14 }, { header: 'Situação', width: 12 }, { header: 'Recebimento', width: 12 }, { header: 'Valor recebido', width: 14 },
        { header: 'Juros', width: 12 }, { header: 'Multa', width: 12 }, { header: 'Desconto', width: 12 }, { header: 'Forma', width: 16 },
        { header: 'Origem', width: 12 }, { header: 'Conta de entrada', width: 22 }, { header: 'Plano de contas', width: 32 }, { header: 'Centro de custo', width: 20 },
        { header: 'Nota fiscal', width: 14 }, { header: 'Emissão NF', width: 12 }, { header: 'Vendedor', width: 20 }, { header: 'Observações', width: 40 },
      ],
      rows: rows.map((row) => [
        row.id, row.customer?.name ?? row.trainee?.name ?? row.subscription?.name ?? '', row.customer?.cnpj ?? row.trainee?.cpf ?? '', row.description ?? '',
        row.installmentNumber && row.installmentTotal ? `${row.installmentNumber}/${row.installmentTotal}` : '',
        { date: row.dueDate }, row.accrualDate ?? '', { money: Number(row.value ?? 0) },
        row.netValue === null ? '' : { money: Number(row.netValue) }, situation(row), { date: row.paidAt },
        row.receivedValue === null ? '' : { money: Number(row.receivedValue) },
        row.interestValue === null ? '' : { money: Number(row.interestValue) },
        row.fineValue === null ? '' : { money: Number(row.fineValue) },
        row.discountValue === null ? '' : { money: Number(row.discountValue) },
        METHOD_LABEL[row.paymentMethod] ?? row.paymentMethod, row.gateway, row.bankAccount?.name ?? '',
        row.chartAccount ? `${row.chartAccount.code} ${row.chartAccount.name}` : '', row.costCenter?.name ?? '',
        row.invoiceNumber ?? '', { date: row.invoiceIssuedAt }, row.seller?.name ?? '', row.observations ?? '',
      ]),
    }]);
  }
}

export const exportName = (prefix: string) => `${prefix}-${brDate(todayBr()).split('/').reverse().join('-')}.xlsx`;
export const numberOrNull = n;
export { round };
