import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Retenção de impostos na nota (plano 08, fase 9).
 *
 * O cliente desconta da nota o ISS, o INSS, o IR e o PIS/COFINS/CSLL e recolhe
 * ele mesmo. A conta a receber fica com o líquido (`netValue`) e cada imposto
 * retido vira uma linha de `Financial_Retention`. O relatório mostra, por mês
 * (competência da nota), o que já foi recolhido pelos clientes e, por isso,
 * **não pode ser pago de novo** na guia (DAS, ISS). Os alertas pegam os dois
 * furos que já deram pagamento em dobro: o cliente reteve e pagou cheio, e a
 * empresa pagou a guia de um imposto que o cliente já tinha retido.
 */

export const RETENTION_TAXES = ['iss', 'inss', 'ir', 'pis', 'cofins', 'csll'] as const;
export type RetentionTax = (typeof RETENTION_TAXES)[number];
export const TAX_LABEL: Record<RetentionTax, string> = { iss: 'ISS', inss: 'INSS', ir: 'IR', pis: 'PIS', cofins: 'COFINS', csll: 'CSLL' };

/** Guias de imposto que uma conta a pagar pode ser (`Financial_Payable.taxKind`) e os tributos que cada uma recolhe. */
export const TAX_GUIDES: Record<string, { label: string; covers: RetentionTax[] }> = {
  das: { label: 'DAS (Simples Nacional)', covers: ['iss', 'inss', 'ir', 'pis', 'cofins', 'csll'] },
  iss: { label: 'ISS', covers: ['iss'] },
  inss: { label: 'INSS (GPS/DCTFWeb)', covers: ['inss'] },
  irpj: { label: 'IRPJ', covers: ['ir'] },
  csll: { label: 'CSLL', covers: ['csll'] },
  pis: { label: 'PIS', covers: ['pis'] },
  cofins: { label: 'COFINS', covers: ['cofins'] },
};

export interface RetentionInput { tax: RetentionTax; rate: number | null; value: number }
type Tx = Prisma.TransactionClient;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const blank = (value: unknown) => value === undefined || value === null || value === '';
const num = (value: unknown) => Number(String(value).replace(',', '.'));
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const thisMonth = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 7);
const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

/**
 * Lê as retenções informadas ao faturar: `[{ tax, rate?, value? }]`, alíquota em
 * % sobre a base (o valor da nota). Valor informado vale mais que a alíquota.
 * Zero é ignorado; a soma não pode chegar ao valor da nota.
 */
export function parseRetentions(raw: unknown, base: number): RetentionInput[] {
  if (blank(raw)) return [];
  if (!Array.isArray(raw)) throw new BadRequestException('Retenções inválidas');
  const seen = new Set<string>();
  const out: RetentionInput[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    const tax = String(item?.tax ?? '').toLowerCase() as RetentionTax;
    if (!RETENTION_TAXES.includes(tax)) throw new BadRequestException(`Imposto retido inválido: ${String(item?.tax ?? '')}`);
    if (seen.has(tax)) throw new BadRequestException(`${TAX_LABEL[tax]} informado duas vezes`);
    seen.add(tax);
    const rate = blank(item.rate) ? null : num(item.rate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) throw new BadRequestException(`${TAX_LABEL[tax]}: alíquota deve ficar entre 0 e 100%`);
    const value = blank(item.value) ? (rate === null ? null : round2((base * rate) / 100)) : round2(num(item.value));
    if (value === null) throw new BadRequestException(`${TAX_LABEL[tax]}: informe a alíquota ou o valor retido`);
    if (!Number.isFinite(value) || value < 0) throw new BadRequestException(`${TAX_LABEL[tax]}: valor retido inválido`);
    if (value === 0) continue;
    out.push({ tax, rate: rate === null ? null : Math.round(rate * 1e4) / 1e4, value });
  }
  const total = round2(out.reduce((sum, r) => sum + r.value, 0));
  if (out.length && total >= base) throw new BadRequestException('As retenções não podem chegar ao valor da nota');
  return out;
}

