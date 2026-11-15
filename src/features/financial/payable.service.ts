import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { recordFlowEvent } from 'src/common/flow/flow';
import { PrismaService } from 'src/prisma/prisma.service';
import { assertClassification } from './classification';
import { PAYABLE_METHODS, normalizePayable, payableDay, payableMoney } from './payable.rules';

export interface PayableActor { userId: number; companyId: number }
type Body = Record<string, any>;

const FLOW_ENTITY = 'financial_payable';
const MAX_INSTALLMENTS = 60;
const fail = (message: string): never => { throw new BadRequestException(message); };
const blank = (value: unknown) => value === undefined || value === null || value === '';
const round = (value: number) => Math.round(value * 100) / 100;

/** Hoje no fuso de Brasília (AAAA-MM-DD). */
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

/** Mesmo dia nos meses seguintes; dia 31 em mês curto cai no último dia. */
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear(), month = date.getUTCMonth() + months, day = date.getUTCDate();
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last), 12));
}

@Injectable()
export class PayableService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lança várias parcelas de uma vez, uma por mês a partir do primeiro
   * vencimento. `mode: dividir` reparte o valor total (os centavos que sobram
   * vão para a última); `repetir` lança o mesmo valor todo mês (despesa fixa).
   */
  async createInstallments(actor: PayableActor, body: Body) {
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 2 || count > MAX_INSTALLMENTS) fail(`Informe de 2 a ${MAX_INSTALLMENTS} parcelas`);
    const mode = body.mode === 'repetir' ? 'repetir' : 'dividir';
    const { count: _count, mode: _mode, accrualDate: _accrual, installmentNumber: _n, installmentTotal: _t, ...input } = body;

    return this.prisma.$transaction(async (tx) => {
      const base = await normalizePayable(tx, actor.companyId, input, null, (message) => fail(message));
      const total = Math.round(Number(base.value) * 100);
      const share = Math.floor(total / count);
      const groupKey = randomUUID();
      const rows: Array<{ id: number }> = [];
      for (let i = 0; i < count; i++) {
        const dueDate = addMonths(base.dueDate, i);
        const cents = mode === 'repetir' ? total : i === count - 1 ? total - share * (count - 1) : share;
        if (cents <= 0) fail('O valor é pequeno demais para esse número de parcelas');
        rows.push(await tx.financial_Payable.create({
          data: {
            ...(base as any), companyId: actor.companyId, value: cents / 100, dueDate, accrualDate: dueDate.toISOString().slice(0, 7),
            installmentNumber: i + 1, installmentTotal: count, groupKey, status: 'aberta', origin: 'manual', createdByUserId: actor.userId || null,
          },
          select: { id: true },
        }));
      }
      return { groupKey, count, ids: rows.map((row) => row.id) };
    });
  }

  private async owned(id: number, companyId: number) {
    const payable = await this.prisma.financial_Payable.findFirst({ where: { id, companyId } });
    if (!payable) throw new NotFoundException('Conta a pagar não encontrada');
    return payable;
  }

  /** Baixa: o pagamento saiu. Guarda data, valor pago, conta de saída e, se vier, o comprovante. */
  async settle(id: number, body: Body, actor: PayableActor, receiptUrl?: string | null) {
    const payable = await this.owned(id, actor.companyId);
    if (payable.inactiveAt) throw new ConflictException('Conta excluída: restaure antes de dar baixa');
    if (payable.status !== 'aberta') throw new ConflictException('Esta conta já está paga');

    const paidAt = blank(body.paidAt) ? payableDay(today(), 'Data do pagamento', 'paidAt', fail) : payableDay(body.paidAt, 'Data do pagamento', 'paidAt', fail);
    if (paidAt.toISOString().slice(0, 10) > today()) fail('A data do pagamento não pode ser futura');
    const paidValue = blank(body.paidValue) ? Number(payable.value) : payableMoney(body.paidValue, 'Valor pago', 'paidValue', fail);
    if (!blank(body.paymentMethod) && !PAYABLE_METHODS.includes(String(body.paymentMethod))) fail('Forma de pagamento inválida');
    let bankAccountId: number | null = null;
    if (!blank(body.bankAccountId)) {
      await assertClassification(this.prisma, actor.companyId, { bankAccountId: body.bankAccountId });
      bankAccountId = Number(body.bankAccountId);
    }
    const note = String(body.observations ?? '').trim().slice(0, 500);

    return this.prisma.$transaction(async (tx) => {
      // só baixa se ainda estiver aberta: dois cliques não pagam duas vezes
      const changed = await tx.financial_Payable.updateMany({
        where: { id, companyId: actor.companyId, status: 'aberta' },
        data: {
          status: 'paga', paidAt, paidValue: round(paidValue), bankAccountId, settledByUserId: actor.userId || null,
          ...(blank(body.paymentMethod) ? {} : { paymentMethod: String(body.paymentMethod) }),
          ...(note ? { observations: note } : {}),
          ...(receiptUrl ? { receiptUrl } : {}),
        },
      });
      if (changed.count === 0) throw new ConflictException('Esta conta já está paga');
      await recordFlowEvent(tx, FLOW_ENTITY, { companyId: actor.companyId, entityId: id, type: 'baixa', from: 'aberta', to: 'paga', userId: actor.userId });
      return tx.financial_Payable.findUnique({ where: { id } });
    });
  }

  /** Estorno da baixa: volta a ficar aberta. O comprovante anexado continua guardado. */
  async unsettle(id: number, body: Body, actor: PayableActor) {
    const payable = await this.owned(id, actor.companyId);
    if (payable.status !== 'paga') throw new ConflictException('Esta conta não está paga');
    return this.prisma.$transaction(async (tx) => {
      await tx.financial_Payable.update({ where: { id }, data: { status: 'aberta', paidAt: null, paidValue: null, bankAccountId: null, settledByUserId: null } });
      await recordFlowEvent(tx, FLOW_ENTITY, {
        companyId: actor.companyId, entityId: id, type: 'estorno', from: 'paga', to: 'aberta', userId: actor.userId, note: String(body?.reason ?? '').trim() || null,
      });
      return tx.financial_Payable.findUnique({ where: { id } });
    });
  }

  /**
   * Resumo para o topo da tela. O que está em aberto conta sempre (atrasada não
   * some porque o mês virou); o pago é o que saiu no mês pedido, ou tudo.
   */
  async summary(companyId: number, month?: string) {
    if (month && !/^\d{4}-\d{2}$/.test(month)) fail('Mês deve estar no formato AAAA-MM');
    const start = new Date(`${today()}T00:00:00.000Z`);
    const day = 24 * 3600 * 1000;
    const tomorrow = new Date(start.getTime() + day), week = new Date(start.getTime() + 8 * day);
    const open = { companyId, inactiveAt: null, status: 'aberta' };
    const sum = async (where: Record<string, unknown>, field: 'value' | 'paidValue' = 'value') => {
      const result = await this.prisma.financial_Payable.aggregate({ where, _count: { _all: true }, _sum: { [field]: true } as any });
      return { count: result._count._all, total: round(Number((result._sum as any)?.[field] ?? 0)) };
    };
    const [overdue, dueToday, dueWeek, later, paid] = await Promise.all([
      sum({ ...open, dueDate: { lt: start } }),
      sum({ ...open, dueDate: { gte: start, lt: tomorrow } }),
      sum({ ...open, dueDate: { gte: tomorrow, lt: week } }),
      sum({ ...open, dueDate: { gte: week } }),
      sum({ companyId, inactiveAt: null, status: 'paga', ...(month ? { paidAt: { gte: new Date(`${month}-01T00:00:00.000Z`), lt: addMonths(new Date(`${month}-01T00:00:00.000Z`), 1) } } : {}) }, 'paidValue'),
    ]);
    return { today: today(), overdue, dueToday, dueWeek, later, paid };
  }
}
