import { ENTITY_SELECT, entityField } from 'src/features/company-entity/entity.field';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, paymentMethods } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { assertClassification } from './classification';
import { dayStart, round, todayBr } from './ledger.filters';
import { PAYABLE_METHODS, normalizePayable, payableDay, payableMoney } from './payable.rules';

type Body = Record<string, any>;
type Tx = Prisma.TransactionClient;
export interface RecurrenceActor { userId: number; companyId: number }

/** Quantos meses à frente ficam lançados (aparecem no fluxo de caixa projetado). */
export const HORIZON_MONTHS = 12;
const ENSURE_EVERY_MS = 10 * 60 * 1000;
const OPEN_RECEIVABLE = ['waiting', 'overdue', 'processing'] as const;

const fail = (message: string): never => { throw new BadRequestException(message); };
const blank = (value: unknown) => value === undefined || value === null || value === '' || value === 'null';
const clean = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ');

/** Vencimento no mês (ano, mês 0-11), com o dia limitado ao último dia do mês. */
export function dueIn(year: number, monthIndex: number, dayOfMonth: number): Date {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(dayOfMonth, last), 12));
}

/**
 * Lançamentos recorrentes (despesa fixa a pagar ou mensalidade a receber).
 * A regra fica guardada e as ocorrências são lançadas como contas comuns,
 * sempre cobrindo os próximos 12 meses. Mudar a regra muda as ocorrências
 * em aberto daqui para a frente; encerrar remove as que ainda não venceram.
 */
@Injectable()
export class RecurrenceService {
  private readonly lastEnsure = new Map<number, number>();
  constructor(private readonly prisma: PrismaService) {}

  /** Garante as ocorrências até o horizonte. Barato: roda no máximo a cada 10 minutos por empresa. */
  async ensure(companyId: number, force = false) {
    const last = this.lastEnsure.get(companyId) ?? 0;
    if (!force && Date.now() - last < ENSURE_EVERY_MS) return;
    this.lastEnsure.set(companyId, Date.now());
    const rules = await this.prisma.financial_Recurrence.findMany({ where: { companyId, inactiveAt: null }, select: { id: true } });
    for (const rule of rules) await this.generate(rule.id);
  }

