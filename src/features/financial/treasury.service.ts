import { Prisma } from '@prisma/client';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { FinancialrecordsService } from 'src/features/gateway/financialrecords/service';
import { PrismaService } from 'src/prisma/prisma.service';
import { BalanceService } from './balance.service';
import { assertClassification } from './classification';
import { Query, day, dayStart, plusDays, round, todayBr } from './ledger.filters';
import { PayableActor, PayableService } from './payable.service';
import { normalizePayable, payableDay, payableMoney } from './payable.rules';

type Body = Record<string, any>;
const fail = (message: string): never => { throw new BadRequestException(message); };
const blank = (value: unknown) => value === undefined || value === null || value === '';
const OPEN_RECEIVABLE = ['waiting', 'overdue', 'processing'] as const;

export interface StatementLine { fitId: string; date: string; amount: number; memo: string; type: string }

/** Lê um extrato OFX (SGML 1.x ou XML 2.x). Só o que importa: data, valor, identificador e histórico. */
export function parseOfx(content: string): { lines: StatementLine[]; bankId: string | null; accountId: string | null; ledger: { amount: number; date: string } | null } {
  const text = content.replace(/\r/g, '');
  if (!/<OFX>/i.test(text)) fail('Arquivo não parece ser um extrato OFX');
  const tag = (block: string, name: string) => {
    const match = new RegExp(`<${name}>([^<\\n]*)`, 'i').exec(block);
    return match ? match[1].trim() : '';
  };
  const lines: StatementLine[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/STMTTRN>/i)[0];
    const posted = tag(block, 'DTPOSTED');
    const amountText = tag(block, 'TRNAMT').replace(',', '.');
    const amount = Number(amountText);
    if (!/^\d{8}/.test(posted) || !Number.isFinite(amount) || amount === 0) continue;
    const date = `${posted.slice(0, 4)}-${posted.slice(4, 6)}-${posted.slice(6, 8)}`;
    const memo = [tag(block, 'NAME'), tag(block, 'MEMO')].filter(Boolean).join(' · ').slice(0, 200);
    const fitId = (tag(block, 'FITID') || `${date}:${amount}:${memo}`).slice(0, 60);
    lines.push({ fitId, date, amount: round(amount), memo, type: tag(block, 'TRNTYPE') });
  }
  // saldo final informado pelo banco (LEDGERBAL): valor e data a que se refere
  const ledgerBlock = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|$)/i.exec(text)?.[1] ?? '';
  const ledgerAmount = Number(tag(ledgerBlock, 'BALAMT').replace(',', '.'));
  const ledgerDate = tag(ledgerBlock, 'DTASOF');
  const ledger = ledgerBlock && tag(ledgerBlock, 'BALAMT') !== '' && Number.isFinite(ledgerAmount) && /^\d{8}/.test(ledgerDate)
    ? { amount: round(ledgerAmount), date: `${ledgerDate.slice(0, 4)}-${ledgerDate.slice(4, 6)}-${ledgerDate.slice(6, 8)}` }
    : null;
  return { lines, bankId: tag(text, 'BANKID') || null, accountId: tag(text, 'ACCTID') || null, ledger };
}

const daysBetween = (a: string, b: string) => Math.abs((new Date(`${a}T12:00:00Z`).getTime() - new Date(`${b}T12:00:00Z`).getTime()) / 86400000);

/**
 * Tesouraria: transferências entre contas e conciliação do extrato bancário.
 * A conciliação casa cada linha do OFX com uma conta já lançada (mesmo valor,
 * data próxima); o que casar é baixado com a data do extrato, e o que não
 * tiver par pode virar conta a pagar já paga. Cada linha guarda o FITID, então
 * importar o mesmo extrato de novo não baixa nada duas vezes.
 */
