import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Carteira de comissões do vendedor.
 *
 * Vendedor é só um usuário marcado como vendedor: nada de subconta em gateway.
 * Toda comissão — de treinamento (cupom) ou de serviço (contrato) — nasce de uma
 * CONTA A RECEBER que tem vendedor e valor de comissão, e vira um lançamento aqui:
 *
 *   conta a receber criada   → comissão PREVISTA
 *   cliente pagou            → comissão LIBERADA (entra no saldo a pagar)
 *   baixa estornada          → volta a prevista
 *   cancelada / inativada    → comissão CANCELADA
 *
 * O pagamento ao vendedor é feito por fora e lançado aqui como baixa. O saldo
 * nunca é guardado: é sempre a soma dos lançamentos.
 */

type Body = Record<string, any>;
type Tx = Prisma.TransactionClient | PrismaService;
export interface WalletActor { companyId: number; userId: number }

export const WALLET_ORIGINS = ['treinamento', 'servico', 'manual'] as const;
export type WalletOrigin = (typeof WALLET_ORIGINS)[number];
const PAYMENT_METHODS = ['pix', 'transferencia', 'dinheiro', 'outro'];

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const num = (value: unknown) => Number(value ?? 0) || 0;
const clean = (value: unknown, max: number) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Data só com dia vira meio-dia UTC, para não cair no dia anterior no fuso do Brasil. */
const dayOf = (value: unknown, label: string): Date => {
  if (blank(value)) return new Date();
  const text = String(value).slice(0, 10);
  const date = new Date(`${text}T12:00:00.000Z`);
  if (!DATE.test(text) || Number.isNaN(date.getTime())) throw new BadRequestException(`${label}: data inválida`);
  if (date.getTime() > Date.now() + 36e5 * 24) throw new BadRequestException(`${label} não pode ser futura`);
  return date;
};
const money = (value: unknown, label: string): number => {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/\./g, '').replace(',', '.'));
  const parsed = typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value ?? '')) ? Number(value) : n;
  if (!Number.isFinite(parsed)) throw new BadRequestException(`${label}: informe um valor`);
  return round2(parsed);
};

/** Situação da comissão a partir da conta a receber. */
function commissionStatus(record: { status: string; inactiveAt: Date | null }): 'prevista' | 'liberada' | 'cancelada' {
  if (record.inactiveAt || ['cancelled', 'declined', 'chargeback'].includes(record.status)) return 'cancelada';
  return record.status === 'received' ? 'liberada' : 'prevista';
}

const RECORD_SELECT = {
  id: true, companyId: true, sellerId: true, commissionValue: true, commissionPercentage: true, value: true, status: true,
  inactiveAt: true, paidAt: true, createdAt: true, description: true, couponId: true, subscriptionId: true,
  contractId: true, contractInstallmentId: true, installmentNumber: true, installmentTotal: true,
} satisfies Prisma.FinancialRecordsSelect;
type RecordRow = Prisma.FinancialRecordsGetPayload<{ select: typeof RECORD_SELECT }>;
const RECORD_FIELDS = Object.keys(RECORD_SELECT) as Array<keyof RecordRow>;

@Injectable()
export class SellerWalletService {
  private readonly logger = new Logger(SellerWalletService.name);
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ carteira

  /** Carteira do usuário; cria se ainda não existe (e marca o usuário como vendedor). */
  async ensureWallet(companyId: number, userId: number, tx: Tx = this.prisma) {
    const existing = await tx.commercial_SellerWallet.findUnique({ where: { userId } });
    if (existing) return existing;
    const user = await tx.user.findFirst({ where: { id: userId, companyId }, select: { id: true, isSeller: true } });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    if (!user.isSeller) await tx.user.update({ where: { id: userId }, data: { isSeller: true, sellerStatus: 'ACTIVE', sellerActivatedAt: new Date() } });
    return this.createWallet(companyId, userId, tx);
  }

  /**
   * Só cria a carteira, sem tocar no usuário. É o que o cadastro de usuário chama de dentro
   * da própria transação (alterar o usuário dali, por outra conexão, travaria nele mesmo).
   */
  createWallet(companyId: number, userId: number, tx: Tx = this.prisma) {
    // duas chamadas ao mesmo tempo: a segunda encontra a carteira criada pela primeira
    return tx.commercial_SellerWallet.upsert({ where: { userId }, update: {}, create: { companyId, userId } });
  }

