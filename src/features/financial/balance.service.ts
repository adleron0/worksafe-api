import { BadRequestException, Injectable } from '@nestjs/common';
import { Financial_BankAccount } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { day, dayStart, plusDays, round, todayBr } from './ledger.filters';

type Body = Record<string, any>;
const fail = (message: string): never => { throw new BadRequestException(message); };
const num = (value: unknown) => Number(value ?? 0);
const dayOf = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const OPEN_RECEIVABLE = ['waiting', 'overdue', 'processing'] as const;

export type AccountWithStart = Financial_BankAccount & { start: string | null };

/** Um movimento de caixa já atribuído (ou não) a uma conta. */
export interface CashMovement {
  day: string;
  accountId: number | null;
  amount: number; // + entra, − sai
  kind: 'in' | 'out' | 'transfer';
}

/**
 * Regra única de saldo do financeiro (Contas Bancárias, Fluxo de caixa, Home e
 * Conciliação usam esta classe, para os números baterem entre as telas).
 *
 * - O saldo inicial de uma conta é o saldo no FIM do dia anterior à data
 *   inicial dela (o "saldo anterior" do extrato naquela data).
 * - A data inicial da conta é a dela; sem ela, a data de implantação da empresa.
 * - Só contam movimentos com data igual ou posterior à data inicial da conta.
 * - Movimento sem conta (ex.: recebível de gateway sem conta de gateway) conta
 *   a partir da data de implantação da empresa.
 */
@Injectable()
export class BalanceService {
  constructor(private readonly prisma: PrismaService) {}

  async startDate(companyId: number): Promise<string | null> {
    const row = await this.prisma.financial_Settings.findUnique({ where: { companyId } });
    return dayOf(row?.startDate);
  }