  private horizon(): Date {
    const today = todayBr();
    const [year, month] = today.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1 + HORIZON_MONTHS + 1, 0, 12));
  }

  /** Lança as ocorrências que faltam de uma regra (com trava: duas abas não duplicam). */
  private async generate(id: number, tx?: Tx): Promise<number> {
    const run = async (db: Tx) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(${812000000 + id})`;
      const rule = await db.financial_Recurrence.findUnique({ where: { id } });
      if (!rule || rule.inactiveAt) return 0;
      const horizon = this.horizon();
      const limit = rule.endDate && rule.endDate < horizon ? rule.endDate : horizon;
      let cursor = rule.generatedUntil
        ? dueIn(rule.generatedUntil.getUTCFullYear(), rule.generatedUntil.getUTCMonth() + 1, rule.dayOfMonth)
        : rule.startDate;
      let created = 0;
      let lastDue: Date | null = rule.generatedUntil;
      while (cursor <= limit && created < 120) {
        const accrualDate = cursor.toISOString().slice(0, 7);
        if (rule.kind === 'payable') {
          await db.financial_Payable.create({
            data: {
              companyId: rule.companyId, entityId: rule.entityId, description: rule.description, value: rule.value, dueDate: cursor, accrualDate,
              status: 'aberta', origin: 'manual', recurrenceId: rule.id, supplierId: rule.supplierId, chartAccountId: rule.chartAccountId,
              costCenterId: rule.costCenterId, serviceOrderId: rule.serviceOrderId, paymentMethod: rule.paymentMethod,
              observations: rule.observations, createdByUserId: rule.createdByUserId,
            },
          });
        } else {
          await db.financialRecords.create({
            data: {
              companyId: rule.companyId, entityId: rule.entityId, description: rule.description, value: rule.value, dueDate: cursor, accrualDate,
              gateway: 'manual', status: 'waiting', paymentMethod: (rule.paymentMethod ?? 'outro') as paymentMethods,
              customerId: rule.customerId, chartAccountId: rule.chartAccountId, costCenterId: rule.costCenterId,
              recurrenceId: rule.id, observations: rule.observations?.slice(0, 255) ?? null,
            },
          });
        }
        created++;
        lastDue = cursor;
        cursor = dueIn(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, rule.dayOfMonth);
      }
      if (lastDue && (!rule.generatedUntil || lastDue > rule.generatedUntil)) {
        await db.financial_Recurrence.update({ where: { id }, data: { generatedUntil: lastDue } });
      }
      return created;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  private async validate(db: Tx, companyId: number, kind: string, body: Body, existing?: Body) {
    const data: Record<string, any> = {};
    const has = (field: string) => field in body || !existing;
    if (has('description')) {
      data.description = clean(body.description).slice(0, 255);
      if (data.description.length < 2) fail('Informe a descrição');
    }
    if (has('value')) data.value = payableMoney(body.value, 'Valor', 'value', (m) => fail(m));
    if (has('paymentMethod')) {
      if (!blank(body.paymentMethod) && !PAYABLE_METHODS.includes(String(body.paymentMethod))) fail('Forma de pagamento inválida');
      data.paymentMethod = blank(body.paymentMethod) ? null : String(body.paymentMethod);
    }
    if (has('observations')) data.observations = String(body.observations ?? '').trim().slice(0, 500) || null;
    // CNPJ do grupo dos lançamentos gerados (vazio: o da OS ou o padrão)
    if ('entityId' in body) {
      const entityId = await entityField(db, companyId, body.entityId, (m) => fail(m), existing?.entityId as number | null | undefined);
      if (entityId) data.entityId = entityId;
    }
    if (has('endDate')) {
      data.endDate = blank(body.endDate) ? null : payableDay(body.endDate, 'Data final', 'endDate', (m) => fail(m));
    }
    if (kind === 'payable') {
      // mesmas regras da conta a pagar: fornecedor ativo, conta de despesa, OS da empresa
      const pick: Body = {};
      for (const field of ['supplierId', 'chartAccountId', 'costCenterId', 'serviceOrderId']) if (field in body) pick[field] = body[field];
      const normalized = await normalizePayable(db, companyId, { description: 'x'.repeat(2), value: 1, dueDate: '2026-01-01', ...pick }, existing ?? null, (m) => fail(m));
      for (const field of ['supplierId', 'chartAccountId', 'costCenterId', 'serviceOrderId']) if (field in normalized && field in body) data[field] = normalized[field];
    } else {
      if (has('customerId')) {
        const customerId = blank(body.customerId) ? null : Number(body.customerId);
        if (!customerId) fail('Informe o cliente');
        const customer = await db.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true } });
        if (!customer) fail('Cliente não encontrado');
        data.customerId = customerId;
      }
      for (const field of ['chartAccountId', 'costCenterId'] as const) if (field in body) data[field] = blank(body[field]) ? null : Number(body[field]);
      await assertClassification(db as never, companyId, { chartAccountId: data.chartAccountId, costCenterId: data.costCenterId },
        { chartAccountId: existing?.chartAccountId, costCenterId: existing?.costCenterId });
      if (data.chartAccountId && data.chartAccountId !== Number(existing?.chartAccountId ?? 0)) {
        const account = await db.financial_ChartAccount.findFirst({ where: { id: data.chartAccountId, companyId }, select: { nature: true } });
        if (account?.nature !== 'receita') fail('Conta a receber usa conta de receita');
      }
    }
    return data;
  }

  async create(actor: RecurrenceActor, body: Body) {
    const kind = body.kind === 'receivable' ? 'receivable' : 'payable';
    if (blank(body.startDate)) fail('Informe o primeiro vencimento');
    const startDate = payableDay(body.startDate, 'Primeiro vencimento', 'startDate', (m) => fail(m));
    return this.prisma.$transaction(async (tx) => {
      const data = await this.validate(tx, actor.companyId, kind, body);
      if (data.endDate && data.endDate < startDate) fail('A data final é anterior ao primeiro vencimento');
      const rule = await tx.financial_Recurrence.create({
        data: {
          ...(data as Prisma.Financial_RecurrenceUncheckedCreateInput), companyId: actor.companyId, kind, startDate,
          dayOfMonth: startDate.getUTCDate(), createdByUserId: actor.userId || null,
        },
      });
      const created = await this.generate(rule.id, tx);
      return { ...rule, created };
    });
  }

  private async owned(id: number, companyId: number) {
    const rule = await this.prisma.financial_Recurrence.findFirst({ where: { id, companyId } });
    if (!rule) throw new NotFoundException('Lançamento recorrente não encontrado');
    return rule;
  }

  /**
   * Altera a regra e as ocorrências que ainda estão em aberto a partir de hoje
   * (as vencidas e as pagas ficam como estão). Nova data final remove o que
   * passar dela.
   */
  async update(id: number, actor: RecurrenceActor, body: Body) {
    const rule = await this.owned(id, actor.companyId);
    if (rule.inactiveAt) throw new ConflictException('Lançamento recorrente encerrado');
    return this.prisma.$transaction(async (tx) => {
      const data = await this.validate(tx, actor.companyId, rule.kind, body, rule);
      if (data.endDate && data.endDate < rule.startDate) fail('A data final é anterior ao primeiro vencimento');
      const updated = await tx.financial_Recurrence.update({ where: { id }, data });
      const from = dayStart(todayBr());
      const copy: Record<string, any> = {};
      for (const field of ['description', 'value', 'chartAccountId', 'costCenterId', 'paymentMethod', 'observations', 'supplierId', 'serviceOrderId', 'customerId']) {
        if (field in data) copy[field] = data[field];
      }
      let changed = 0;
      if (rule.kind === 'payable') {
        delete copy.customerId;
        changed = (await tx.financial_Payable.updateMany({ where: { recurrenceId: id, status: 'aberta', inactiveAt: null, dueDate: { gte: from } }, data: copy })).count;
        if (updated.endDate) await tx.financial_Payable.updateMany({ where: { recurrenceId: id, status: 'aberta', inactiveAt: null, dueDate: { gt: updated.endDate } }, data: { inactiveAt: new Date() } });
      } else {
        delete copy.supplierId; delete copy.serviceOrderId;
        if ('observations' in copy) copy.observations = copy.observations?.slice(0, 255) ?? null;
        if ('paymentMethod' in copy) copy.paymentMethod = copy.paymentMethod ?? 'outro';
        changed = (await tx.financialRecords.updateMany({ where: { recurrenceId: id, status: { in: [...OPEN_RECEIVABLE] }, inactiveAt: null, dueDate: { gte: from } }, data: copy })).count;
        if (updated.endDate) await tx.financialRecords.updateMany({ where: { recurrenceId: id, status: { in: [...OPEN_RECEIVABLE] }, inactiveAt: null, dueDate: { gt: updated.endDate } }, data: { inactiveAt: new Date() } });
      }
      const created = await this.generate(id, tx);
      return { ...updated, changed, created };
    });
  }

  /** Encerra: não gera mais e remove as ocorrências em aberto depois da data (padrão: hoje). */
  async end(id: number, actor: RecurrenceActor, body: Body) {
    const rule = await this.owned(id, actor.companyId);
    if (rule.inactiveAt) throw new ConflictException('Lançamento recorrente já encerrado');
    const endDate = blank(body?.endDate) ? payableDay(todayBr(), 'Data final', 'endDate', (m) => fail(m)) : payableDay(body.endDate, 'Data final', 'endDate', (m) => fail(m));
    return this.prisma.$transaction(async (tx) => {
      let removed = 0;
      if (rule.kind === 'payable') {
        removed = (await tx.financial_Payable.updateMany({ where: { recurrenceId: id, status: 'aberta', inactiveAt: null, dueDate: { gt: endDate } }, data: { inactiveAt: new Date() } })).count;
      } else {
        removed = (await tx.financialRecords.updateMany({ where: { recurrenceId: id, status: { in: [...OPEN_RECEIVABLE] }, inactiveAt: null, dueDate: { gt: endDate } }, data: { inactiveAt: new Date() } })).count;
      }
      const updated = await tx.financial_Recurrence.update({ where: { id }, data: { endDate, inactiveAt: new Date() } });
      return { ...updated, removed };
    });
  }

  async list(companyId: number, kind?: string) {
    await this.ensure(companyId);
    const rules = await this.prisma.financial_Recurrence.findMany({
      where: { companyId, ...(kind ? { kind } : {}) }, include: { entity: ENTITY_SELECT }, orderBy: [{ inactiveAt: { sort: 'desc', nulls: 'first' } }, { description: 'asc' }],
    });
    const today = dayStart(todayBr());
    const ids = rules.map((r) => r.id);
    const [payables, receivables] = await Promise.all([
      this.prisma.financial_Payable.findMany({ where: { recurrenceId: { in: ids }, inactiveAt: null, status: 'aberta', dueDate: { gte: today } }, select: { recurrenceId: true, dueDate: true }, orderBy: { dueDate: 'asc' } }),
      this.prisma.financialRecords.findMany({ where: { recurrenceId: { in: ids }, inactiveAt: null, status: { in: [...OPEN_RECEIVABLE] }, dueDate: { gte: today } }, select: { recurrenceId: true, dueDate: true }, orderBy: { dueDate: 'asc' } }),
    ]);
    const suppliers = await this.prisma.financial_Supplier.findMany({ where: { id: { in: rules.map((r) => r.supplierId).filter(Boolean) as number[] } }, select: { id: true, name: true } });
    const customers = await this.prisma.customer.findMany({ where: { id: { in: rules.map((r) => r.customerId).filter(Boolean) as number[] } }, select: { id: true, name: true } });
    const accounts = await this.prisma.financial_ChartAccount.findMany({ where: { id: { in: rules.map((r) => r.chartAccountId).filter(Boolean) as number[] } }, select: { id: true, code: true, name: true } });
    const centers = await this.prisma.financial_CostCenter.findMany({ where: { id: { in: rules.map((r) => r.costCenterId).filter(Boolean) as number[] } }, select: { id: true, name: true } });
    return rules.map((rule) => {
      const upcoming = [...payables, ...receivables].filter((o) => o.recurrenceId === rule.id);
      return {
        ...rule, value: round(Number(rule.value)),
        supplier: suppliers.find((s) => s.id === rule.supplierId) ?? null,
        customer: customers.find((c) => c.id === rule.customerId) ?? null,
        chartAccount: accounts.find((a) => a.id === rule.chartAccountId) ?? null,
        costCenter: centers.find((c) => c.id === rule.costCenterId) ?? null,
        upcoming: upcoming.length, nextDue: upcoming[0]?.dueDate ?? null,
        // valor mensal comprometido nos próximos 12 meses
        yearTotal: round(Number(rule.value) * upcoming.length),
      };
    });
  }
}