export const retentionTotal = (list: RetentionInput[]) => round2(list.reduce((sum, r) => sum + r.value, 0));

/** Alíquotas que o cliente costuma reter (gravadas no contrato): `{ iss: 5, inss: 11 }`. */
export function ratesOf(raw: unknown): Partial<Record<RetentionTax, number>> {
  const out: Partial<Record<RetentionTax, number>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const tax of RETENTION_TAXES) {
    const value = (raw as Record<string, unknown>)[tax];
    if (blank(value)) continue;
    const n = num(value);
    if (Number.isFinite(n) && n > 0 && n <= 100) out[tax] = Math.round(n * 1e4) / 1e4;
  }
  return out;
}

/** Valida e normaliza as alíquotas padrão do contrato. */
export function parseRates(raw: unknown): Partial<Record<RetentionTax, number>> | null {
  if (blank(raw)) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Alíquotas de retenção inválidas');
  for (const [tax, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!RETENTION_TAXES.includes(tax as RetentionTax)) throw new BadRequestException(`Imposto retido inválido: ${tax}`);
    if (blank(value)) continue;
    const n = num(value);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new BadRequestException(`${TAX_LABEL[tax as RetentionTax]}: alíquota deve ficar entre 0 e 100%`);
  }
  const rates = ratesOf(raw);
  return Object.keys(rates).length ? rates : null;
}

/** Grava (substitui) as retenções de uma conta a receber. */
export async function writeRetentions(tx: Tx, record: {
  id: number; companyId: number; customerId: number | null; contractId: number | null; measurementId: number | null; invoiceNumber: string | null; accrualDate: string;
}, list: RetentionInput[], base: number, userId: number | null) {
  await tx.financial_Retention.deleteMany({ where: { financialRecordId: record.id } });
  if (!list.length) return;
  await tx.financial_Retention.createMany({ data: list.map((r) => ({
    companyId: record.companyId, financialRecordId: record.id, customerId: record.customerId, contractId: record.contractId, measurementId: record.measurementId,
    tax: r.tax, rate: r.rate, base, value: r.value, accrualDate: record.accrualDate, invoiceNumber: record.invoiceNumber, createdByUserId: userId,
  })) });
}

/**
 * Valor líquido da conta a receber ao faturar: com retenções, é o valor menos
 * elas; sem retenções, vale o líquido digitado (o jeito antigo), se houver.
 */
export function netWith(value: number, list: RetentionInput[], typedNet: number | null): number | null {
  if (list.length) return round2(value - retentionTotal(list));
  return typedNet;
}

export interface RetentionActor { userId: number; companyId: number }

type RecordRow = {
  id: number; value: Prisma.Decimal | null; netValue: Prisma.Decimal | null; receivedValue: Prisma.Decimal | null; status: string; paidAt: Date | null;
  interestValue: Prisma.Decimal | null; fineValue: Prisma.Decimal | null; discountValue: Prisma.Decimal | null;
  invoiceNumber: string | null; description: string | null; contractId: number | null; dueDate: Date | null; customer: { id: number; name: string } | null;
};

@Injectable()
export class RetentionService {
  constructor(private readonly prisma: PrismaService) {}

  private range(query: Record<string, unknown>) {
    const to = MONTH.test(String(query.to ?? '')) ? String(query.to) : thisMonth();
    const from = MONTH.test(String(query.from ?? '')) ? String(query.from) : shiftMonth(to, -5);
    if (from > to) throw new BadRequestException('O mês inicial não pode ser depois do final');
    const months: string[] = [];
    for (let m = from; m <= to && months.length < 36; m = shiftMonth(m, 1)) months.push(m);
    return { from, to: months[months.length - 1], months };
  }

  /**
   * O que entrou de fato. A baixa com valor diferente do esperado lança a
   * diferença como juros ou desconto sozinha, então compara-se o valor bruto
   * que entrou com o valor da nota e com o líquido.
   */
  private principalReceived(r: RecordRow): number | null {
    return r.receivedValue === null ? null : round2(Number(r.receivedValue));
  }