  async accounts(companyId: number, ids?: number[], entityIds?: number[]): Promise<{ startDate: string | null; accounts: AccountWithStart[] }> {
    const [startDate, rows] = await Promise.all([
      this.startDate(companyId),
      this.prisma.financial_BankAccount.findMany({
        where: { companyId, ...(ids?.length ? { id: { in: ids } } : {}), ...(entityIds?.length ? { entityId: { in: entityIds } } : {}) },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
    ]);
    return { startDate, accounts: rows.map((a) => ({ ...a, start: dayOf(a.openingBalanceDate) ?? startDate })) };
  }

  /**
   * Movimentos de caixa (baixas e transferências) até `to`, já filtrados pela
   * data inicial de cada conta. Com `accountIds`, só os dessas contas (e sem os
   * movimentos sem conta). Com `entityIds`, só as contas desses CNPJs do grupo.
   */
  async movements(companyId: number, options: { to?: string; accountIds?: number[]; entityIds?: number[] } = {}) {
    const { startDate, accounts } = await this.accounts(companyId, options.accountIds, options.entityIds);
    const filtered = !!options.accountIds?.length || !!options.entityIds?.length;
    const byId = new Map(accounts.map((a) => [a.id, a]));
    // recebível de gateway sem conta: vai para a conta do provedor do mesmo CNPJ (cada CNPJ tem a sua conta Asaas)
    const gatewayAccount = new Map<string, number>();
    for (const a of accounts.filter((x) => x.type === 'gateway' && x.gateway)) {
      gatewayAccount.set(`${a.entityId ?? 0}:${a.gateway}`, a.id);
      if (!gatewayAccount.has(`*:${a.gateway}`)) gatewayAccount.set(`*:${a.gateway}`, a.id);
    }
    const upTo = options.to ? { lt: dayStart(plusDays(options.to, 1)) } : undefined;
    const paidAt = { not: null, ...(upTo ?? {}) };

    const [received, paid, transfers] = await Promise.all([
      this.prisma.financialRecords.findMany({
        where: { companyId, status: 'received', inactiveAt: null, paidAt },
        select: { paidAt: true, value: true, netValue: true, receivedValue: true, bankAccountId: true, gateway: true, entityId: true },
      }),
      this.prisma.financial_Payable.findMany({
        where: { companyId, status: 'paga', inactiveAt: null, paidAt },
        select: { paidAt: true, paidValue: true, value: true, bankAccountId: true },
      }),
      this.prisma.financial_Transfer.findMany({
        where: { companyId, inactiveAt: null, ...(upTo ? { date: upTo } : {}) },
        select: { date: true, value: true, fromBankAccountId: true, toBankAccountId: true },
      }),
    ]);

    const list: CashMovement[] = [];
    const push = (dayText: string, accountId: number | null, amount: number, kind: CashMovement['kind']) => {
      if (accountId === null) {
        if (filtered) return;
        if (startDate && dayText < startDate) return;
      } else {
        const account = byId.get(accountId);
        if (!account) return; // conta fora do filtro
        if (account.start && dayText < account.start) return;
      }
      list.push({ day: dayText, accountId, amount, kind });
    };
    for (const r of received) {
      const accountId = r.bankAccountId ?? gatewayAccount.get(`${r.entityId ?? 0}:${r.gateway}`) ?? gatewayAccount.get(`*:${r.gateway}`) ?? null;
      push(dayOf(r.paidAt)!, accountId, num(r.receivedValue ?? r.netValue ?? r.value), 'in');
    }
    for (const p of paid) push(dayOf(p.paidAt)!, p.bankAccountId ?? null, -num(p.paidValue ?? p.value), 'out');
    for (const t of transfers) {
      const dayText = dayOf(t.date)!;
      // cada perna respeita a data inicial da própria conta
      push(dayText, t.fromBankAccountId, -num(t.value), 'transfer');
      push(dayText, t.toBankAccountId, num(t.value), 'transfer');
    }
    return { startDate, accounts, list };
  }

  /** O saldo inicial da conta já existe no fim do dia `dayText`? (vale a partir da véspera da data inicial) */
  static openingCounts(account: AccountWithStart, dayText: string) {
    return !account.start || plusDays(account.start, -1) <= dayText;
  }

  /** Saldo de cada conta no fim do dia `date` (sem data: tudo o que já foi lançado). */
  async balances(companyId: number, date?: string, accountIds?: number[], entityIds?: number[]) {
    const { startDate, accounts, list } = await this.movements(companyId, { to: date, accountIds: accountIds?.length ? accountIds : undefined, entityIds: entityIds?.length ? entityIds : undefined });
    const rows = accounts.map((account) => {
      const mine = list.filter((m) => m.accountId === account.id);
      const sum = (kind: CashMovement['kind']) => mine.filter((m) => m.kind === kind).reduce((s, m) => s + m.amount, 0);
      const opening = !date || BalanceService.openingCounts(account, date) ? num(account.openingBalance) : 0;
      const received = sum('in'), paid = -sum('out'), transfers = sum('transfer');
      return {
        id: account.id, start: account.start,
        opening: round(opening), received: round(received), paid: round(paid), transfers: round(transfers),
        balance: round(opening + received - paid + transfers),
      };
    });
    return { startDate, accounts, rows };
  }

  // ------------------------------------------------------------ implantação

  /** Data, saldos e o que existe antes e depois da data, para a tela de implantação. */
  async setup(companyId: number) {
    const today = todayBr();
    const { startDate, accounts, rows } = await this.balances(companyId);
    const firstOfPrevious = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
    const ref = startDate ?? firstOfPrevious;
    const since = { gte: dayStart(ref) };
    const before = { lt: dayStart(ref) };
    const [receivedBefore, paidBefore, overduePayables, overdueReceivables, openPayables, openReceivables, receivedSince, paidSince, reconciledPayables, reconciledReceivables, transfersSince] = await Promise.all([
      this.prisma.financialRecords.aggregate({ where: { companyId, status: 'received', inactiveAt: null, paidAt: before }, _count: true, _sum: { receivedValue: true } }),
      this.prisma.financial_Payable.aggregate({ where: { companyId, status: 'paga', inactiveAt: null, paidAt: before }, _count: true, _sum: { paidValue: true } }),
      this.prisma.financial_Payable.aggregate({ where: { companyId, status: 'aberta', inactiveAt: null, dueDate: { lt: dayStart(today) } }, _count: true, _sum: { value: true } }),
      this.prisma.financialRecords.aggregate({ where: { companyId, status: { in: [...OPEN_RECEIVABLE] }, inactiveAt: null, dueDate: { lt: dayStart(today) } }, _count: true, _sum: { value: true } }),
      this.prisma.financial_Payable.count({ where: { companyId, status: 'aberta', inactiveAt: null } }),
      this.prisma.financialRecords.count({ where: { companyId, status: { in: [...OPEN_RECEIVABLE] }, inactiveAt: null } }),
      this.prisma.financialRecords.count({ where: { companyId, status: 'received', inactiveAt: null, paidAt: since } }),
      this.prisma.financial_Payable.count({ where: { companyId, status: 'paga', inactiveAt: null, paidAt: since } }),
      this.prisma.financial_Payable.count({ where: { companyId, inactiveAt: null, statementRef: { not: null } } }),
      this.prisma.financialRecords.count({ where: { companyId, inactiveAt: null, statementRef: { not: null } } }),
      this.prisma.financial_Transfer.count({ where: { companyId, inactiveAt: null, date: since } }),
    ]);
    return {
      today, startDate, suggestedStartDate: firstOfPrevious,
      accounts: accounts.filter((a) => !a.inactiveAt).map((a) => {
        const row = rows.find((r) => r.id === a.id)!;
        return {
          id: a.id, name: a.name, type: a.type, bankName: a.bankName, gateway: a.gateway, isDefault: a.isDefault,
          openingBalance: num(a.openingBalance), openingBalanceDate: dayOf(a.openingBalanceDate), start: a.start,
          // a conta tem data própria diferente da data da empresa
          ownDate: !!a.openingBalanceDate && !!startDate && dayOf(a.openingBalanceDate) !== startDate,
          balance: row.balance,
        };
      }),
      before: {
        date: ref,
        received: { count: receivedBefore._count, total: round(num(receivedBefore._sum.receivedValue)) },
        paid: { count: paidBefore._count, total: round(num(paidBefore._sum.paidValue)) },
      },
      overdue: {
        payables: { count: overduePayables._count, total: round(num(overduePayables._sum.value)) },
        receivables: { count: overdueReceivables._count, total: round(num(overdueReceivables._sum.value)) },
      },
      progress: {
        openPayables, openReceivables, receivedSince, paidSince, transfersSince,
        reconciled: reconciledPayables + reconciledReceivables,
      },
    };
  }

  /**
   * Grava a data de implantação e o saldo inicial das contas informadas (todas
   * passam a ter a data de implantação como data do saldo inicial).
   */
  async saveSetup(actor: { companyId: number; userId: number }, body: Body) {
    const startDate = day(body.startDate, 'Data inicial') ?? fail('Informe a data inicial');
    if (startDate > todayBr()) fail('A data inicial não pode ser futura');
    const items: Body[] = Array.isArray(body.accounts) ? body.accounts : [];
    const ids = items.map((i) => Number(i.id));
    if (ids.some((id) => !id)) fail('Conta inválida');
    const owned = await this.prisma.financial_BankAccount.findMany({ where: { companyId: actor.companyId, id: { in: ids } }, select: { id: true } });
    if (owned.length !== new Set(ids).size) fail('Conta não encontrada');
    const values = items.map((i) => {
      const raw = i.openingBalance === '' || i.openingBalance === null || i.openingBalance === undefined ? 0 : Number(i.openingBalance);
      if (!Number.isFinite(raw)) fail('Saldo inicial inválido');
      return { id: Number(i.id), openingBalance: round(raw) };
    });
    const date = dayStart(startDate);
    await this.prisma.$transaction([
      this.prisma.financial_Settings.upsert({
        where: { companyId: actor.companyId },
        update: { startDate: date, updatedByUserId: actor.userId || null },
        create: { companyId: actor.companyId, startDate: date, updatedByUserId: actor.userId || null },
      }),
      ...values.map((v) => this.prisma.financial_BankAccount.update({ where: { id: v.id }, data: { openingBalance: v.openingBalance, openingBalanceDate: date } })),
    ]);
    return this.setup(actor.companyId);
  }
}
