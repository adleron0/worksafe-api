import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { assertNoAuthorizedInvoice } from 'src/features/fiscal/fiscal.guards';
import { classificationDefaults } from 'src/features/financial/classification';
import { CrewMember, Occurrence, StepProgress } from 'src/features/operations/daily-report.service';
import { DocumentService } from './document.service';
import { ContractPlan, contractPlanOf, parsePlan, planProblem } from './measurement.plan';
import { MeasurementActor, MeasurementService, commissionFor, measurementLabel } from './measurement.service';
import { SellerWalletService } from './wallet.service';

/**
 * Medição de obra (plano 08, fase 8): o boletim de medição (BM) de um contrato
 * de serviço faturado por medição. Usa o mesmo `Commercial_Measurement` da
 * locação (origem `obra`) e a mesma conta a receber com `measurementId`.
 *
 * Ciclo: rascunho → enviado ao cliente (link) → aprovado (ou contestado, com
 * nota) → faturado (NF → conta a receber). Um boletim em aberto por contrato.
 * O % acumulado de cada frente vem do último RDO fechado do período
 * (`Service_DailyReport.progress`) e é editável.
 */

type Body = Record<string, any>;
type Tx = Prisma.TransactionClient;
export type WorkLineKind = 'frente' | 'caucao';
export interface WorkLine {
  kind: WorkLineKind; description: string; periodStart: string | null; periodEnd: string | null; value: number;
  frontId?: number; mobilization?: boolean; base?: number; prevPercent?: number; percent?: number; accPercent?: number; reportedPercent?: number; rule?: string;
}
interface Prior { acc: Map<number, number>; billedFront: Map<number, number>; deposit: number; lastEnd: string | null }