@Injectable()
export class TreasuryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payables: PayableService,
    private readonly receivables: FinancialrecordsService,
    private readonly balance: BalanceService,
  ) {}

  // ------------------------------------------------------------ transferências

  async transfers(companyId: number, query: Query) {
    const from = day(query.from, 'Data inicial');
    const to = day(query.to, 'Data final');
    return this.prisma.financial_Transfer.findMany({
      where: {
        companyId, ...(query.inactive === 'true' ? {} : { inactiveAt: null }),
        ...(from || to ? { date: { ...(from ? { gte: dayStart(from) } : {}), ...(to ? { lt: dayStart(plusDays(to, 1)) } : {}) } } : {}),
      },
      include: { fromBankAccount: { select: { id: true, name: true } }, toBankAccount: { select: { id: true, name: true } } },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: 300,
    });
  }

  async createTransfer(actor: PayableActor, body: Body, statementRef?: string) {
    const fromId = Number(body.fromBankAccountId), toId = Number(body.toBankAccountId);
    if (!fromId || !toId) fail('Informe a conta de origem e a de destino');
    if (fromId === toId) fail('A conta de origem e a de destino precisam ser diferentes');
    await assertClassification(this.prisma, actor.companyId, { bankAccountId: fromId });
    await assertClassification(this.prisma, actor.companyId, { bankAccountId: toId });
    const value = payableMoney(body.value, 'Valor', 'value', fail);
    const date = payableDay(blank(body.date) ? todayBr() : body.date, 'Data', 'date', fail);
    if (date.toISOString().slice(0, 10) > todayBr()) fail('A data da transferência não pode ser futura');
    return this.prisma.financial_Transfer.create({
      data: {
        companyId: actor.companyId, fromBankAccountId: fromId, toBankAccountId: toId, value, date,
        description: String(body.description ?? '').trim().slice(0, 255) || null, statementRef: statementRef ?? null, createdByUserId: actor.userId || null,
      },
    });
  }

  async archiveTransfer(actor: PayableActor, id: number) {
    const row = await this.prisma.financial_Transfer.findFirst({ where: { id, companyId: actor.companyId } });
    if (!row) throw new NotFoundException('Transferência não encontrada');
    if (row.inactiveAt) throw new ConflictException('Transferência já desfeita');
    return this.prisma.financial_Transfer.update({ where: { id }, data: { inactiveAt: new Date() } });
  }

  // ------------------------------------------------------------ conciliação

  private ref(bankAccountId: number, fitId: string) { return `${bankAccountId}:${fitId}`.slice(0, 80); }

  async preview(companyId: number, bankAccountIdRaw: unknown, content: string) {
    const bankAccountId = Number(bankAccountIdRaw);
    if (!bankAccountId) fail('Escolha a conta bancária do extrato');
    await assertClassification(this.prisma, companyId, { bankAccountId });
    const { lines, bankId, accountId, ledger } = parseOfx(content);
    if (!lines.length) fail('Nenhum lançamento encontrado no extrato');
    const { accounts } = await this.balance.accounts(companyId, [bankAccountId]);
    const start = accounts[0]?.start ?? null;
    const refs = lines.map((l) => this.ref(bankAccountId, l.fitId));
    const dates = lines.map((l) => l.date).sort();
    const from = dayStart(plusDays(dates[0], -20)), to = dayStart(plusDays(dates[dates.length - 1], 21));

    const [usedPayables, usedReceivables, usedTransfers, openPayables, openReceivables, paidPayables, receivedRecords] = await Promise.all([
      this.prisma.financial_Payable.findMany({ where: { companyId, statementRef: { in: refs } }, select: { id: true, statementRef: true, description: true } }),
      this.prisma.financialRecords.findMany({ where: { companyId, statementRef: { in: refs } }, select: { id: true, statementRef: true, description: true } }),
      this.prisma.financial_Transfer.findMany({ where: { companyId, statementRef: { in: refs }, inactiveAt: null }, select: { id: true, statementRef: true } }),
      this.prisma.financial_Payable.findMany({
        where: { companyId, status: 'aberta', inactiveAt: null, dueDate: { gte: from, lt: to } },
        select: { id: true, description: true, value: true, dueDate: true, supplier: { select: { name: true } } },
      }),
      this.prisma.financialRecords.findMany({
        where: { companyId, gateway: 'manual', status: { in: [...OPEN_RECEIVABLE] }, inactiveAt: null, dueDate: { gte: from, lt: to } },
        select: { id: true, description: true, value: true, netValue: true, dueDate: true, customer: { select: { name: true } }, trainee: { select: { name: true } } },
      }),
      this.prisma.financial_Payable.findMany({
        where: { companyId, status: 'paga', inactiveAt: null, statementRef: null, bankAccountId, paidAt: { gte: from, lt: to } },
        select: { id: true, description: true, paidValue: true, paidAt: true, supplier: { select: { name: true } } },
      }),
      this.prisma.financialRecords.findMany({
        where: { companyId, status: 'received', inactiveAt: null, statementRef: null, bankAccountId, paidAt: { gte: from, lt: to } },
        select: { id: true, description: true, receivedValue: true, value: true, netValue: true, paidAt: true, customer: { select: { name: true } }, trainee: { select: { name: true } } },
      }),
    ]);
    const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
    const items = lines.map((line) => {
      const ref = this.ref(bankAccountId, line.fitId);
      const done = usedPayables.find((p) => p.statementRef === ref) ?? usedReceivables.find((r) => r.statementRef === ref) ?? usedTransfers.find((t) => t.statementRef === ref);
      if (done) return { ...line, status: 'conciliado' as const, candidates: [] };
      // antes da data inicial: já está dentro do saldo inicial, não se lança
      if (start && line.date < start) return { ...line, status: 'antes_inicio' as const, candidates: [] };
      const value = Math.abs(line.amount);
      type Candidate = { type: 'payable' | 'receivable'; mode: 'baixar' | 'vincular'; id: number; label: string; who: string; value: number; date: string; distance: number };
      const candidates: Candidate[] = [];
      if (line.amount < 0) {
        for (const p of openPayables) if (near(Number(p.value), value) && daysBetween(p.dueDate.toISOString().slice(0, 10), line.date) <= 20) {
          candidates.push({ type: 'payable', mode: 'baixar', id: p.id, label: p.description, who: p.supplier?.name ?? '', value: Number(p.value), date: p.dueDate.toISOString().slice(0, 10), distance: daysBetween(p.dueDate.toISOString().slice(0, 10), line.date) });
        }
        for (const p of paidPayables) if (near(Number(p.paidValue), value) && daysBetween(p.paidAt!.toISOString().slice(0, 10), line.date) <= 5) {
          candidates.push({ type: 'payable', mode: 'vincular', id: p.id, label: p.description, who: p.supplier?.name ?? '', value: Number(p.paidValue), date: p.paidAt!.toISOString().slice(0, 10), distance: daysBetween(p.paidAt!.toISOString().slice(0, 10), line.date) - 100 });
        }
      } else {
        for (const r of openReceivables) {
          const expected = Number(r.netValue ?? r.value ?? 0);
          if (r.dueDate && (near(expected, value) || near(Number(r.value ?? 0), value)) && daysBetween(r.dueDate.toISOString().slice(0, 10), line.date) <= 20) {
            candidates.push({ type: 'receivable', mode: 'baixar', id: r.id, label: r.description ?? 'Conta a receber', who: r.customer?.name ?? r.trainee?.name ?? '', value: expected, date: r.dueDate.toISOString().slice(0, 10), distance: daysBetween(r.dueDate.toISOString().slice(0, 10), line.date) });
          }
        }
        for (const r of receivedRecords) {
          const got = Number(r.receivedValue ?? r.netValue ?? r.value ?? 0);
          if (near(got, value) && daysBetween(r.paidAt!.toISOString().slice(0, 10), line.date) <= 5) {
            candidates.push({ type: 'receivable', mode: 'vincular', id: r.id, label: r.description ?? 'Conta a receber', who: r.customer?.name ?? r.trainee?.name ?? '', value: got, date: r.paidAt!.toISOString().slice(0, 10), distance: daysBetween(r.paidAt!.toISOString().slice(0, 10), line.date) - 100 });
          }
        }
      }
      candidates.sort((a, b) => a.distance - b.distance);
      return { ...line, status: candidates.length ? ('sugerido' as const) : ('sem_par' as const), candidates: candidates.slice(0, 5).map(({ distance: _d, ...c }) => c) };
    });
    // conferência: saldo do extrato x saldo do sistema na mesma data
    const checkDate = ledger?.date ?? dates[dates.length - 1];
    const { rows } = await this.balance.balances(companyId, checkDate, [bankAccountId]);
    return {
      bankAccountId, bankId, accountId, start,
      period: { from: dates[0], to: dates[dates.length - 1] },
      totals: {
        lines: items.length, reconciled: items.filter((i) => i.status === 'conciliado').length, suggested: items.filter((i) => i.status === 'sugerido').length,
        unmatched: items.filter((i) => i.status === 'sem_par').length, beforeStart: items.filter((i) => i.status === 'antes_inicio').length,
      },
      balance: { date: checkDate, statement: ledger?.amount ?? null, system: rows[0]?.balance ?? 0, opening: rows[0]?.opening ?? 0 },
      items,
    };
  }

  /**
   * Aplica as escolhas da conciliação. Ações por linha: `baixar` (conta em
   * aberto vira paga/recebida na data do extrato), `vincular` (já estava
   * baixada, só marca como conciliada), `criar` (saída sem par vira conta a
   * pagar já paga), `transferir` (movimento entre contas) e `ignorar`.
   */
  async apply(actor: PayableActor, body: Body) {
    const bankAccountId = Number(body.bankAccountId);
    if (!bankAccountId) fail('Escolha a conta bancária do extrato');
    await assertClassification(this.prisma, actor.companyId, { bankAccountId });
    const items: Body[] = Array.isArray(body.items) ? body.items : [];
    if (!items.length) fail('Nada para conciliar');
    const { accounts } = await this.balance.accounts(actor.companyId, [bankAccountId]);
    const start = accounts[0]?.start ?? null;
    const done: Array<{ fitId: string; action: string; id?: number }> = [];
    const errors: Array<{ fitId: string; reason: string }> = [];
    for (const item of items) {
      const fitId = String(item.fitId ?? '').slice(0, 60);
      const action = String(item.action ?? 'ignorar');
      if (!fitId || action === 'ignorar') continue;
      const ref = this.ref(bankAccountId, fitId);
      const date = String(item.date ?? '').slice(0, 10);
      const amount = Number(item.amount);
      try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount === 0) fail('Linha do extrato inválida');
        if (start && date < start && action !== 'vincular') fail('Linha anterior à data inicial da conta: já está no saldo inicial');
        const value = round(Math.abs(amount));
        const already = await this.prisma.financial_Payable.count({ where: { companyId: actor.companyId, statementRef: ref } })
          + await this.prisma.financialRecords.count({ where: { companyId: actor.companyId, statementRef: ref } })
          + await this.prisma.financial_Transfer.count({ where: { companyId: actor.companyId, statementRef: ref, inactiveAt: null } });
        if (already) fail('Linha já conciliada');
        const paidAt = date > todayBr() ? todayBr() : date;
        if (action === 'baixar' && item.type === 'payable') {
          await this.payables.settle(Number(item.targetId), { paidAt, paidValue: value, bankAccountId, paymentMethod: item.paymentMethod }, actor, null, ref);
          done.push({ fitId, action, id: Number(item.targetId) });
        } else if (action === 'baixar' && item.type === 'receivable') {
          await this.receivables.settle(Number(item.targetId), { paidAt, receivedValue: value, bankAccountId }, actor, null, ref);
          done.push({ fitId, action, id: Number(item.targetId) });
        } else if (action === 'vincular') {
          const model = item.type === 'receivable' ? this.prisma.financialRecords : this.prisma.financial_Payable;
          const { count } = await (model as typeof this.prisma.financial_Payable).updateMany({ where: { id: Number(item.targetId), companyId: actor.companyId, statementRef: null }, data: { statementRef: ref } });
          if (!count) fail('Conta não encontrada ou já conciliada');
          done.push({ fitId, action, id: Number(item.targetId) });
        } else if (action === 'criar') {
          if (amount > 0) {
            // entrada sem par (rendimento, estorno, depósito): conta a receber já recebida
            await assertClassification(this.prisma, actor.companyId, { chartAccountId: item.chartAccountId || null, costCenterId: item.costCenterId || null });
            if (item.customerId && !(await this.prisma.customer.count({ where: { id: Number(item.customerId), companyId: actor.companyId } }))) fail('Cliente não encontrado');
            const noon = new Date(`${paidAt}T12:00:00.000Z`);
            const record = await this.prisma.financialRecords.create({
              data: {
                companyId: actor.companyId, gateway: 'manual', status: 'received', paymentMethod: 'transferencia',
                description: String(item.description || item.memo || 'Entrada do extrato').slice(0, 255),
                value, receivedValue: value, dueDate: noon, paidAt: noon, accrualDate: paidAt.slice(0, 7),
                chartAccountId: item.chartAccountId ? Number(item.chartAccountId) : null, costCenterId: item.costCenterId ? Number(item.costCenterId) : null,
                customerId: item.customerId ? Number(item.customerId) : null,
                bankAccountId, statementRef: ref, settledByUserId: actor.userId || null,
              },
            });
            done.push({ fitId, action, id: record.id });
            continue;
          }
          const created = await this.prisma.$transaction(async (tx) => {
            const data = await normalizePayable(tx, actor.companyId, {
              description: String(item.description || item.memo || 'Saída do extrato').slice(0, 255), value, dueDate: date,
              supplierId: item.supplierId, chartAccountId: item.chartAccountId, costCenterId: item.costCenterId, paymentMethod: item.paymentMethod,
            }, null, fail);
            return tx.financial_Payable.create({ data: { ...data, companyId: actor.companyId, status: 'aberta', origin: 'manual', createdByUserId: actor.userId || null } as Prisma.Financial_PayableUncheckedCreateInput });
          });
          await this.payables.settle(created.id, { paidAt, paidValue: value, bankAccountId, paymentMethod: item.paymentMethod }, actor, null, ref);
          done.push({ fitId, action, id: created.id });
        } else if (action === 'transferir') {
          const other = Number(item.otherBankAccountId);
          const transfer = await this.createTransfer(actor, {
            fromBankAccountId: amount < 0 ? bankAccountId : other, toBankAccountId: amount < 0 ? other : bankAccountId, value, date: paidAt, description: item.memo,
          }, ref);
          done.push({ fitId, action, id: transfer.id });
        } else {
          fail('Ação desconhecida');
        }
      } catch (error) {
        errors.push({ fitId, reason: (error as Error).message });
      }
    }
    return { applied: done.length, done, errors };
  }
}