  /** Alertas de uma conta a receber já paga, olhando o que o cliente reteve e o que depositou. */
  private recordAlert(r: RecordRow, retained: number) {
    if (r.status !== 'received') return null;
    const got = this.principalReceived(r);
    if (got === null) return null;
    const value = Number(r.value ?? 0);
    const net = r.netValue === null ? value : Number(r.netValue);
    const money = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    if (retained > 0 && got >= value - 0.01) {
      return { type: 'pagou_cheio', severity: 'alta', message: `O cliente informou ${money(retained)} de retenção, mas depositou o valor cheio (${money(got)}). Ou a retenção não aconteceu (a empresa precisa recolher esse imposto na guia), ou o cliente pagou duas vezes (pedir a devolução ou compensar).` };
    }
    if (got < net - 0.01) {
      return retained > 0
        ? { type: 'recebido_menor', severity: 'media', message: `Entrou ${money(got)}, menos que o líquido esperado de ${money(net)} (já descontadas as retenções). Confira se o cliente reteve algum imposto a mais.` }
        : { type: 'retencao_nao_informada', severity: 'media', message: `Entrou ${money(got)} de uma nota de ${money(value)}. Se a diferença for imposto retido pelo cliente, informe a retenção: senão ela é paga de novo na guia.` };
    }
    return null;
  }