  // ------------------------------------------------------------------ comissão

  /**
   * Deixa o lançamento de comissão de UMA conta a receber igual ao que ela diz hoje.
   * Idempotente: pode ser chamada quantas vezes for, em qualquer ordem.
   */
  async syncRecord(financialRecordId: number, tx: Tx = this.prisma, fresh?: Record<string, unknown>): Promise<void> {
    const stored = await tx.financialRecords.findUnique({ where: { id: financialRecordId }, select: RECORD_SELECT });
    // `fresh` é a linha como acabou de ser gravada por quem chama de dentro de uma transação
    // ainda aberta (o cadastro de contas a receber): por outra conexão só se vê o estado antigo.
    const record = (fresh ? { ...(stored ?? {}), ...Object.fromEntries(RECORD_FIELDS.filter((key) => key in fresh).map((key) => [key, fresh[key]])) } : stored) as RecordRow | null;
    const entry = await tx.commercial_SellerWalletEntry.findUnique({ where: { financialRecordId } });
    const amount = round2(num(record?.commissionValue));
    if (!record || !record.sellerId || amount <= 0) {
      // deixou de ter vendedor ou comissão: o lançamento que existia é cancelado, nunca apagado
      if (entry && entry.status !== 'cancelada') await tx.commercial_SellerWalletEntry.update({ where: { id: entry.id }, data: { status: 'cancelada', releasedAt: null } });
      return;
    }
    const wallet = await this.ensureWallet(record.companyId, record.sellerId, tx);
    const status = commissionStatus(record);
    const [coupon, subscription] = await Promise.all([
      record.couponId ? tx.coupon.findUnique({ where: { id: record.couponId }, select: { code: true } }) : null,
      record.subscriptionId ? tx.courseClassSubscription.findUnique({ where: { id: record.subscriptionId }, select: { classId: true, class: { select: { name: true } } } }) : null,
    ]);
    const origin: WalletOrigin = record.contractId ? 'servico' : record.subscriptionId || record.couponId ? 'treinamento' : 'manual';
    let contract: { number: string; title: string; proposalId: number } | null = null;
    if (record.contractId) contract = await tx.commercial_Contract.findUnique({ where: { id: record.contractId }, select: { number: true, title: true, proposalId: true } });
    const parcel = num(record.installmentTotal) > 1 ? ` · parcela ${record.installmentNumber}/${record.installmentTotal}` : '';
    const description = (origin === 'servico'
      ? `Comissão de serviço — ${contract?.number ?? 'contrato'}${parcel}${contract?.title ? ` · ${contract.title}` : ''}`
      : origin === 'treinamento'
        ? `Comissão de treinamento${coupon?.code ? ` — cupom ${coupon.code}` : ''}${subscription?.class?.name ? ` · ${subscription.class.name}` : ''}`
        : `Comissão — ${record.description || `conta a receber ${record.id}`}`).slice(0, 255);
    const data = {
      companyId: record.companyId, walletId: wallet.id, sellerId: record.sellerId, type: 'comissao', origin, status, amount,
      baseValue: record.value === null ? null : round2(num(record.value)),
      rate: record.commissionPercentage === null ? null : num(record.commissionPercentage),
      description, couponId: record.couponId, subscriptionId: record.subscriptionId, classId: subscription?.classId ?? null,
      contractId: record.contractId, contractInstallmentId: record.contractInstallmentId, proposalId: contract?.proposalId ?? null,
      releasedAt: status === 'liberada' ? entry?.releasedAt ?? record.paidAt ?? new Date() : null,
    };
    if (entry) await tx.commercial_SellerWalletEntry.update({ where: { id: entry.id }, data });
    else {
      await tx.commercial_SellerWalletEntry.upsert({
        where: { financialRecordId }, update: data, create: { ...data, financialRecordId, occurredAt: record.createdAt ?? new Date() },
      });
    }
  }