const OPEN = ['rascunho', 'enviada', 'aprovada', 'contestada'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const round4 = (value: number) => Math.round(value * 1e4) / 1e4;
const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const noonUtc = (value: string) => new Date(`${value}T12:00:00.000Z`);
const addDays = (value: string, days: number) => { const d = asDate(value); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const pct = (value: number) => `${(Math.round(value * 10000) / 100).toString().replace('.', ',')}%`;
function dateOf(value: unknown, label: string): string {
  const out = String(value ?? '').slice(0, 10);
  if (!DATE.test(out) || Number.isNaN(asDate(out).getTime()) || asDate(out).toISOString().slice(0, 10) !== out) throw new BadRequestException(`${label}: data inválida`);
  return out;
}
const planOf = (raw: unknown) => raw as ContractPlan | null;

/** O que já foi faturado nos boletins anteriores: % acumulado por frente (a mobilização é uma delas) e caução. */
export function priorOf(billed: Array<{ lines: unknown; periodEnd: Date | null; depositValue: Prisma.Decimal | null }>): Prior {
  const prior: Prior = { acc: new Map(), billedFront: new Map(), deposit: 0, lastEnd: null };
  for (const m of billed) {
    for (const line of (m.lines as WorkLine[]) ?? []) {
      if (line.kind === 'frente' && line.frontId) {
        prior.acc.set(line.frontId, Math.max(prior.acc.get(line.frontId) ?? 0, line.accPercent ?? 0));
        prior.billedFront.set(line.frontId, round2((prior.billedFront.get(line.frontId) ?? 0) + line.value));
      }
    }
    prior.deposit = round2(prior.deposit + Number(m.depositValue ?? 0));
    const end = iso(m.periodEnd);
    if (end && (!prior.lastEnd || end > prior.lastEnd)) prior.lastEnd = end;
  }
  return prior;
}

/**
 * Linhas de um boletim: cada frente (% anterior, do período e acumulado; regra
 * "só ao concluir" segura a frente até 100%; a mobilização é uma frente que,
 * sem outro valor informado, sai 100% no primeiro boletim) e a caução retida. `invoiceValue` = valor da nota; `value` = a receber (nota − caução).
 */
export function buildWorkLines(plan: ContractPlan, prior: Prior, reported: Map<number, number>, period: { start: string; end: string }) {
  const at = { periodStart: period.start, periodEnd: period.end };
  const lines: WorkLine[] = [];
  let fronts = 0;
  for (const f of plan.fronts) {
    const prev = prior.acc.get(f.id) ?? 0;
    // medição inicial (mobilização): sai inteira no primeiro boletim, salvo outro valor informado
    const raw = reported.has(f.id) ? reported.get(f.id)! : f.mobilization ? 100 : prev;
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) throw new BadRequestException(`${f.title}: o % concluído deve ficar entre 0 e 100`);
    const value4 = round4(raw);
    if (value4 < prev - 0.00005) throw new BadRequestException(`${f.title}: o acumulado não pode voltar (${String(prev).replace('.', ',')}% já medido)`);
    const acc = f.rule === 'conclusao' ? (value4 >= 100 ? 100 : prev) : value4;
    // o acumulado em reais sai do % acumulado: os centavos fecham na conclusão
    const value = round2(round2((f.value * acc) / 100) - (prior.billedFront.get(f.id) ?? 0));
    fronts = round2(fronts + value);
    lines.push({ kind: 'frente', frontId: f.id, ...(f.mobilization ? { mobilization: true } : {}), rule: f.rule, description: f.title, base: f.value, prevPercent: prev, percent: round4(acc - prev), accPercent: acc, reportedPercent: value4, value, ...at });
  }
  const invoiceValue = round2(lines.reduce((s, l) => s + l.value, 0));
  const depositValue = plan.depositRate > 0 ? round2(fronts * plan.depositRate) : 0;
  if (depositValue > 0) lines.push({ kind: 'caucao', description: `Caução contratual retida (${pct(plan.depositRate)})`, value: -depositValue, ...at });
  return { lines, invoiceValue, depositValue, value: round2(invoiceValue - depositValue), measured: fronts };
}

@Injectable()
export class WorkMeasurementService {
  constructor(private readonly prisma: PrismaService, private readonly measurements: MeasurementService, private readonly documents: DocumentService, private readonly wallet: SellerWalletService) {}

  private async contractOf(companyId: number, id: number) {
    const row = await this.prisma.commercial_Contract.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException('Contrato não encontrado');
    if (row.billingMode !== 'medicao' || !row.measurementPlan) throw new ConflictException('Esta venda não é faturada por medição de obra');
    return row;
  }

  private async billedOf(contractId: number, beforeNumber?: number) {
    return this.prisma.commercial_Measurement.findMany({
      where: { contractId, source: 'obra', status: 'faturada', ...(beforeNumber ? { number: { lt: beforeNumber } } : {}) }, orderBy: { number: 'asc' },
    });
  }

  private async openOf(contractId: number) {
    return this.prisma.commercial_Measurement.findFirst({ where: { contractId, source: 'obra', status: { in: OPEN } } });
  }

  private async byId(companyId: number, contractId: number, id: number) {
    const row = await this.prisma.commercial_Measurement.findFirst({ where: { id, contractId, companyId, source: 'obra' } });
    if (!row) throw new NotFoundException('Boletim de medição não encontrado');
    return row;
  }

  /** % acumulado de cada etapa no último RDO fechado até a data (a OS da venda). */
  private async rdoProgress(contractId: number, until: string) {
    const order = await this.prisma.service_Order.findUnique({ where: { contractId }, select: { id: true } });
    if (!order) return { order: null, last: new Map<number, number>(), date: null as string | null };
    const reports = await this.prisma.service_DailyReport.findMany({
      where: { orderId: order.id, status: 'fechado', date: { lte: asDate(until) } }, orderBy: [{ date: 'asc' }, { id: 'asc' }], select: { date: true, progress: true },
    });
    const last = new Map<number, number>();
    for (const r of reports) for (const item of (r.progress as unknown as StepProgress[]) ?? []) last.set(item.step, Number(item.percent) || 0);
    return { order, last, date: reports.length ? iso(reports[reports.length - 1].date) : null };
  }

  /** Sugestão para um boletim novo: período e % de cada frente pelo RDO. */
  async suggestion(actor: MeasurementActor, contractId: number, query: Record<string, string>) {
    const contract = await this.contractOf(actor.companyId, contractId);
    const plan = planOf(contract.measurementPlan)!;
    const prior = priorOf(await this.billedOf(contractId));
    const end = blank(query.periodEnd) ? today() : dateOf(query.periodEnd, 'Fim do período');
    const start = prior.lastEnd ? addDays(prior.lastEnd, 1) : iso(contract.startDate) ?? iso(contract.acceptedAt)!;
    const rdo = await this.rdoProgress(contractId, end);
    const fronts = plan.fronts.map((f) => {
      const prev = prior.acc.get(f.id) ?? 0;
      const fromRdo = f.step !== null && rdo.last.has(f.step) ? rdo.last.get(f.step)! : null;
      // a mobilização (medição inicial) vem sugerida inteira
      const percent = f.mobilization ? 100 : Math.max(prev, fromRdo ?? prev);
      return { id: f.id, title: f.title, rule: f.rule, value: f.value, step: f.step, mobilization: Boolean(f.mobilization), prevPercent: prev, rdoPercent: fromRdo, percent };
    });
    const preview = buildWorkLines(plan, prior, new Map(fronts.map((f) => [f.id, f.percent])), { start: start > end ? end : start, end });
    return { periodStart: start > end ? end : start, periodEnd: end, rdoDate: rdo.date, hasOrder: Boolean(rdo.order), fronts, preview };
  }

  private reportedOf(body: Body): Map<number, number> {
    const out = new Map<number, number>();
    for (const item of Array.isArray(body.fronts) ? body.fronts : []) {
      const id = Number(item?.id);
      if (!Number.isInteger(id) || blank(item?.percent)) continue;
      out.set(id, Number(String(item.percent).replace(',', '.')));
    }
    return out;
  }

  private periodOf(body: Body, fallbackStart: string) {
    const end = blank(body.periodEnd) ? today() : dateOf(body.periodEnd, 'Fim do período');
    const start = blank(body.periodStart) ? fallbackStart : dateOf(body.periodStart, 'Início do período');
    if (start > end) throw new BadRequestException('O início do período não pode ser depois do fim');
    return { start, end };
  }

  /** Cria o boletim (rascunho). Só um boletim em aberto por contrato. */
  async create(actor: MeasurementActor, contractId: number, body: Body) {
    const contract = await this.contractOf(actor.companyId, contractId);
    if (contract.status !== 'vigente') throw new ConflictException(`Contrato ${contract.status}: não recebe medição nova`);
    const plan = planOf(contract.measurementPlan)!;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(740131::int, ${contractId}::int)`;
      const open = await tx.commercial_Measurement.findFirst({ where: { contractId, source: 'obra', status: { in: OPEN } }, select: { number: true } });
      if (open) throw new ConflictException(`Já há um boletim em aberto (${measurementLabel(open.number)}): fature ou exclua antes de abrir outro`);
      const prior = priorOf(await tx.commercial_Measurement.findMany({ where: { contractId, source: 'obra', status: 'faturada' }, orderBy: { number: 'asc' } }));
      const period = this.periodOf(body, prior.lastEnd ? addDays(prior.lastEnd, 1) : iso(contract.startDate) ?? iso(contract.acceptedAt)!);
      const built = buildWorkLines(plan, prior, this.reportedOf(body), period);
      const last = await tx.commercial_Measurement.aggregate({ where: { contractId }, _max: { number: true } });
      const created = await tx.commercial_Measurement.create({ data: {
        companyId: actor.companyId, contractId, number: (last._max.number ?? 0) + 1, source: 'obra', status: 'rascunho',
        periodStart: asDate(period.start), periodEnd: asDate(period.end), lines: built.lines as unknown as Prisma.InputJsonValue,
        value: built.value, invoiceValue: built.invoiceValue, depositValue: built.depositValue, notes: clean(body.notes, 2000) || null, createdByUserId: actor.userId,
      } });
      return { id: created.id, number: measurementLabel(created.number) };
    });
  }

  /** Edita o boletim em rascunho ou contestado (volta a rascunho). */
  async update(actor: MeasurementActor, contractId: number, id: number, body: Body) {
    const contract = await this.contractOf(actor.companyId, contractId);
    const row = await this.byId(actor.companyId, contractId, id);
    if (!['rascunho', 'contestada'].includes(row.status)) throw new ConflictException('Só o boletim em rascunho ou contestado pode ser alterado');
    const prior = priorOf(await this.billedOf(contractId, row.number));
    const lines = (row.lines as unknown as WorkLine[]) ?? [];
    const reported = body.fronts ? this.reportedOf(body) : new Map(lines.filter((l) => l.kind === 'frente' && l.frontId).map((l) => [l.frontId!, l.reportedPercent ?? l.accPercent ?? 0]));
    const period = this.periodOf({ periodStart: body.periodStart ?? iso(row.periodStart), periodEnd: body.periodEnd ?? iso(row.periodEnd) }, iso(row.periodStart)!);
    const built = buildWorkLines(planOf(contract.measurementPlan)!, prior, reported, period);
    await this.prisma.commercial_Measurement.update({ where: { id }, data: {
      status: 'rascunho', decision: Prisma.JsonNull, decidedAt: null,
      periodStart: asDate(period.start), periodEnd: asDate(period.end), lines: built.lines as unknown as Prisma.InputJsonValue,
      value: built.value, invoiceValue: built.invoiceValue, depositValue: built.depositValue,
      ...('notes' in body ? { notes: clean(body.notes, 2000) || null } : {}),
    } });
    return { id };
  }

  /** Exclui um boletim que ainda não foi faturado (o número volta a ficar livre). */
  async remove(actor: MeasurementActor, contractId: number, id: number) {
    await this.contractOf(actor.companyId, contractId);
    const row = await this.byId(actor.companyId, contractId, id);
    if (!OPEN.includes(row.status)) throw new ConflictException('Boletim faturado: desfaça o faturamento antes');
    await this.prisma.commercial_Measurement.delete({ where: { id } });
    return { ok: true };
  }

  private assertSomething(row: { invoiceValue: Prisma.Decimal | null }) {
    if (!(Number(row.invoiceValue ?? 0) > 0)) throw new BadRequestException('Nada medido neste boletim: informe o avanço das frentes');
  }

  /** Envia ao cliente: gera o link de aprovação (/medicao/<chave>). */
  async send(actor: MeasurementActor, contractId: number, id: number) {
    await this.contractOf(actor.companyId, contractId);
    const row = await this.byId(actor.companyId, contractId, id);
    if (!['rascunho', 'contestada', 'enviada'].includes(row.status)) throw new ConflictException('Este boletim não pode ser enviado agora');
    this.assertSomething(row);
    const publicKey = row.publicKey ?? randomBytes(18).toString('base64url');
    await this.prisma.commercial_Measurement.update({ where: { id }, data: { status: 'enviada', publicKey, sentAt: new Date(), decision: Prisma.JsonNull, decidedAt: null } });
    return { publicKey };
  }

  /** Aprovação registrada à mão (o cliente aprovou por e-mail, WhatsApp, reunião). */
  async approve(actor: MeasurementActor, contractId: number, id: number, body: Body) {
    await this.contractOf(actor.companyId, contractId);
    const row = await this.byId(actor.companyId, contractId, id);
    if (!['rascunho', 'enviada', 'contestada'].includes(row.status)) throw new ConflictException('Este boletim não pode ser aprovado agora');
    this.assertSomething(row);
    const name = clean(body.name, 160);
    if (name.length < 2) throw new BadRequestException('Informe quem aprovou pelo cliente');
    await this.prisma.commercial_Measurement.update({ where: { id }, data: {
      status: 'aprovada', decidedAt: new Date(),
      decision: { decision: 'aprovada', manual: true, userId: actor.userId, name, note: clean(body.note, 500) || null, at: new Date().toISOString() },
    } });
    return { ok: true };
  }

  /**
   * Fatura o boletim aprovado: uma nota, uma conta a receber (nota − caução,
   * com retenções de imposto e comissão proporcional); a caução retida vai para
   * a conta a receber da caução do contrato, liberada no fim da obra.
   */
  async bill(actor: MeasurementActor, contractId: number, id: number, body: Body) {
    const contract = await this.contractOf(actor.companyId, contractId);
    if (contract.status === 'cancelado') throw new ConflictException('Contrato cancelado: não recebe faturamento novo');
    const row = await this.byId(actor.companyId, contractId, id);
    if (row.status !== 'aprovada') throw new ConflictException(row.status === 'faturada' ? 'Este boletim já foi faturado' : 'O boletim precisa estar aprovado pelo cliente antes de faturar');
    const value = Number(row.value), invoiceValue = Number(row.invoiceValue ?? row.value), deposit = Number(row.depositValue ?? 0);
    if (!(value > 0)) throw new BadRequestException('Nada a receber neste boletim');
    const invoice = this.measurements.invoiceOf(body, value, addDays(today(), 30), invoiceValue);
    const plan = planOf(contract.measurementPlan)!;
    const recordId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(740131::int, ${contractId}::int)`;
      const locked = await tx.commercial_Measurement.updateMany({ where: { id, status: 'aprovada' }, data: { status: 'faturada', invoiceNumber: invoice.invoiceNumber } });
      if (!locked.count) throw new ConflictException('Este boletim mudou enquanto você faturava: atualize a tela');
      const created = await this.measurements.createRecord(tx, {
        companyId: actor.companyId, userId: actor.userId, contract, measurement: row, value, invoice,
        description: `${contract.number} — ${measurementLabel(row.number)} (medição de ${br(iso(row.periodStart))} a ${br(iso(row.periodEnd))}) · ${contract.title}`,
      });
      if (deposit > 0) await this.addDeposit(tx, contract, plan, deposit, actor.companyId);
      return created;
    });
    await this.wallet.syncRecordSafe(recordId);
    const fresh = await this.prisma.commercial_Contract.findUnique({ where: { id: contractId }, select: { depositRecordId: true } });
    if (fresh?.depositRecordId) await this.wallet.syncRecordSafe(fresh.depositRecordId);
    return { financialRecordId: recordId, number: measurementLabel(row.number), value };
  }

  /** Vencimento da caução: fim da obra (conclusão do contrato ou previsão da OS) + o prazo combinado. */
  private async depositDue(tx: Tx, contract: { id: number; endDate: Date | null }, plan: ContractPlan) {
    const order = await tx.service_Order.findUnique({ where: { contractId: contract.id }, select: { plannedEnd: true, finishedAt: true } });
    const end = iso(contract.endDate) ?? iso(order?.finishedAt) ?? iso(order?.plannedEnd) ?? addDays(today(), 180);
    return addDays(end, plan.depositReleaseDays || 0);
  }

  /** Soma a caução retida na conta a receber da caução do contrato (cria na primeira vez). */
  private async addDeposit(tx: Tx, contract: Prisma.Commercial_ContractGetPayload<object>, plan: ContractPlan, amount: number, companyId: number) {
    const current = contract.depositRecordId ? await tx.financialRecords.findUnique({ where: { id: contract.depositRecordId } }) : null;
    if (current && !current.inactiveAt && current.status === 'waiting') {
      const total = round2(Number(current.value) + amount);
      await tx.financialRecords.update({ where: { id: current.id }, data: { value: total, ...(await commissionFor(tx, contract, total)) } });
      return;
    }
    const record = await tx.financialRecords.create({ data: {
      companyId, gateway: 'manual', status: 'waiting', paymentMethod: 'boleto', customerId: contract.customerId, sellerId: contract.sellerId,
      value: amount, ...(await commissionFor(tx, contract, amount)),
      dueDate: noonUtc(await this.depositDue(tx, contract, plan)), accrualDate: today().slice(0, 7),
      description: `${contract.number} — caução contratual retida nos boletins · ${contract.title}`.slice(0, 255),
      observations: 'Caução contratual: liberada no fim da obra', contractId: contract.id,
      ...(await classificationDefaults(tx, companyId, 'contrato')),
    } });
    await tx.commercial_Contract.update({ where: { id: contract.id }, data: { depositRecordId: record.id } });
  }

  /** Desfaz o faturamento do último boletim de obra: a conta é cancelada, a caução volta e o boletim fica aprovado. */
  async unbill(actor: MeasurementActor, contractId: number, id: number) {
    const contract = await this.contractOf(actor.companyId, contractId);
    const row = await this.byId(actor.companyId, contractId, id);
    if (row.status !== 'faturada') throw new NotFoundException('Medição não encontrada');
    const later = await this.prisma.commercial_Measurement.count({ where: { contractId, source: 'obra', number: { gt: row.number }, status: { not: 'cancelada' } } });
    if (later) throw new ConflictException('Desfaça ou exclua antes os boletins mais novos deste contrato');
    const record = row.financialRecordId ? await this.prisma.financialRecords.findUnique({ where: { id: row.financialRecordId }, select: { id: true, status: true } }) : null;
    if (record?.status === 'received') throw new ConflictException('Este boletim já foi pago: estorne a baixa em Contas a Receber antes de desfazer');
    await assertNoAuthorizedInvoice(this.prisma, record?.id);
    const deposit = Number(row.depositValue ?? 0);
    const depositRecord = deposit > 0 && contract.depositRecordId ? await this.prisma.financialRecords.findUnique({ where: { id: contract.depositRecordId } }) : null;
    if (depositRecord && depositRecord.status === 'received') throw new ConflictException('A caução deste contrato já foi recebida: estorne a baixa dela antes');
    await this.prisma.$transaction(async (tx) => {
      if (record) await tx.financialRecords.update({ where: { id: record.id }, data: { inactiveAt: new Date(), status: 'cancelled' } });
      await tx.commercial_Measurement.update({ where: { id }, data: { status: 'aprovada', financialRecordId: null, invoiceNumber: null } });
      if (depositRecord) {
        const rest = round2(Number(depositRecord.value) - deposit);
        if (rest > 0.005) await tx.financialRecords.update({ where: { id: depositRecord.id }, data: { value: rest, ...(await commissionFor(tx, contract, rest)) } });
        else {
          await tx.financialRecords.update({ where: { id: depositRecord.id }, data: { inactiveAt: new Date(), status: 'cancelled' } });
          await tx.commercial_Contract.update({ where: { id: contractId }, data: { depositRecordId: null } });
        }
      }
    });
    if (record) await this.wallet.syncRecordSafe(record.id);
    if (depositRecord) await this.wallet.syncRecordSafe(depositRecord.id);
    return { ok: true };
  }

  /** Libera a caução: muda o vencimento da conta da caução (fim da obra ou data combinada). */
  async releaseDeposit(actor: MeasurementActor, contractId: number, body: Body) {
    const contract = await this.contractOf(actor.companyId, contractId);
    if (!contract.depositRecordId) throw new ConflictException('Ainda não há caução retida neste contrato');
    const record = await this.prisma.financialRecords.findUnique({ where: { id: contract.depositRecordId } });
    if (!record || record.status !== 'waiting') throw new ConflictException('A conta da caução não está em aberto');
    const due = blank(body.dueDate) ? today() : dateOf(body.dueDate, 'Vencimento da caução');
    await this.prisma.financialRecords.update({ where: { id: record.id }, data: { dueDate: noonUtc(due), observations: `Caução contratual liberada para ${br(due)}` } });
    return { ok: true };
  }

  /** Desfaz uma medição pela rota comum: obra aqui, locação no serviço da medição. */
  async unbillAny(actor: MeasurementActor, contractId: number, id: number) {
    const row = await this.prisma.commercial_Measurement.findFirst({ where: { id, contractId, companyId: actor.companyId }, select: { source: true } });
    if (row?.source === 'obra') return this.unbill(actor, contractId, id);
    return this.measurements.unbill(actor, contractId, id);
  }

  /**
   * Passa uma venda de serviço para medição de obra (ou ajusta o plano) depois
   * do aceite, enquanto nada foi faturado nem medido.
   */
  async setPlan(actor: MeasurementActor, contractId: number, body: Body) {
    const contract = await this.prisma.commercial_Contract.findFirst({ where: { id: contractId, companyId: actor.companyId }, include: { installments: true } });
    if (!contract) throw new NotFoundException('Contrato não encontrado');
    if (contract.kind !== 'servico') throw new ConflictException('Só venda de serviço é faturada por medição de obra');
    if (contract.status !== 'vigente') throw new ConflictException(`Contrato ${contract.status}`);
    if (contract.installments.some((i) => i.financialRecordId)) throw new ConflictException('Já há parcela faturada: desfaça o faturamento antes de mudar para medição');
    if (await this.prisma.commercial_Measurement.count({ where: { contractId, source: 'obra' } })) throw new ConflictException('Já há boletins de medição: o plano não pode mais mudar');
    const proposal = await this.prisma.commercial_Proposal.findUnique({ where: { id: contract.proposalId }, select: { schedule: true } });
    const plan = parsePlan({ ...(body.plan ?? {}), mode: 'medicao' }, proposal?.schedule);
    const problem = plan ? planProblem(plan) : 'Plano inválido';
    if (problem) throw new BadRequestException(problem);
    await this.prisma.$transaction(async (tx) => {
      await tx.commercial_ContractInstallment.deleteMany({ where: { contractId, financialRecordId: null } });
      await tx.commercial_Contract.update({ where: { id: contractId }, data: { billingMode: 'medicao', measurementPlan: contractPlanOf(plan!, Number(contract.value)) as unknown as Prisma.InputJsonValue } });
    });
    return { ok: true };
  }

  // ------------------------------------------------------------------ relatório e link do cliente

  /** Relatório do período (boletim + RDOs): efetivo e horas, atividades, ocorrências, clima, fotos e avanço. */
  async reportOf(companyId: number, row: Prisma.Commercial_MeasurementGetPayload<object>) {
    const contract = await this.prisma.commercial_Contract.findUniqueOrThrow({
      where: { id: row.contractId }, include: { customer: { select: { name: true, corporateName: true, cnpj: true } } },
    });
    const plan = planOf(contract.measurementPlan);
    const order = await this.prisma.service_Order.findUnique({ where: { contractId: contract.id }, select: { id: true, number: true, location: true } });
    const start = iso(row.periodStart), end = iso(row.periodEnd);
    const reports = order && start && end ? await this.prisma.service_DailyReport.findMany({
      where: { orderId: order.id, status: 'fechado', date: { gte: asDate(start), lte: asDate(end) } }, orderBy: [{ date: 'asc' }, { id: 'asc' }],
    }) : [];
    const roles = new Map<string, { role: string; people: number; hours: number; overtime: number }>();
    let hours = 0, overtime = 0, hoursLost = 0;
    const occurrences: Array<{ date: string | null; type: string; description: string; hoursLost: number }> = [];
    const photos: Array<{ date: string | null; url: string; caption: string }> = [];
    const days = reports.map((r) => {
      const crew = (r.crew as unknown as CrewMember[]) ?? [];
      for (const member of crew) {
        const key = member.role || 'Equipe';
        const entry = roles.get(key) ?? { role: key, people: 0, hours: 0, overtime: 0 };
        entry.people += 1; entry.hours = round2(entry.hours + (Number(member.hours) || 0)); entry.overtime = round2(entry.overtime + (Number(member.overtime) || 0));
        roles.set(key, entry);
        hours = round2(hours + (Number(member.hours) || 0)); overtime = round2(overtime + (Number(member.overtime) || 0));
      }
      for (const o of (r.occurrences as unknown as Occurrence[]) ?? []) { occurrences.push({ date: iso(r.date), type: o.type, description: o.description, hoursLost: Number(o.hoursLost) || 0 }); hoursLost = round2(hoursLost + (Number(o.hoursLost) || 0)); }
      for (const p of (r.photos as unknown as Array<{ url: string; caption?: string }>) ?? []) if (p?.url) photos.push({ date: iso(r.date), url: p.url, caption: p.caption ?? '' });
      return { date: iso(r.date), shift: r.shift, weather: r.weather, people: crew.length, hours: round2(crew.reduce((s, m) => s + (Number(m.hours) || 0), 0)), activities: r.activities ?? '' };
    });
    const lines = (row.lines as unknown as WorkLine[]) ?? [];
    const billed = await this.prisma.commercial_Measurement.findMany({ where: { contractId: contract.id, source: 'obra', status: 'faturada', number: { lte: row.number } }, select: { lines: true } });
    const measuredToDate = round2(billed.flatMap((m) => (m.lines as unknown as WorkLine[]) ?? []).filter((l) => l.kind === 'frente').reduce((s, l) => s + l.value, 0)
      + (row.status === 'faturada' ? 0 : lines.filter((l) => l.kind === 'frente').reduce((s, l) => s + l.value, 0)));
    return {
      id: row.id, label: measurementLabel(row.number), status: row.status, periodStart: start, periodEnd: end, notes: row.notes,
      contract: { id: contract.id, number: contract.number, title: contract.title, value: Number(contract.value), customer: contract.customer, customerOrderNumber: contract.customerOrderNumber },
      plan: plan ? { mobilization: plan.mobilization, depositRate: plan.depositRate } : null,
      lines, value: Number(row.value), invoiceValue: Number(row.invoiceValue ?? row.value), depositValue: Number(row.depositValue ?? 0),
      measuredToDate, balance: round2(Number(contract.value) - measuredToDate),
      decision: row.decision, sentAt: row.sentAt, decidedAt: row.decidedAt, invoiceNumber: row.invoiceNumber,
      order: order ? { number: order.number, location: order.location } : null,
      rdo: { reports: reports.length, days, roles: [...roles.values()], hours, overtime, hoursLost, occurrences, photos: photos.slice(0, 60) },
    };
  }

  /** Relatório do boletim para a tela interna. */
  async report(actor: MeasurementActor, contractId: number, id: number) {
    await this.contractOf(actor.companyId, contractId);
    const row = await this.byId(actor.companyId, contractId, id);
    const [company, brand] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: actor.companyId }, select: { comercial_name: true } }),
      this.documents.brand(actor.companyId),
    ]);
    return { ...(await this.reportOf(actor.companyId, row)), publicKey: row.publicKey, company: { name: company?.comercial_name ?? '', logoUrl: brand.logoUrl, color: brand.color } };
  }

  private async byKey(key: string) {
    const row = await this.prisma.commercial_Measurement.findUnique({ where: { publicKey: String(key ?? '').slice(0, 40) } });
    if (!row || row.source !== 'obra') throw new NotFoundException('Boletim de medição não encontrado');
    return row;
  }

  /** O que o cliente vê pelo link: o boletim, o relatório do período e se pode decidir. */
  async publicView(key: string) {
    const row = await this.byKey(key);
    const [company, brand] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: row.companyId }, select: { comercial_name: true } }),
      this.documents.brand(row.companyId),
    ]);
    const report = await this.reportOf(row.companyId, row);
    const { contract, ...rest } = report;
    return {
      company: { name: company?.comercial_name ?? '', logoUrl: brand.logoUrl, color: brand.color },
      ...rest, contract: { number: contract.number, title: contract.title, value: contract.value, customer: { name: contract.customer.name } },
      canDecide: row.status === 'enviada',
    };
  }

  /** O cliente aprova ou contesta pelo link (nome, cargo, nota, IP e navegador ficam como evidência). */
  async decide(key: string, body: Body, meta: { ip: string | null; userAgent: string | null }) {
    const row = await this.byKey(key);
    if (row.status !== 'enviada') {
      if (row.status === 'aprovada' || row.status === 'faturada') throw new ConflictException('Este boletim já foi aprovado.');
      throw new GoneException('Este boletim não está mais aguardando aprovação.');
    }
    const decision = body.decision === 'contestar' ? 'contestada' : body.decision === 'aprovar' ? 'aprovada' : null;
    if (!decision) throw new BadRequestException('Escolha aprovar ou contestar');
    const name = clean(body.name, 160);
    if (name.length < 3) throw new BadRequestException('Informe o seu nome');
    const note = clean(body.note, 1000);
    if (decision === 'contestada' && note.length < 5) throw new BadRequestException('Explique o que precisa ser revisto');
    const changed = await this.prisma.commercial_Measurement.updateMany({ where: { id: row.id, status: 'enviada' }, data: {
      status: decision, decidedAt: new Date(),
      decision: { decision, manual: false, name, role: clean(body.role, 120) || null, note: note || null, ip: meta.ip, userAgent: meta.userAgent, at: new Date().toISOString() },
    } });
    if (!changed.count) throw new ConflictException('Este boletim mudou: recarregue a página');
    return this.publicView(key);
  }
}

const br = (value: string | null) => (value ? value.split('-').reverse().join('/') : '');