  /**
   * Relatório "impostos retidos pelos clientes": por mês (competência da nota),
   * o total retido por imposto, as guias pagas no mês e os alertas.
   */
  async report(companyId: number, query: Record<string, unknown>) {
    const { from, to, months } = this.range(query);
    const live = { inactiveAt: null, status: { not: 'cancelled' as const } };
    const recordSelect = {
      id: true, value: true, netValue: true, receivedValue: true, status: true, paidAt: true, interestValue: true, fineValue: true, discountValue: true,
      invoiceNumber: true, description: true, contractId: true, dueDate: true, customer: { select: { id: true, name: true } },
    } satisfies Prisma.FinancialRecordsSelect;
    // CNPJ do grupo (vazio = todos): retenções das contas a receber dele e as guias que ele paga
    const entityIds = String(query.entityId ?? '').split(',').map(Number).filter((n) => n > 0);
    const byEntity = entityIds.length ? { entityId: { in: entityIds } } : {};
    const [rows, guides] = await Promise.all([
      this.prisma.financial_Retention.findMany({
        where: { companyId, accrualDate: { gte: from, lte: to }, financialRecord: { ...live, ...byEntity } },
        include: { financialRecord: { select: recordSelect } }, orderBy: [{ accrualDate: 'asc' }, { financialRecordId: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.financial_Payable.findMany({
        where: { companyId, ...byEntity, inactiveAt: null, taxKind: { not: null }, accrualDate: { gte: from, lte: to } },
        select: { id: true, taxKind: true, description: true, value: true, paidValue: true, status: true, dueDate: true, paidAt: true, accrualDate: true }, orderBy: { dueDate: 'asc' },
      }),
    ]);

    // notas pagas em que a conta não bate com a retenção (ou falta a retenção)
    const byRecord = new Map<number, { record: RecordRow; retained: number }>();
    for (const row of rows) {
      const entry = byRecord.get(row.financialRecordId) ?? { record: row.financialRecord as RecordRow, retained: 0 };
      entry.retained = round2(entry.retained + Number(row.value));
      byRecord.set(row.financialRecordId, entry);
    }
    const alerts: Array<Record<string, unknown>> = [];
    for (const { record, retained } of byRecord.values()) {
      const alert = this.recordAlert(record, retained);
      if (alert) alerts.push({ ...alert, financialRecordId: record.id, invoiceNumber: record.invoiceNumber, customer: record.customer?.name ?? null, value: Number(record.value ?? 0) });
    }
    // contas a receber de contrato pagas no período, sem retenção e com menos dinheiro do que a nota
    const unretained = await this.prisma.financialRecords.findMany({
      where: {
        companyId, ...live, ...byEntity, status: 'received', contractId: { not: null }, retentions: { none: {} }, invoiceNumber: { not: null },
        accrualDate: { gte: from, lte: to }, receivedValue: { not: null },
      },
      select: recordSelect, take: 200,
    });
    for (const record of unretained) {
      const alert = this.recordAlert(record as RecordRow, 0);
      if (alert) alerts.push({ ...alert, financialRecordId: record.id, invoiceNumber: record.invoiceNumber, customer: record.customer?.name ?? null, value: Number(record.value ?? 0) });
    }

    const report = months.map((month) => {
      const ofMonth = rows.filter((r) => r.accrualDate === month);
      const totals = Object.fromEntries(RETENTION_TAXES.map((tax) => [tax, round2(ofMonth.filter((r) => r.tax === tax).reduce((s, r) => s + Number(r.value), 0))])) as Record<RetentionTax, number>;
      const guidesOfMonth = guides.filter((g) => g.accrualDate === month);
      const pending = ofMonth.filter((r) => !r.declaredAt);
      // guia paga (ou a pagar) de um imposto que o cliente reteve no mesmo mês, sem a retenção marcada como informada
      for (const guide of guidesOfMonth) {
        const covers = TAX_GUIDES[guide.taxKind ?? '']?.covers ?? [];
        const clash = covers.filter((tax) => pending.some((r) => r.tax === tax));
        if (!clash.length) continue;
        const retained = round2(pending.filter((r) => clash.includes(r.tax as RetentionTax)).reduce((s, r) => s + Number(r.value), 0));
        alerts.push({
          type: 'retido_e_pago', severity: 'alta', month, payableId: guide.id, guide: TAX_GUIDES[guide.taxKind!]?.label ?? guide.taxKind, value: Number(guide.value),
          taxes: clash, retained,
          message: `${month.split('-').reverse().join('/')}: os clientes já retiveram ${clash.map((t) => TAX_LABEL[t]).join(', ')} (${retained.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}) e há a guia "${guide.description}" do mesmo mês. Confirme que a guia descontou o retido e marque as retenções como informadas; senão o imposto é pago duas vezes.`,
        });
      }
      return {
        month, totals, total: round2(Object.values(totals).reduce((s, v) => s + v, 0)), count: ofMonth.length, pending: pending.length,
        declared: ofMonth.length > 0 && pending.length === 0,
        guides: guidesOfMonth.map((g) => ({ id: g.id, taxKind: g.taxKind, label: TAX_GUIDES[g.taxKind ?? '']?.label ?? g.taxKind, description: g.description, value: Number(g.value), status: g.status, dueDate: g.dueDate, paidAt: g.paidAt })),
      };
    });

    return {
      from, to, months: report,
      totals: Object.fromEntries(RETENTION_TAXES.map((tax) => [tax, round2(report.reduce((s, m) => s + m.totals[tax], 0))])),
      total: round2(report.reduce((s, m) => s + m.total, 0)),
      rows: rows.map((r) => ({
        id: r.id, tax: r.tax, label: TAX_LABEL[r.tax as RetentionTax] ?? r.tax, rate: r.rate === null ? null : Number(r.rate), base: Number(r.base), value: Number(r.value),
        accrualDate: r.accrualDate, invoiceNumber: r.invoiceNumber, declaredAt: r.declaredAt, contractId: r.contractId, measurementId: r.measurementId,
        financialRecordId: r.financialRecordId, customer: r.financialRecord.customer, description: r.financialRecord.description, recordStatus: r.financialRecord.status,
      })),
      alerts,
      taxes: RETENTION_TAXES.map((tax) => ({ id: tax, name: TAX_LABEL[tax] })),
      guides: Object.entries(TAX_GUIDES).map(([id, g]) => ({ id, name: g.label, covers: g.covers })),
    };
  }

  /** Marca (ou desmarca) as retenções de um mês como informadas na guia. */
  async declare(actor: RetentionActor, body: Record<string, unknown>) {
    const month = String(body.month ?? '');
    if (!MONTH.test(month)) throw new BadRequestException('Informe o mês (AAAA-MM)');
    const taxes = Array.isArray(body.taxes) ? (body.taxes as string[]).filter((t) => RETENTION_TAXES.includes(t as RetentionTax)) : [...RETENTION_TAXES];
    const undo = body.undo === true;
    const result = await this.prisma.financial_Retention.updateMany({
      // com um CNPJ escolhido, só as retenções das contas a receber dele (cada CNPJ declara as suas)
      where: {
        companyId: actor.companyId, accrualDate: month, tax: { in: taxes }, declaredAt: undo ? { not: null } : null,
        ...(Number(body.entityId) > 0 ? { financialRecord: { entityId: Number(body.entityId) } } : {}),
      },
      data: undo ? { declaredAt: null, declaredByUserId: null } : { declaredAt: new Date(), declaredByUserId: actor.userId },
    });
    return { updated: result.count };
  }

  /** Retenções de uma conta a receber (para a tela de edição). */
  async ofRecord(companyId: number, financialRecordId: number) {
    const record = await this.prisma.financialRecords.findFirst({
      where: { id: financialRecordId, companyId },
      select: { id: true, value: true, netValue: true, contractId: true, measurementId: true, retentions: { orderBy: { id: 'asc' } } },
    });
    if (!record) throw new NotFoundException('Conta a receber não encontrada');
    const base = await this.baseOf(record);
    return {
      financialRecordId: record.id, value: Number(record.value ?? 0), netValue: record.netValue === null ? null : Number(record.netValue), base,
      retentions: record.retentions.map((r) => ({ tax: r.tax, rate: r.rate === null ? null : Number(r.rate), value: Number(r.value), declaredAt: r.declaredAt })),
      suggested: record.contractId ? ratesOf((await this.prisma.commercial_Contract.findUnique({ where: { id: record.contractId }, select: { retentionRates: true } }))?.retentionRates) : {},
    };
  }

  /** Base da retenção: o valor da nota (na medição de obra é o bruto do boletim, antes da caução). */
  private async baseOf(record: { value: Prisma.Decimal | null; measurementId: number | null }) {
    if (record.measurementId) {
      const m = await this.prisma.commercial_Measurement.findUnique({ where: { id: record.measurementId }, select: { invoiceValue: true } });
      if (m?.invoiceValue !== null && m?.invoiceValue !== undefined) return Number(m.invoiceValue);
    }
    return Number(record.value ?? 0);
  }

  /** Informa ou corrige as retenções de qualquer conta a receber: o líquido acompanha. */
  async setForRecord(actor: RetentionActor, financialRecordId: number, body: Record<string, unknown>) {
    const record = await this.prisma.financialRecords.findFirst({
      where: { id: financialRecordId, companyId: actor.companyId, inactiveAt: null },
      select: { id: true, companyId: true, customerId: true, contractId: true, measurementId: true, invoiceNumber: true, accrualDate: true, value: true, status: true, invoiceIssuedAt: true },
    });
    if (!record) throw new NotFoundException('Conta a receber não encontrada');
    if (record.status === 'cancelled') throw new BadRequestException('Conta a receber cancelada');
    const base = await this.baseOf(record);
    const list = parseRetentions(body.retentions, base);
    const value = Number(record.value ?? 0);
    if (retentionTotal(list) >= value) throw new BadRequestException('As retenções não podem chegar ao valor a receber');
    const accrualDate = record.invoiceIssuedAt ? record.invoiceIssuedAt.toISOString().slice(0, 7) : record.accrualDate.slice(0, 7);
    await this.prisma.$transaction(async (tx) => {
      await writeRetentions(tx, { ...record, accrualDate }, list, base, actor.userId);
      await tx.financialRecords.update({ where: { id: record.id }, data: { netValue: list.length ? round2(value - retentionTotal(list)) : null } });
    });
    return this.ofRecord(actor.companyId, record.id);
  }
}