  /** Para os caminhos de venda e de webhook: a venda nunca falha por causa da carteira. */
  async syncRecordSafe(financialRecordId: number | null | undefined, fresh?: Record<string, unknown>): Promise<void> {
    if (!financialRecordId) return;
    try {
      await this.syncRecord(Number(financialRecordId), this.prisma, fresh);
    } catch (error) {
      this.logger.error(`Carteira: falha ao sincronizar a comissão da conta a receber ${financialRecordId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Rede de segurança: confere as contas a receber com comissão contra os lançamentos e
   * acerta o que estiver diferente (uma baixa feita por um caminho que não avisou a carteira).
   */
  async reconcile(companyId: number, sellerId?: number): Promise<number> {
    const [records, entries] = await Promise.all([
      this.prisma.financialRecords.findMany({
        where: { companyId, sellerId: sellerId ?? { not: null }, commissionValue: { gt: 0 } },
        select: { id: true, sellerId: true, status: true, inactiveAt: true, commissionValue: true },
      }),
      this.prisma.commercial_SellerWalletEntry.findMany({
        where: { companyId, type: 'comissao', financialRecordId: { not: null }, ...(sellerId ? { sellerId } : {}) },
        select: { financialRecordId: true, sellerId: true, status: true, amount: true },
      }),
    ]);
    const byRecord = new Map(entries.map((entry) => [entry.financialRecordId!, entry]));
    const stale = new Set<number>();
    for (const record of records) {
      const entry = byRecord.get(record.id);
      byRecord.delete(record.id);
      if (!entry || entry.sellerId !== record.sellerId || entry.status !== commissionStatus(record) || Math.abs(num(entry.amount) - num(record.commissionValue)) > 0.005) stale.add(record.id);
    }
    // lançamento vivo cuja conta a receber perdeu o vendedor ou a comissão
    for (const [recordId, entry] of byRecord) if (entry.status !== 'cancelada') stale.add(recordId);
    for (const id of stale) await this.syncRecordSafe(id);
    return stale.size;
  }

  // ------------------------------------------------------------------ leitura

  private async totals(companyId: number, sellerIds?: number[]) {
    const rows = await this.prisma.commercial_SellerWalletEntry.groupBy({
      by: ['sellerId', 'type', 'status', 'origin'],
      where: { companyId, ...(sellerIds ? { sellerId: { in: sellerIds } } : {}) },
      _sum: { amount: true }, _count: { _all: true }, _max: { occurredAt: true },
    });
    const empty = () => ({
      balance: 0, pending: 0, paid: 0, generated: 0, adjustments: 0, sales: 0, lastMovementAt: null as Date | null,
      byOrigin: { treinamento: { generated: 0, pending: 0, sales: 0 }, servico: { generated: 0, pending: 0, sales: 0 }, manual: { generated: 0, pending: 0, sales: 0 } },
    });
    const by = new Map<number, ReturnType<typeof empty>>();
    for (const row of rows) {
      const total = by.get(row.sellerId) ?? empty();
      by.set(row.sellerId, total);
      const sum = num(row._sum.amount);
      const origin = (WALLET_ORIGINS as readonly string[]).includes(row.origin) ? (row.origin as WalletOrigin) : 'manual';
      if (row.status !== 'cancelada' && row.status !== 'estornado' && row._max.occurredAt && (!total.lastMovementAt || row._max.occurredAt > total.lastMovementAt)) total.lastMovementAt = row._max.occurredAt;
      if (row.type === 'comissao') {
        if (row.status === 'liberada') { total.balance += sum; total.generated += sum; total.sales += row._count._all; total.byOrigin[origin].generated += sum; total.byOrigin[origin].sales += row._count._all; }
        if (row.status === 'prevista') { total.pending += sum; total.byOrigin[origin].pending += sum; }
      } else if (row.status === 'efetivado') {
        total.balance += sum;
        if (row.type === 'pagamento') total.paid += -sum; else total.adjustments += sum;
      }
    }
    for (const total of by.values()) {
      for (const key of ['balance', 'pending', 'paid', 'generated', 'adjustments'] as const) total[key] = round2(total[key]);
      for (const origin of WALLET_ORIGINS) { total.byOrigin[origin].generated = round2(total.byOrigin[origin].generated); total.byOrigin[origin].pending = round2(total.byOrigin[origin].pending); }
    }
    return { by, empty };
  }

  /** Vendedores da empresa com os números da carteira de cada um. */
  async list(companyId: number, query: Body = {}) {
    await this.reconcile(companyId);
    const search = clean(query.search, 80);
    const sellers = await this.prisma.user.findMany({
      where: {
        companyId, isSeller: true,
        ...(query.inactive === 'true' ? {} : { inactiveAt: null }),
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } : {}),
      },
      select: { id: true, name: true, email: true, phone: true, imageUrl: true, inactiveAt: true, sellerActivatedAt: true },
      orderBy: { name: 'asc' },
    });
    const { by, empty } = await this.totals(companyId, sellers.map((seller) => seller.id));
    const rows = sellers.map((seller) => ({ ...seller, wallet: by.get(seller.id) ?? empty() }));
    const sum = (key: 'balance' | 'pending' | 'paid' | 'generated') => round2(rows.reduce((total, row) => total + row.wallet[key], 0));
    return { rows, summary: { sellers: rows.length, balance: sum('balance'), pending: sum('pending'), paid: sum('paid'), generated: sum('generated') } };
  }

  private async sellerOf(companyId: number, userId: number) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, companyId },
      select: { id: true, name: true, email: true, phone: true, imageUrl: true, isSeller: true, inactiveAt: true, sellerActivatedAt: true },
    });
    if (!user) throw new NotFoundException('Vendedor não encontrado');
    const wallet = await this.prisma.commercial_SellerWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Este usuário não tem carteira de vendedor');
    return { user, wallet };
  }

  /** A carteira de um vendedor: saldo, o que vem por aí, o que já foi pago e a evolução por mês. */
  async detail(companyId: number, userId: number) {
    const { user, wallet } = await this.sellerOf(companyId, userId);
    await this.reconcile(companyId, userId);
    const { by, empty } = await this.totals(companyId, [userId]);
    const totals = by.get(userId) ?? empty();
    const since = new Date();
    since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0); since.setUTCMonth(since.getUTCMonth() - 11);
    const recent = await this.prisma.commercial_SellerWalletEntry.findMany({
      where: { walletId: wallet.id, OR: [{ type: 'comissao', status: 'liberada', releasedAt: { gte: since } }, { type: 'pagamento', status: 'efetivado', occurredAt: { gte: since } }] },
      select: { type: true, amount: true, releasedAt: true, occurredAt: true },
    });
    const months = Array.from({ length: 12 }, (_, index) => {
      const date = new Date(since); date.setUTCMonth(since.getUTCMonth() + index);
      return { month: date.toISOString().slice(0, 7), generated: 0, paid: 0 };
    });
    const slot = new Map(months.map((month) => [month.month, month]));
    for (const entry of recent) {
      const month = slot.get((entry.type === 'comissao' ? entry.releasedAt! : entry.occurredAt).toISOString().slice(0, 7));
      if (!month) continue;
      if (entry.type === 'comissao') month.generated = round2(month.generated + num(entry.amount)); else month.paid = round2(month.paid - num(entry.amount));
    }
    const lastPayment = await this.prisma.commercial_SellerWalletEntry.findFirst({
      where: { walletId: wallet.id, type: 'pagamento', status: 'efetivado' }, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true, amount: true },
    });
    return {
      seller: user, walletId: wallet.id, createdAt: wallet.createdAt, ...totals,
      averageCommission: totals.sales ? round2(totals.generated / totals.sales) : 0,
      lastPayment: lastPayment ? { at: lastPayment.occurredAt, amount: round2(-num(lastPayment.amount)) } : null,
      months,
    };
  }

  /** Histórico da carteira, do mais novo para o mais antigo. */
  async entries(companyId: number, userId: number, query: Body = {}) {
    const { wallet } = await this.sellerOf(companyId, userId);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const page = Math.max(0, Number(query.page) || 0);
    const where: Prisma.Commercial_SellerWalletEntryWhereInput = {
      walletId: wallet.id,
      ...(['comissao', 'pagamento', 'ajuste'].includes(query.type) ? { type: query.type } : {}),
      ...((WALLET_ORIGINS as readonly string[]).includes(query.origin) ? { origin: query.origin } : {}),
      ...(['prevista', 'liberada', 'cancelada', 'efetivado', 'estornado'].includes(query.status) ? { status: query.status } : {}),
      ...(DATE.test(String(query.from ?? '')) || DATE.test(String(query.to ?? '')) ? { occurredAt: {
        ...(DATE.test(String(query.from ?? '')) ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
        ...(DATE.test(String(query.to ?? '')) ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
      } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.commercial_SellerWalletEntry.count({ where }),
      this.prisma.commercial_SellerWalletEntry.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], skip: page * limit, take: limit }),
    ]);
    // nomes para a tela: conta bancária de saída, quem lançou, contrato e turma (para os links)
    const ids = <K extends 'bankAccountId' | 'createdByUserId' | 'contractId' | 'classId'>(key: K) => [...new Set(rows.map((row) => row[key]).filter((id): id is number => typeof id === 'number'))];
    const [accounts, users, contracts, classes] = await Promise.all([
      ids('bankAccountId').length ? this.prisma.financial_BankAccount.findMany({ where: { id: { in: ids('bankAccountId') }, companyId }, select: { id: true, name: true } }) : [],
      ids('createdByUserId').length ? this.prisma.user.findMany({ where: { id: { in: ids('createdByUserId') }, companyId }, select: { id: true, name: true } }) : [],
      ids('contractId').length ? this.prisma.commercial_Contract.findMany({ where: { id: { in: ids('contractId') }, companyId }, select: { id: true, number: true } }) : [],
      ids('classId').length ? this.prisma.courseClass.findMany({ where: { id: { in: ids('classId') }, companyId }, select: { id: true, name: true } }) : [],
    ]);
    const index = <T extends { id: number }>(list: T[]) => new Map<number, T>(list.map((item) => [item.id, item]));
    const account = index(accounts as Array<{ id: number; name: string }>), author = index(users as Array<{ id: number; name: string }>);
    const contract = index(contracts as Array<{ id: number; number: string }>), klass = index(classes as Array<{ id: number; name: string }>);
    return {
      total, page, limit,
      rows: rows.map((row) => ({
        id: row.id, type: row.type, origin: row.origin, status: row.status, amount: num(row.amount),
        baseValue: row.baseValue === null ? null : num(row.baseValue), rate: row.rate === null ? null : num(row.rate),
        description: row.description, occurredAt: row.occurredAt, releasedAt: row.releasedAt,
        financialRecordId: row.financialRecordId, contract: row.contractId ? contract.get(row.contractId) ?? null : null,
        courseClass: row.classId ? klass.get(row.classId) ?? null : null,
        paymentMethod: row.paymentMethod, bankAccount: row.bankAccountId ? account.get(row.bankAccountId) ?? null : null, note: row.note,
        createdBy: row.createdByUserId ? author.get(row.createdByUserId)?.name ?? null : null,
        reversedAt: row.reversedAt, reverseReason: row.reverseReason,
      })),
    };
  }

  // ------------------------------------------------------------------ pagamento e ajuste

  private async balanceOf(companyId: number, userId: number) {
    const { by } = await this.totals(companyId, [userId]);
    return by.get(userId)?.balance ?? 0;
  }

  /** Baixa: o vendedor foi pago por fora e o pagamento é lançado na carteira. */
  async pay(actor: WalletActor, userId: number, body: Body) {
    const { wallet } = await this.sellerOf(actor.companyId, userId);
    await this.reconcile(actor.companyId, userId);
    const amount = money(body.amount, 'Valor pago');
    if (amount <= 0) throw new BadRequestException('O valor pago deve ser maior que zero');
    const balance = await this.balanceOf(actor.companyId, userId);
    // pagar acima do saldo é adiantamento: só com confirmação explícita
    if (amount > balance + 0.005 && body.allowAdvance !== true && body.allowAdvance !== 'true') {
      throw new ConflictException(`O valor é maior que o saldo a pagar (${balance.toFixed(2).replace('.', ',')}). Confirme para lançar como adiantamento.`);
    }
    const method = PAYMENT_METHODS.includes(body.paymentMethod) ? String(body.paymentMethod) : 'pix';
    let bankAccountId: number | null = null;
    if (!blank(body.bankAccountId)) {
      const account = await this.prisma.financial_BankAccount.findFirst({ where: { id: Number(body.bankAccountId), companyId: actor.companyId, inactiveAt: null }, select: { id: true } });
      if (!account) throw new BadRequestException('Conta bancária não encontrada');
      bankAccountId = account.id;
    }
    const entry = await this.prisma.commercial_SellerWalletEntry.create({ data: {
      companyId: actor.companyId, walletId: wallet.id, sellerId: userId, type: 'pagamento', origin: 'manual', status: 'efetivado',
      amount: -amount, description: clean(body.description, 255) || 'Pagamento de comissões', occurredAt: dayOf(body.paidAt, 'Data do pagamento'),
      paymentMethod: method, bankAccountId, note: clean(body.note, 500) || null, createdByUserId: actor.userId || null,
    } });
    return { id: entry.id, ...(await this.detail(actor.companyId, userId)) };
  }

  /** Acerto manual: crédito (positivo) ou débito (negativo), sempre com motivo. */
  async adjust(actor: WalletActor, userId: number, body: Body) {
    const { wallet } = await this.sellerOf(actor.companyId, userId);
    const amount = money(body.amount, 'Valor do ajuste');
    if (amount === 0) throw new BadRequestException('O valor do ajuste não pode ser zero');
    const reason = clean(body.description, 255);
    if (reason.length < 3) throw new BadRequestException('Informe o motivo do ajuste');
    const origin: WalletOrigin = (WALLET_ORIGINS as readonly string[]).includes(body.origin) ? body.origin : 'manual';
    const entry = await this.prisma.commercial_SellerWalletEntry.create({ data: {
      companyId: actor.companyId, walletId: wallet.id, sellerId: userId, type: 'ajuste', origin, status: 'efetivado',
      amount, description: reason, occurredAt: dayOf(body.date, 'Data do ajuste'), note: clean(body.note, 500) || null, createdByUserId: actor.userId || null,
    } });
    return { id: entry.id, ...(await this.detail(actor.companyId, userId)) };
  }

  /** Estorno de um pagamento ou de um ajuste lançado errado. Nada é apagado. */
  async reverse(actor: WalletActor, entryId: number, body: Body) {
    const entry = await this.prisma.commercial_SellerWalletEntry.findFirst({ where: { id: entryId, companyId: actor.companyId } });
    if (!entry) throw new NotFoundException('Lançamento não encontrado');
    if (entry.type === 'comissao') throw new ConflictException('Comissão não é estornada aqui: ela acompanha a conta a receber de origem');
    if (entry.status !== 'efetivado') throw new ConflictException('Este lançamento já foi estornado');
    const reason = clean(body.reason, 255);
    if (reason.length < 3) throw new BadRequestException('Informe o motivo do estorno');
    await this.prisma.commercial_SellerWalletEntry.update({ where: { id: entryId }, data: { status: 'estornado', reversedAt: new Date(), reversedByUserId: actor.userId || null, reverseReason: reason } });
    return this.detail(actor.companyId, entry.sellerId);
  }

  // ------------------------------------------------------------------ vendedor

  /** Usuários ativos que ainda não são vendedores (para o "Novo vendedor"). */
  async candidates(companyId: number, query: Body = {}) {
    const search = clean(query.search, 80);
    return this.prisma.user.findMany({
      where: {
        companyId, inactiveAt: null, isSeller: false,
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } : {}),
      },
      select: { id: true, name: true, email: true, imageUrl: true }, orderBy: { name: 'asc' }, take: 10,
    });
  }

  /** Marca o usuário como vendedor e cria a carteira. Só isso. */
  async mark(actor: WalletActor, userId: number) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, companyId: actor.companyId }, select: { id: true, inactiveAt: true, sellerActivatedAt: true } });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    if (user.inactiveAt) throw new ConflictException('Usuário inativo: reative antes de marcar como vendedor');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { isSeller: true, sellerStatus: 'ACTIVE', ...(user.sellerActivatedAt ? {} : { sellerActivatedAt: new Date() }) } });
      await tx.commercial_SellerWallet.upsert({ where: { userId }, update: {}, create: { companyId: actor.companyId, userId } });
    });
    return this.detail(actor.companyId, userId);
  }

  /** Deixa de ser vendedor. A carteira e o histórico continuam guardados. */
  async unmark(actor: WalletActor, userId: number) {
    const { user } = await this.sellerOf(actor.companyId, userId);
    const balance = await this.balanceOf(actor.companyId, userId);
    await this.prisma.user.update({ where: { id: user.id }, data: { isSeller: false } });
    return { id: userId, isSeller: false, balance };
  }
}
