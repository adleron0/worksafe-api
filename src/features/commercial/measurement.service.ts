import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, financialRecordsStatus, paymentMethods } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { classificationDefaults } from 'src/features/financial/classification';
import { PendingLine, applyMeasurement, nextOpenPeriod, pendingLines, revertMeasurement, syncRentalReminders } from 'src/features/stock/rental.service';
import { SellerWalletService } from './wallet.service';
import { netWith, parseRetentions, retentionTotal, writeRetentions } from 'src/features/financial/retention.service';

/**
 * Faturamento por medição (plano 08, fases 3 e 8).
 *
 * Um boletim de medição (BM-01, BM-02… por contrato) junta o que vai numa nota
 * fiscal e vira UMA conta a receber com `contractId` e `measurementId`, com a
 * parte proporcional da comissão da proposta. A locação monta o boletim
 * sozinha (períodos vencidos + avarias/faltas + avulsas da OL); a medição de
 * obra vai montar as linhas pelas etapas e usar o mesmo `createMeasurement`.
 */

type Body = Record<string, any>;
type Tx = Prisma.TransactionClient;
export interface MeasurementActor { userId: number; companyId: number }
export interface MeasurementLine { kind: string; description: string; periodStart: string | null; periodEnd: string | null; value: number; chargeId?: number | null }

