import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, financialRecordsStatus } from '@prisma/client';
import { XlsxCell, XlsxSheet, brDate } from 'src/common/xlsx';
import { PrismaService } from 'src/prisma/prisma.service';
import { Query, day, dayStart, ints, month, monthEnd, plusDays, round, todayBr } from './ledger.filters';
import { BalanceService } from './balance.service';
import { RecurrenceService } from './recurrence.service';

const fail = (message: string): never => { throw new BadRequestException(message); };
const OPEN: financialRecordsStatus[] = ['waiting', 'overdue', 'processing'];
const LOST: financialRecordsStatus[] = ['cancelled', 'declined', 'chargeback'];
const num = (value: unknown) => Number(value ?? 0);

type Group = 'day' | 'week' | 'month';
interface Period { key: string; label: string; start: string; end: string }

/** Segunda-feira da semana de um dia (AAAA-MM-DD). */
function monday(dayText: string): string {
  const date = new Date(`${dayText}T12:00:00.000Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  return plusDays(dayText, -weekday);
}

function periods(from: string, to: string, group: Group): Period[] {
  const out: Period[] = [];
  if (group === 'day') {
    for (let d = from; d <= to && out.length < 400; d = plusDays(d, 1)) out.push({ key: d, label: brDate(d).slice(0, 5), start: d, end: d });
  } else if (group === 'week') {
    for (let d = monday(from); d <= to && out.length < 120; d = plusDays(d, 7)) {
      const start = d < from ? from : d;
      const end = plusDays(d, 6) > to ? to : plusDays(d, 6);
      out.push({ key: d, label: `${brDate(start).slice(0, 5)} a ${brDate(end).slice(0, 5)}`, start, end });
    }
  } else {
    let m = from.slice(0, 7);
    while (m <= to.slice(0, 7) && out.length < 60) {
      const start = `${m}-01` < from ? from : `${m}-01`;
      const end = monthEnd(m) > to ? to : monthEnd(m);
      const [y, mm] = m.split('-');
      out.push({ key: m, label: `${mm}/${y}`, start, end });
      const next = new Date(Date.UTC(Number(y), Number(mm), 1));
      m = next.toISOString().slice(0, 7);
    }
  }
  return out;
}

/** Linhas da DRE, na ordem em que aparecem. `sign` diz se soma ou subtrai do resultado. */
const DRE_LINES: Array<{ key: string; label: string; nature: 'receita' | 'despesa'; sign: 1 | -1 }> = [
  { key: 'receita_bruta', label: 'Receita bruta', nature: 'receita', sign: 1 },
  { key: 'deducoes_impostos', label: '(−) Deduções e impostos', nature: 'despesa', sign: -1 },
  { key: 'custo_servico', label: '(−) Custo dos serviços', nature: 'despesa', sign: -1 },
  { key: 'despesa_operacional', label: '(−) Despesas operacionais', nature: 'despesa', sign: -1 },
  { key: 'outras_receitas', label: '(+) Outras receitas', nature: 'receita', sign: 1 },
  { key: 'sem_receita', label: '(+) Receitas sem classificação', nature: 'receita', sign: 1 },
  { key: 'sem_despesa', label: '(−) Despesas sem classificação', nature: 'despesa', sign: -1 },
];

@Injectable()
export class ReportService {
  constructor(private readonly prisma: PrismaService, private readonly recurrences: RecurrenceService, private readonly balance: BalanceService) {}

  // ------------------------------------------------------------ fluxo de caixa

  /**
   * Fluxo de caixa: o que entrou e saiu de fato (pela data do pagamento) e o
   * que está previsto (contas em aberto, pelo vencimento, de hoje em diante),
   * com o saldo acumulado a partir do saldo das contas no início do período.
   * Contas em aberto já vencidas ficam à parte (atrasadas), sem distorcer a
   * projeção. Transferências entre contas só aparecem quando o filtro é por conta.
   */
  async cashFlow(companyId: number, query: Query) {
    await this.recurrences.ensure(companyId);
    const today = todayBr();
    const from = day(query.from, 'Data inicial') ?? `${today.slice(0, 7)}-01`;
    const to = day(query.to, 'Data final') ?? plusDays(from, 89);
    if (from > to) fail('A data inicial é maior que a final');
    const group = (['day', 'week', 'month'].includes(String(query.group)) ? query.group : 'week') as Group;
    const banks = ints(query.bankAccountId);
    // CNPJ do grupo: só as contas bancárias e as contas em aberto dele (vazio = o grupo todo)
    const entities = ints(query.entityId);
    const byEntity = entities.length ? { entityId: { in: entities } } : {};
    // baixas e transferências até o fim do período, já pela data inicial de cada conta
    const { accounts, list: moves } = await this.balance.movements(companyId, { to, accountIds: banks.length ? banks : undefined, entityIds: entities.length ? entities : undefined });
    const [openReceivables, openPayables] = await Promise.all([
      this.prisma.financialRecords.findMany({ where: { companyId, ...byEntity, status: { in: OPEN }, inactiveAt: null, dueDate: { lt: dayStart(plusDays(to, 1)) } }, select: { dueDate: true, value: true, netValue: true } }),
      this.prisma.financial_Payable.findMany({ where: { companyId, ...byEntity, status: 'aberta', inactiveAt: null, dueDate: { lt: dayStart(plusDays(to, 1)) } }, select: { dueDate: true, value: true } }),
    ]);

    // saldo no início do período = saldo no fim da véspera: saldos iniciais que
    // já valiam + tudo o que se moveu antes. Conta que começa dentro do período
    // entra com o saldo inicial no dia em que começa.
    const eve = plusDays(from, -1);
    let opening = 0;
    const openingsInside: Array<{ day: string; value: number }> = [];
    for (const account of accounts) {
      if (BalanceService.openingCounts(account, eve)) opening += num(account.openingBalance);
      else if (account.start && account.start <= to) openingsInside.push({ day: account.start, value: num(account.openingBalance) });
    }
    for (const m of moves) if (m.day < from) opening += m.amount;

    const list = periods(from, to, group);
    const indexOf = (dayText: string) => list.findIndex((p) => dayText >= p.start && dayText <= p.end);
    const rows = list.map((p) => ({ ...p, realizedIn: 0, realizedOut: 0, projectedIn: 0, projectedOut: 0, transfers: 0, opening: 0, closing: 0 }));
    for (const m of moves) {
      if (m.day < from) continue;
      const i = indexOf(m.day);
      if (i < 0) continue;
      if (m.kind === 'in') rows[i].realizedIn += m.amount;
      else if (m.kind === 'out') rows[i].realizedOut -= m.amount;
      else rows[i].transfers += m.amount;
    }
    const openingAdds = rows.map(() => 0);
    for (const o of openingsInside) { const i = indexOf(o.day); if (i >= 0) openingAdds[i] += o.value; }
    let overdueIn = 0, overdueOut = 0, overdueInCount = 0, overdueOutCount = 0;
    for (const r of openReceivables) {
      const due = r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null;
      if (!due) continue;
      const value = num(r.netValue ?? r.value);
      if (due < today) { overdueIn += value; overdueInCount++; continue; }
      const i = indexOf(due); if (i >= 0) rows[i].projectedIn += value;
    }
    for (const p of openPayables) {
      const due = p.dueDate.toISOString().slice(0, 10);
      if (due < today) { overdueOut += num(p.value); overdueOutCount++; continue; }
      const i = indexOf(due); if (i >= 0) rows[i].projectedOut += num(p.value);
    }
    let running = opening;
    rows.forEach((row, i) => {
      running += openingAdds[i];
      row.opening = round(running);
      running += row.realizedIn - row.realizedOut + row.projectedIn - row.projectedOut + row.transfers;
      row.closing = round(running);
      for (const key of ['realizedIn', 'realizedOut', 'projectedIn', 'projectedOut', 'transfers'] as const) row[key] = round(row[key]);
    });
    const total = (key: 'realizedIn' | 'realizedOut' | 'projectedIn' | 'projectedOut' | 'transfers') => round(rows.reduce((s, r) => s + r[key], 0));
    const lowest = rows.reduce<null | (typeof rows)[number]>((low, r) => (!low || r.closing < low.closing ? r : low), null);
    return {
      today, from, to, group, bankAccountIds: banks,
      opening: round(opening), closing: round(running),
      totals: { realizedIn: total('realizedIn'), realizedOut: total('realizedOut'), projectedIn: total('projectedIn'), projectedOut: total('projectedOut'), transfers: total('transfers') },
      overdue: { in: round(overdueIn), inCount: overdueInCount, out: round(overdueOut), outCount: overdueOutCount },
      lowest: lowest ? { key: lowest.key, label: lowest.label, closing: lowest.closing } : null,
      rows,
    };
  }

  cashFlowSheet(data: Awaited<ReturnType<ReportService['cashFlow']>>): XlsxSheet {
    return {
      name: 'Fluxo de caixa',
      columns: [
        { header: 'Período', width: 18 }, { header: 'Saldo inicial', width: 15 }, { header: 'Entradas realizadas', width: 18 }, { header: 'Saídas realizadas', width: 17 },
        { header: 'Entradas previstas', width: 17 }, { header: 'Saídas previstas', width: 16 }, { header: 'Transferências', width: 15 }, { header: 'Saldo final', width: 15 },
      ],
      rows: [
        ...data.rows.map((r): XlsxCell[] => [r.label, { money: r.opening }, { money: r.realizedIn }, { money: r.realizedOut }, { money: r.projectedIn }, { money: r.projectedOut }, { money: r.transfers }, { money: r.closing }]),
        [],
        ['Total', { money: data.opening }, { money: data.totals.realizedIn }, { money: data.totals.realizedOut }, { money: data.totals.projectedIn }, { money: data.totals.projectedOut }, { money: data.totals.transfers }, { money: data.closing }],
        [],
        ['A receber atrasado', { money: data.overdue.in }, `${data.overdue.inCount} conta(s), fora da projeção`],
        ['A pagar atrasado', { money: data.overdue.out }, `${data.overdue.outCount} conta(s), fora da projeção`],
      ],
    };
  }

  // ------------------------------------------------------------ DRE

  /**
   * DRE gerencial por mês. Competência (padrão): o que pertence ao mês, pago
   * ou não. Caixa: o que entrou e saiu no mês. A linha de cada conta vem do
   * grupo de DRE da própria conta ou da conta mãe mais próxima; juros, multa e
   * desconto das baixas formam o resultado financeiro.
   */
  async dre(companyId: number, query: Query) {
    const today = todayBr();
    const to = month(query.to, 'Mês final') ?? today.slice(0, 7);
    const defaultFrom = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 6, 1)).toISOString().slice(0, 7);
    const from = month(query.from, 'Mês inicial') ?? defaultFrom;
    if (from > to) fail('O mês inicial é maior que o final');
    const basis = query.basis === 'caixa' ? 'caixa' : 'competencia';
    const months = periods(`${from}-01`, monthEnd(to), 'month').map((p) => p.key);
    if (months.length > 24) fail('Escolha no máximo 24 meses');

    const accounts = await this.prisma.financial_ChartAccount.findMany({ where: { companyId }, select: { id: true, parentId: true, code: true, name: true, dreGroup: true, nature: true } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const groupOf = (id: number | null, nature: 'receita' | 'despesa'): string => {
      let current = id ? byId.get(id) : undefined;
      while (current) {
        if (current.dreGroup) return current.dreGroup;
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return nature === 'receita' ? 'sem_receita' : 'sem_despesa';
    };

    const periodRange = { gte: dayStart(`${from}-01`), lt: dayStart(plusDays(monthEnd(to), 1)) };
    // CNPJ do grupo (vazio = o consolidado do grupo)
    const entities = ints(query.entityId);
    const byEntity = entities.length ? { entityId: { in: entities } } : {};
    const receivables = await this.prisma.financialRecords.findMany({
      where: basis === 'caixa'
        ? { companyId, ...byEntity, inactiveAt: null, status: 'received', paidAt: periodRange }
        : { companyId, ...byEntity, inactiveAt: null, status: { notIn: LOST }, accrualDate: { gte: from, lte: to } },
      select: { accrualDate: true, paidAt: true, value: true, chartAccountId: true, interestValue: true, fineValue: true, discountValue: true },
    });
    const payables = await this.prisma.financial_Payable.findMany({
      where: basis === 'caixa'
        ? { companyId, ...byEntity, inactiveAt: null, status: 'paga', paidAt: periodRange }
        : { companyId, ...byEntity, inactiveAt: null, accrualDate: { gte: from, lte: to } },
      select: { accrualDate: true, paidAt: true, value: true, chartAccountId: true, interestValue: true, fineValue: true, discountValue: true },
    });

    type Line = { values: Record<string, number>; accounts: Map<string, { id: number | null; code: string; name: string; values: Record<string, number> }> };
    const lines = new Map<string, Line>();
    const add = (group: string, accountId: number | null, monthKey: string, value: number) => {
      if (!months.includes(monthKey)) return;
      const line = lines.get(group) ?? { values: {}, accounts: new Map() };
      line.values[monthKey] = (line.values[monthKey] ?? 0) + value;
      const account = accountId ? byId.get(accountId) : undefined;
      const accountKey = account ? String(account.id) : 'none';
      const row = line.accounts.get(accountKey) ?? { id: account?.id ?? null, code: account?.code ?? '', name: account?.name ?? 'Sem conta do plano', values: {} };
      row.values[monthKey] = (row.values[monthKey] ?? 0) + value;
      line.accounts.set(accountKey, row);
      lines.set(group, line);
    };
    const financial = { in: {} as Record<string, number>, out: {} as Record<string, number> };
    const monthOf = (row: { accrualDate: string | null; paidAt: Date | null }) => (basis === 'caixa' ? row.paidAt!.toISOString().slice(0, 7) : String(row.accrualDate).slice(0, 7));
    for (const r of receivables) {
      const m = monthOf(r);
      add(groupOf(r.chartAccountId, 'receita'), r.chartAccountId, m, num(r.value));
      // juros e multa recebidos entram; desconto concedido sai
      const fin = num(r.interestValue) + num(r.fineValue) - num(r.discountValue);
      if (fin) financial.in[m] = (financial.in[m] ?? 0) + fin;
    }
    for (const p of payables) {
      const m = monthOf(p);
      add(groupOf(p.chartAccountId, 'despesa'), p.chartAccountId, m, num(p.value));
      // juros e multa pagos saem; desconto obtido entra
      const fin = num(p.interestValue) + num(p.fineValue) - num(p.discountValue);
      if (fin) financial.out[m] = (financial.out[m] ?? 0) + fin;
    }

    const sumMonths = (values: Record<string, number>) => round(months.reduce((s, m) => s + (values[m] ?? 0), 0));
    const toRow = (key: string, label: string, kind: 'line' | 'total' | 'result', values: Record<string, number>, accountsRows: Array<{ id: number | null; code: string; name: string; values: Record<string, number> }> = []) => ({
      key, label, kind,
      values: Object.fromEntries(months.map((m) => [m, round(values[m] ?? 0)])),
      total: sumMonths(values),
      accounts: accountsRows
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
        .map((a) => ({ ...a, values: Object.fromEntries(months.map((m) => [m, round(a.values[m] ?? 0)])), total: sumMonths(a.values) })),
    });
    const lineValues = (key: string) => lines.get(key)?.values ?? {};
    const combine = (parts: Array<[string, number]>) => {
      const out: Record<string, number> = {};
      for (const m of months) out[m] = parts.reduce((s, [key, sign]) => s + sign * (lineValues(key)[m] ?? 0), 0);
      return out;
    };
    const lineRow = (key: string) => {
      const def = DRE_LINES.find((l) => l.key === key)!;
      return toRow(key, def.label, 'line', lineValues(key), [...(lines.get(key)?.accounts.values() ?? [])]);
    };
    // grupos de DRE personalizados (fora da lista padrão) entram como linhas próprias
    const custom = [...lines.keys()].filter((key) => !DRE_LINES.some((l) => l.key === key));
    const netRevenue = combine([['receita_bruta', 1], ['deducoes_impostos', -1]]);
    const grossProfit = combine([['receita_bruta', 1], ['deducoes_impostos', -1], ['custo_servico', -1]]);
    const operating = combine([['receita_bruta', 1], ['deducoes_impostos', -1], ['custo_servico', -1], ['despesa_operacional', -1], ['outras_receitas', 1]]);
    const financialNet: Record<string, number> = {};
    for (const m of months) financialNet[m] = (financial.in[m] ?? 0) - (financial.out[m] ?? 0);
    const customNet: Record<string, number> = {};
    for (const m of months) customNet[m] = custom.reduce((s, key) => s + (lineValues(key)[m] ?? 0) * (/receita/.test(key) ? 1 : -1), 0);
    const unclassified = combine([['sem_receita', 1], ['sem_despesa', -1]]);
    const result: Record<string, number> = {};
    for (const m of months) result[m] = operating[m] + financialNet[m] + customNet[m] + unclassified[m];

    const rows = [
      lineRow('receita_bruta'),
      lineRow('deducoes_impostos'),
      toRow('receita_liquida', '= Receita líquida', 'total', netRevenue),
      lineRow('custo_servico'),
      toRow('lucro_bruto', '= Lucro bruto', 'total', grossProfit),
      lineRow('despesa_operacional'),
      lineRow('outras_receitas'),
      toRow('resultado_operacional', '= Resultado operacional', 'total', operating),
      toRow('financeiro_receitas', '(+) Juros e multas recebidos', 'line', financial.in),
      toRow('financeiro_despesas', '(−) Juros e multas pagos', 'line', financial.out),
      ...custom.map((key) => toRow(key, key.replace(/_/g, ' '), 'line', lineValues(key), [...(lines.get(key)?.accounts.values() ?? [])])),
      lineRow('sem_receita'),
      lineRow('sem_despesa'),
      toRow('resultado', '= Resultado do período', 'result', result),
    ];
    const margin = Object.fromEntries(months.map((m) => [m, lineValues('receita_bruta')[m] ? round((result[m] / lineValues('receita_bruta')[m]) * 100) : null]));
    return { from, to, basis, months, rows, margin };
  }

  dreSheet(data: Awaited<ReturnType<ReportService['dre']>>): XlsxSheet {
    const label = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
    const out: XlsxCell[][] = [];
    for (const row of data.rows) {
      out.push([row.label, ...data.months.map((m) => ({ money: row.values[m] })), { money: row.total }]);
      for (const account of row.accounts) out.push([`      ${account.code} ${account.name}`.trimEnd(), ...data.months.map((m) => ({ money: account.values[m] })), { money: account.total }]);
    }
    out.push([]);
    out.push(['Margem (%)', ...data.months.map((m) => data.margin[m] ?? '')]);
    return {
      name: data.basis === 'caixa' ? 'DRE (caixa)' : 'DRE (competência)',
      columns: [{ header: 'Linha', width: 44 }, ...data.months.map((m) => ({ header: label(m), width: 14 })), { header: 'Total', width: 15 }],
      rows: out,
    };
  }
}