const PAID: financialRecordsStatus[] = ['received'];
const METHODS: paymentMethods[] = ['boleto', 'pix', 'transferencia', 'cartaoCredito', 'dinheiro', 'outro'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const noonUtc = (value: string) => new Date(`${value}T12:00:00.000Z`);
const addDays = (value: string, days: number) => { const d = asDate(value); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const br = (value: string | null) => (value ? value.split('-').reverse().join('/') : '');
function dateOf(value: unknown, label: string): string {
  const out = String(value ?? '').slice(0, 10);
  if (!DATE.test(out) || Number.isNaN(asDate(out).getTime()) || asDate(out).toISOString().slice(0, 10) !== out) throw new BadRequestException(`${label}: data inválida`);
  return out;
}
export const measurementLabel = (number: number) => `BM-${String(number).padStart(2, '0')}`;

/** Comissão de um valor faturado do contrato: a parte dele na comissão calculada na proposta aceita. */
export async function commissionFor(db: Tx | PrismaService, contract: { sellerId: number | null; proposalId: number; value: Prisma.Decimal | number }, value: number) {
  if (!contract.sellerId || value <= 0) return {};
  const proposal = await db.commercial_Proposal.findUnique({ where: { id: contract.proposalId }, select: { commission: true, total: true } });
  const whole = Number(proposal?.total ?? 0) > 0 ? Number(proposal!.total) : Number(contract.value);
  const commissionValue = proposal && whole > 0 ? round2((Number(proposal.commission) * value) / whole) : 0;
  return commissionValue > 0 ? { commissionValue, commissionPercentage: Math.min(999.99, round2((commissionValue / value) * 100)) } : {};
}

@Injectable()
export class MeasurementService {
  constructor(private readonly prisma: PrismaService, private readonly wallet: SellerWalletService) {}

  private async contractOf(companyId: number, id: number) {
    const row = await this.prisma.commercial_Contract.findFirst({ where: { id, companyId }, include: { customer: { select: { id: true, name: true } } } });
    if (!row) throw new NotFoundException('Contrato não encontrado');
    return row;
  }

  /** Dados da nota informados ao faturar (os mesmos da parcela). */
  invoiceOf(body: Body, value: number, suggestedDue: string, base = value) {
    const invoiceNumber = clean(body.invoiceNumber, 60);
    if (!invoiceNumber) throw new BadRequestException('Informe o número da nota fiscal');
    const invoiceDate = blank(body.invoiceIssuedAt) ? today() : dateOf(body.invoiceIssuedAt, 'Data da nota');
    if (invoiceDate > today()) throw new BadRequestException('A data da nota não pode ser futura');
    const dueDate = blank(body.dueDate) ? (suggestedDue < invoiceDate ? invoiceDate : suggestedDue) : dateOf(body.dueDate, 'Vencimento');
    const netRaw = blank(body.netValue) ? null : Number(String(body.netValue).replace(',', '.'));
    if (netRaw !== null && (!Number.isFinite(netRaw) || netRaw <= 0 || netRaw > value)) throw new BadRequestException('Valor líquido deve ficar entre zero e o valor da medição');
    const method = METHODS.includes(body.paymentMethod) ? (body.paymentMethod as paymentMethods) : 'boleto';
    // impostos retidos pelo cliente na nota (base = valor da nota)
    const retentions = parseRetentions(body.retentions, base);
    if (retentionTotal(retentions) >= value) throw new BadRequestException('As retenções não podem chegar ao valor a receber');
    return { invoiceNumber, invoiceDate, dueDate, netValue: netRaw === null ? null : round2(netRaw), method, retentions, base };
  }

  /**
   * Grava um boletim de medição e a conta a receber dele (genérico: locação e,
   * depois, obra). Valor zero (tudo coberto pela caução) não gera conta a receber.
   */
  async createMeasurement(tx: Tx, input: {
    companyId: number; userId: number | null; contract: { id: number; number: string; title: string; customerId: number; sellerId: number | null; proposalId: number; value: Prisma.Decimal | number; customerOrderNumber: string | null };
    source: 'locacao' | 'obra'; rentalId?: number | null; lines: MeasurementLine[]; invoice: ReturnType<MeasurementService['invoiceOf']> | null; description?: string;
    invoiceValue?: number | null; extra?: Partial<Prisma.Commercial_MeasurementUncheckedCreateInput>;
  }) {
    const value = round2(input.lines.reduce((s, l) => s + l.value, 0));
    if (value < -0.005) throw new ConflictException('A medição ficou negativa: a caução abatida passa do que há para faturar');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(740131::int, ${input.contract.id}::int)`;
    const last = await tx.commercial_Measurement.aggregate({ where: { contractId: input.contract.id }, _max: { number: true } });
    const number = (last._max.number ?? 0) + 1;
    const dates = input.lines.flatMap((l) => [l.periodStart, l.periodEnd]).filter((x): x is string => !!x).sort();
    const measurement = await tx.commercial_Measurement.create({ data: {
      companyId: input.companyId, contractId: input.contract.id, number, source: input.source, rentalId: input.rentalId ?? null,
      periodStart: dates.length ? asDate(dates[0]) : null, periodEnd: dates.length ? asDate(dates[dates.length - 1]) : null,
      value, invoiceValue: input.invoiceValue ?? null, lines: input.lines as unknown as Prisma.InputJsonValue, status: 'faturada', invoiceNumber: input.invoice?.invoiceNumber ?? null, createdByUserId: input.userId,
      ...(input.extra ?? {}),
    } });
    const recordId = value > 0 ? await this.createRecord(tx, { ...input, measurement, value }) : null;
    return { measurement, recordId };
  }

  /**
   * A conta a receber de um boletim: valor, nota, comissão proporcional,
   * retenções de imposto e o vínculo com o contrato e o boletim.
   */
  async createRecord(tx: Tx, input: {
    companyId: number; userId: number | null; contract: { id: number; number: string; title: string; customerId: number; sellerId: number | null; proposalId: number; value: Prisma.Decimal | number; customerOrderNumber: string | null };
    measurement: { id: number; number: number }; value: number; invoice: ReturnType<MeasurementService['invoiceOf']> | null; description?: string;
  }): Promise<number> {
    if (!input.invoice) throw new BadRequestException('Informe a nota fiscal');
    const label = `${input.contract.number} — ${measurementLabel(input.measurement.number)}`;
    const record = await tx.financialRecords.create({ data: {
      companyId: input.companyId, gateway: 'manual', status: 'waiting', paymentMethod: input.invoice.method,
      customerId: input.contract.customerId, sellerId: input.contract.sellerId, value: input.value, netValue: netWith(input.value, input.invoice.retentions, input.invoice.netValue),
      ...(await commissionFor(tx, input.contract, input.value)),
      dueDate: noonUtc(input.invoice.dueDate), accrualDate: input.invoice.invoiceDate.slice(0, 7),
      invoiceNumber: input.invoice.invoiceNumber, invoiceIssuedAt: noonUtc(input.invoice.invoiceDate),
      description: (input.description || `${label} · ${input.contract.title}`).slice(0, 255),
      observations: input.contract.customerOrderNumber ? `Pedido do cliente ${input.contract.customerOrderNumber}` : null,
      contractId: input.contract.id, measurementId: input.measurement.id,
      ...(await classificationDefaults(tx, input.companyId, 'contrato')),
    } });
    await writeRetentions(tx, { ...record, accrualDate: input.invoice.invoiceDate.slice(0, 7) }, input.invoice.retentions, input.invoice.base, input.userId);
    await tx.commercial_Measurement.update({ where: { id: input.measurement.id }, data: { financialRecordId: record.id } });
    return record.id;
  }

  // ------------------------------------------------------------------ locação

  /** OL de um contrato com o que cada uma tem para faturar agora. */
  async rentalsOf(companyId: number, contractId: number) {
    const rentals = await this.prisma.stock_Rental.findMany({ where: { companyId, contractId, inactiveAt: null }, include: { lines: true, charges: true }, orderBy: { id: 'asc' } });
    return rentals.map((r) => {
      const pending = pendingLines(r);
      return { rental: r, pending, value: round2(pending.reduce((s, l) => s + l.value, 0)), open: nextOpenPeriod(r) };
    });
  }

  /** Fatura tudo o que está pendente de uma OL do contrato: um boletim, uma nota, uma conta a receber. */
  async billRental(actor: MeasurementActor, contractId: number, body: Body) {
    const contract = await this.contractOf(actor.companyId, contractId);
    if (contract.status === 'cancelado') throw new ConflictException('Contrato cancelado: não recebe faturamento novo');
    const rentalId = Number(body.rentalId) || 0;
    const rental = await this.prisma.stock_Rental.findFirst({ where: { id: rentalId, companyId: actor.companyId, contractId, inactiveAt: null }, include: { lines: true, charges: true } });
    if (!rental) throw new NotFoundException('Ordem de locação não encontrada neste contrato');
    const lines: PendingLine[] = pendingLines(rental);
    if (!lines.length) throw new ConflictException('Nada a faturar nesta ordem de locação agora: o próximo período ainda não fechou');
    const value = round2(lines.reduce((s, l) => s + l.value, 0));
    const invoice = value > 0 ? this.invoiceOf(body, value, addDays(today(), 7)) : null;
    const created = await this.prisma.$transaction(async (tx) => {
      // trava a OL: duas pessoas faturando ao mesmo tempo não cobram o mesmo período duas vezes
      await tx.$executeRaw`SELECT id FROM "Stock_Rental" WHERE id = ${rental.id} FOR UPDATE`;
      const fresh = await tx.stock_Rental.findUniqueOrThrow({ where: { id: rental.id }, include: { lines: true, charges: true } });
      const again = pendingLines(fresh);
      if (JSON.stringify(again) !== JSON.stringify(lines)) throw new ConflictException('A ordem de locação mudou enquanto você faturava: atualize a tela');
      const out = await this.createMeasurement(tx, {
        companyId: actor.companyId, userId: actor.userId, contract, source: 'locacao', rentalId: rental.id, lines, invoice,
        description: `${contract.number} — ${rental.number}: ${lines.map((l) => l.description).join('; ')}`,
      });
      await applyMeasurement(tx, fresh, lines, out.measurement.id, out.recordId);
      await syncRentalReminders(tx, rental.id);
      return out;
    });
    if (created.recordId) await this.wallet.syncRecordSafe(created.recordId);
    return { measurementId: created.measurement.id, financialRecordId: created.recordId, number: measurementLabel(created.measurement.number), value };
  }

  /** Desfaz uma medição ainda não paga (a última da OL): a conta a receber é cancelada e os períodos voltam a pendentes. */
  async unbill(actor: MeasurementActor, contractId: number, measurementId: number) {
    await this.contractOf(actor.companyId, contractId);
    const row = await this.prisma.commercial_Measurement.findFirst({ where: { id: measurementId, contractId, companyId: actor.companyId, status: 'faturada' } });
    if (!row) throw new NotFoundException('Medição não encontrada');
    const record = row.financialRecordId ? await this.prisma.financialRecords.findUnique({ where: { id: row.financialRecordId }, select: { id: true, status: true } }) : null;
    if (record && PAID.includes(record.status)) throw new ConflictException('Esta medição já foi paga: estorne a baixa em Contas a Receber antes de desfazer');
    if (row.rentalId) {
      const later = await this.prisma.commercial_Measurement.count({ where: { rentalId: row.rentalId, status: 'faturada', number: { gt: row.number } } });
      if (later) throw new ConflictException('Desfaça antes as medições mais novas desta ordem de locação');
    }
    await this.prisma.$transaction(async (tx) => {
      if (record) await tx.financialRecords.update({ where: { id: record.id }, data: { inactiveAt: new Date(), status: 'cancelled' } });
      await tx.commercial_Measurement.update({ where: { id: row.id }, data: { status: 'cancelada' } });
      if (row.rentalId) {
        await revertMeasurement(tx, row.rentalId, row.id);
        await syncRentalReminders(tx, row.rentalId);
      }
    });
    if (record) await this.wallet.syncRecordSafe(record.id);
    return { ok: true };
  }

  /** Medição de obra do contrato: os boletins (todas as etapas), o resumo medido × faturado × saldo e a caução. */
  async worksOf(contract: { id: number; value: Prisma.Decimal | number; billingMode: string; depositRecordId: number | null }) {
    if (contract.billingMode !== 'medicao') return null;
    const rows = await this.prisma.commercial_Measurement.findMany({ where: { contractId: contract.id, source: 'obra', status: { not: 'cancelada' } }, orderBy: { number: 'asc' } });
    const ids = [...rows.map((r) => r.financialRecordId), contract.depositRecordId].filter((x): x is number => !!x);
    const records = await this.prisma.financialRecords.findMany({
      where: { id: { in: ids } }, select: { id: true, status: true, value: true, netValue: true, dueDate: true, paidAt: true, invoiceNumber: true, invoiceIssuedAt: true, invoiceUrl: true, inactiveAt: true },
    });
    const recordOf = new Map(records.map((r) => [r.id, r]));
    const billed = rows.filter((r) => r.status === 'faturada');
    const linesOf = (r: { lines: unknown }) => (r.lines as Array<{ kind: string; value: number }>) ?? [];
    const sum = (list: typeof rows, kinds: string[]) => round2(list.flatMap(linesOf).filter((l) => kinds.includes(l.kind)).reduce((acc, l) => acc + l.value, 0));
    const measured = sum(billed, ['frente']);
    const deposit = contract.depositRecordId ? recordOf.get(contract.depositRecordId) : undefined;
    return {
      measurements: rows.map((m) => {
        const record = m.financialRecordId ? recordOf.get(m.financialRecordId) : undefined;
        return {
          id: m.id, number: m.number, label: measurementLabel(m.number), status: m.status, periodStart: iso(m.periodStart), periodEnd: iso(m.periodEnd),
          value: Number(m.value), invoiceValue: Number(m.invoiceValue ?? m.value), depositValue: Number(m.depositValue ?? 0), lines: m.lines, notes: m.notes,
          publicKey: m.publicKey, sentAt: m.sentAt, decidedAt: m.decidedAt, decision: m.decision,
          record: record ? {
            id: record.id, status: record.status, dueDate: iso(record.dueDate), paidAt: record.paidAt, invoiceNumber: record.invoiceNumber, invoiceIssuedAt: iso(record.invoiceIssuedAt),
            hasInvoiceFile: Boolean(record.invoiceUrl), paid: PAID.includes(record.status), netValue: record.netValue === null ? null : Number(record.netValue),
          } : null,
        };
      }),
      summary: {
        measured, balance: round2(Number(contract.value) - measured),
        invoiced: round2(billed.reduce((acc, m) => acc + Number(m.invoiceValue ?? m.value), 0)),
        deposit: round2(billed.reduce((acc, m) => acc + Number(m.depositValue ?? 0), 0)),
        depositRecord: deposit && !deposit.inactiveAt ? { id: deposit.id, status: deposit.status, value: Number(deposit.value), dueDate: iso(deposit.dueDate), paid: PAID.includes(deposit.status) } : null,
        open: rows.find((r) => r.status !== 'faturada')?.id ?? null,
      },
    };
  }

  /** Medições do contrato (para a tela do contrato e o A Faturar). */
  async ofContract(contractId: number) {
    const rows = await this.prisma.commercial_Measurement.findMany({ where: { contractId, status: 'faturada' }, orderBy: { number: 'asc' } });
    const records = await this.prisma.financialRecords.findMany({
      where: { id: { in: rows.map((r) => r.financialRecordId).filter((x): x is number => !!x) } },
      select: { id: true, status: true, dueDate: true, paidAt: true, invoiceNumber: true, invoiceIssuedAt: true, invoiceUrl: true },
    });
    const rentals = await this.prisma.stock_Rental.findMany({ where: { id: { in: rows.map((r) => r.rentalId).filter((x): x is number => !!x) } }, select: { id: true, number: true } });
    const recordOf = new Map(records.map((r) => [r.id, r])), rentalOf = new Map(rentals.map((r) => [r.id, r.number]));
    return rows.map((m) => {
      const record = m.financialRecordId ? recordOf.get(m.financialRecordId) : undefined;
      return {
        id: m.id, number: m.number, label: measurementLabel(m.number), source: m.source, rentalId: m.rentalId, rentalNumber: m.rentalId ? rentalOf.get(m.rentalId) ?? null : null,
        periodStart: iso(m.periodStart), periodEnd: iso(m.periodEnd), value: Number(m.value), lines: m.lines as unknown as MeasurementLine[], createdAt: m.createdAt,
        record: record ? {
          id: record.id, status: record.status, dueDate: iso(record.dueDate), paidAt: record.paidAt, invoiceNumber: record.invoiceNumber,
          invoiceIssuedAt: iso(record.invoiceIssuedAt), hasInvoiceFile: Boolean(record.invoiceUrl), paid: PAID.includes(record.status),
        } : null,
        summary: `${measurementLabel(m.number)}${m.periodStart ? ` · ${br(iso(m.periodStart))} a ${br(iso(m.periodEnd))}` : ''}`,
      };
    });
  }
}
