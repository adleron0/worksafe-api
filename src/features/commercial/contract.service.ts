import { entityFilter } from 'src/features/company-entity/entity.field';
import { rentalsFromContract } from 'src/features/stock/rental.service';
import { SellerWalletService } from './wallet.service';
import { MeasurementService, commissionFor } from './measurement.service';
import { contractPlanOf, parsePlan } from './measurement.plan';
import { netWith, parseRates, parseRetentions, ratesOf, writeRetentions } from 'src/features/financial/retention.service';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommercialContractStatus, Prisma, financialRecordsStatus, paymentMethods } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { assertNoAuthorizedInvoice, attachToInvoice, coverageInvoice } from 'src/features/fiscal/fiscal.guards';
import { CacheService } from 'src/common/cache/cache.service';
import { classificationDefaults } from 'src/features/financial/classification';
import { installmentValues } from './installments';
import { addDeposit, assertDepositOpen, depositOf, removeDeposit } from './deposit';
import { WorkProgress, workProgressOf, workStateOf } from './work-progress';
import { ownProposalIds } from './ownership';
import { ServiceOrderService } from 'src/features/operations/service-order.service';

type Body = Record<string, any>;
type Tx = Prisma.TransactionClient;
export interface ContractActor { userId: number; companyId: number; seesAll?: boolean }

/** Dinheiro que já entrou. */
const PAID: financialRecordsStatus[] = ['received'];
const STATUSES: CommercialContractStatus[] = ['vigente', 'concluido', 'cancelado'];
const METHODS: paymentMethods[] = ['boleto', 'pix', 'transferencia', 'cartaoCredito', 'dinheiro', 'outro'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
/** Data sem hora gravada ao meio-dia UTC: não muda de dia em nenhum fuso do Brasil. */
const noonUtc = (value: string) => new Date(`${value}T12:00:00.000Z`);
const addDays = (value: string, days: number) => { const d = asDate(value); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
function dateOf(value: unknown, label: string): string {
  const out = String(value ?? '').slice(0, 10);
  // 31 de fevereiro "vira" março no JavaScript: só vale a data que volta igual
  if (!DATE.test(out) || Number.isNaN(asDate(out).getTime()) || asDate(out).toISOString().slice(0, 10) !== out) throw new BadRequestException(`${label}: data inválida`);
  return out;
}

/** Pedido de compra do cliente, como a tela lê. */
const customerOrderOf = (row: { customerOrderNumber: string | null; customerOrderDate: Date | null; customerOrderUrl: string | null; customerOrderFileName: string | null }) => ({
  number: row.customerOrderNumber, date: iso(row.customerOrderDate), fileUrl: row.customerOrderUrl, fileName: row.customerOrderFileName,
});

interface ClassSlot { courseId: number | null; description: string; quantity: number; students: number | null; workload: number | null; dates: string; location: string; classIds: number[] }

const FULL = {
  installments: { orderBy: { number: 'asc' as const } },
  customer: { select: { id: true, name: true, corporateName: true, cnpj: true, email: true, phone: true } },
};
type ContractRow = Prisma.Commercial_ContractGetPayload<{ include: typeof FULL }>;

@Injectable()
export class ContractService {
  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService, private readonly wallet: SellerWalletService,
    private readonly orders: ServiceOrderService, private readonly measurements: MeasurementService) {}

  // ------------------------------------------------------------------ criação

  /**
   * Contrato de uma proposta aceita: copia o documento congelado, o valor, as
   * parcelas previstas e os itens de treinamento. Chamar duas vezes devolve o
   * mesmo contrato.
   */
  async createFromProposal(tx: Tx, proposalId: number, signer: Record<string, unknown>, customerOrder: Prisma.Commercial_ContractUncheckedUpdateInput = {}): Promise<{ id: number; number: string }> {
    const existing = await tx.commercial_Contract.findUnique({ where: { proposalId }, select: { id: true, number: true } });
    if (existing) return existing;
    const proposal = await tx.commercial_Proposal.findUniqueOrThrow({
      where: { id: proposalId },
      include: { installments: { orderBy: [{ order: 'asc' }, { id: 'asc' }] }, items: { where: { type: 'treinamento' }, orderBy: [{ order: 'asc' }, { id: 'asc' }] } },
    });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(740117::int, ${proposal.companyId}::int)`;
    const again = await tx.commercial_Contract.findUnique({ where: { proposalId }, select: { id: true, number: true } });
    if (again) return again;

    const acceptedAt = proposal.decidedAt ?? new Date();
    const year = acceptedAt.getFullYear();
    const last = await tx.commercial_Contract.aggregate({ where: { companyId: proposal.companyId, year }, _max: { sequence: true } });
    const sequence = (last._max.sequence ?? 0) + 1;
    const total = Number(proposal.total);
    const plan = proposal.installments.map((inst) => ({ percent: inst.percent === null ? null : Number(inst.percent), amount: inst.amount === null ? null : Number(inst.amount) }));
    const values = installmentValues(total, plan);
    // serviço por medição de obra: o plano (frentes, mobilização, caução) em reais, sem parcelas
    const workPlan = proposal.kind === 'servico' ? parsePlan(proposal.measurement, proposal.schedule) : null;
    const classes: ClassSlot[] = proposal.items.map((item) => {
      const extra = (item.extra ?? {}) as Record<string, any>;
      return {
        courseId: item.courseId, description: item.description, quantity: Number(item.quantity), students: extra.students ?? null,
        workload: extra.workload ?? null, dates: extra.dates ?? '', location: extra.location ?? '', classIds: [],
      };
    });
    const created = await tx.commercial_Contract.create({ data: {
      companyId: proposal.companyId, number: `CT-${year}-${String(sequence).padStart(4, '0')}`, year, sequence,
      proposalId, customerId: proposal.customerId, kind: proposal.kind, title: proposal.title, value: total, acceptedAt,
      documentHtml: proposal.frozenHtml, documentHash: proposal.frozenHash, signer: signer as Prisma.InputJsonValue,
      sellerId: proposal.sellerId, classes: classes as unknown as Prisma.InputJsonValue,
      // locação é cobrada por medição (cada período vencido), não pelas parcelas da proposta
      billingMode: proposal.kind === 'locacao' ? 'periodo' : workPlan ? 'medicao' : 'parcelas',
      measurementPlan: workPlan ? (contractPlanOf(workPlan, total) as unknown as Prisma.InputJsonValue) : undefined,
      // caução contratual das parcelas (a medição de obra antiga leva a dela no plano)
      ...(proposal.kind === 'servico' && !workPlan ? { depositRate: proposal.depositRate, depositReleaseDays: proposal.depositReleaseDays } : {}),
      // o pedido do cliente pode vir junto com o aceite
      ...(customerOrder as Pick<Prisma.Commercial_ContractUncheckedCreateInput, 'customerOrderNumber' | 'customerOrderDate'>),
      installments: { create: (proposal.kind === 'locacao' || workPlan ? [] : proposal.installments).map((inst, index) => ({
        companyId: proposal.companyId, number: index + 1, total: proposal.installments.length, description: inst.description,
        value: values[index], dueRule: inst.dueRule, dueDate: inst.dueDate, dueDays: inst.dueDays, workPercent: inst.workPercent,
      })) },
    } });
    // venda de serviço abre a ordem de serviço da operação
    await this.orders.createFromContract(tx, created.id, Number(signer.userId) || null);
    // venda de locação: nasce a Ordem de Locação (OL) a entregar, ligada à venda
    await rentalsFromContract(tx, created.id);
    return { id: created.id, number: created.number };
  }

  /** Propostas aceitas antes de existir contrato ganham o seu na primeira abertura da tela. */
  private async backfill(companyId: number): Promise<void> {
    const contracted = (await this.prisma.commercial_Contract.findMany({ where: { companyId }, select: { proposalId: true } })).map((c) => c.proposalId);
    const pending = await this.prisma.commercial_Proposal.findMany({ where: { companyId, status: 'aceita', id: { notIn: contracted } }, select: { id: true, statusNote: true } });
    for (const proposal of pending) {
      const event = await this.prisma.commercial_ProposalEvent.findFirst({ where: { proposalId: proposal.id, type: 'aceita' }, orderBy: { id: 'desc' } });
      await this.prisma.$transaction((tx) => this.createFromProposal(tx, proposal.id, event
        ? { name: event.name, cpf: event.cpf, role: event.role, email: event.email, ip: event.ip, userAgent: event.userAgent, at: event.createdAt, codeVerified: event.codeVerified, manual: !event.ip, note: event.note }
        : { manual: true, note: proposal.statusNote }));
    }
  }

  // ------------------------------------------------------------------ leitura

  private async byId(companyId: number, id: number): Promise<ContractRow> {
    const row = await this.prisma.commercial_Contract.findFirst({ where: { id, companyId }, include: FULL });
    if (!row) throw new NotFoundException('Contrato não encontrado');
    return row;
  }

  /** Quanto do contrato já virou conta a receber e quanto já entrou. */
  private async billing(contractIds: number[]) {
    const records = contractIds.length ? await this.prisma.financialRecords.findMany({
      where: { contractId: { in: contractIds }, inactiveAt: null },
      select: { id: true, contractId: true, contractInstallmentId: true, value: true, netValue: true, status: true, dueDate: true, paidAt: true, invoiceNumber: true, invoiceIssuedAt: true, receivedValue: true, invoiceUrl: true },
    }) : [];
    const by = new Map<number, { billed: number; received: number; records: typeof records }>();
    for (const record of records) {
      const entry = by.get(record.contractId!) ?? { billed: 0, received: 0, records: [] };
      entry.billed += Number(record.value ?? 0);
      if (PAID.includes(record.status)) entry.received += Number(record.receivedValue ?? record.value ?? 0);
      entry.records.push(record);
      by.set(record.contractId!, entry);
    }
    return by;
  }

  async list(actor: ContractActor, query: Record<string, string>) {
    await this.backfill(actor.companyId);
    // sem a permissão de ver todas, só as vendas das propostas da pessoa
    const own = await ownProposalIds(this.prisma, { ...actor, seesAll: actor.seesAll !== false });
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const term = clean(query.search, 80);
    const status = STATUSES.includes(query.status as CommercialContractStatus) ? (query.status as CommercialContractStatus) : undefined;
    const scope: Prisma.Commercial_ContractWhereInput = {
      companyId: actor.companyId, inactiveAt: null, ...(own ? { proposalId: { in: own } } : {}),
      ...(Number(query.customerId) > 0 ? { customerId: Number(query.customerId) } : {}),
      ...entityFilter(query.entityId),
      ...(term ? { OR: [
        { number: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } },
        { customer: { name: { contains: term, mode: 'insensitive' } } }, { customer: { corporateName: { contains: term, mode: 'insensitive' } } },
      ] } : {}),
    };
    const where = { ...scope, ...(status ? { status } : {}) };
    const [rows, total, groups] = await Promise.all([
      this.prisma.commercial_Contract.findMany({
        where, orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }], skip: page * limit, take: limit,
        select: { id: true, number: true, kind: true, entityId: true, status: true, title: true, value: true, acceptedAt: true, proposalId: true, customer: { select: { id: true, name: true } },
          _count: { select: { installments: true } } },
      }),
      this.prisma.commercial_Contract.count({ where }),
      this.prisma.commercial_Contract.groupBy({ by: ['status'], where: scope, _count: { _all: true }, _sum: { value: true } }),
    ]);
    const billing = await this.billing(rows.map((row) => row.id));
    return {
      total,
      rows: rows.map(({ _count, ...row }) => {
        const b = billing.get(row.id);
        const value = Number(row.value);
        return { ...row, value, installments: _count.installments, billed: round2(b?.billed ?? 0), received: round2(b?.received ?? 0), toBill: round2(value - (b?.billed ?? 0)) };
      }),
      summary: Object.fromEntries(groups.map((g) => [g.status, { count: g._count._all, total: Number(g._sum.value ?? 0) }])),
    };
  }

  /** Vencimento sugerido da parcela, a partir da regra combinada na proposta. */
  private suggestedDue(installment: ContractRow['installments'][number], contract: ContractRow, invoiceDate: string): string {
    if (installment.dueRule === 'data_fixa' && installment.dueDate) return iso(installment.dueDate)!;
    // % da obra: a data é a que for combinada com o cliente ao medir; sugere a da nota
    if (installment.dueRule === 'percentual_obra') return invoiceDate;
    const days = installment.dueDays ?? 0;
    const base = installment.dueRule === 'dias_apos_aceite' ? iso(contract.acceptedAt)!
      : installment.dueRule === 'dias_apos_conclusao' ? iso(contract.endDate) ?? invoiceDate
        : invoiceDate;
    const due = addDays(base, days);
    // vencimento antes da nota não faz sentido: no mínimo, a data da nota
    return due < invoiceDate ? invoiceDate : due;
  }

  /** Avanço da obra dos contratos de serviço, com os marcos das parcelas por % da obra. */
  private progressOf(rows: ContractRow[]): Promise<Map<number, WorkProgress>> {
    const servico = rows.filter((row) => row.kind === 'servico');
    const marks = new Map(servico.map((row) => [row.id, row.installments.filter((i) => i.dueRule === 'percentual_obra').map((i) => Number(i.workPercent ?? 0))]));
    return workProgressOf(this.prisma, servico.map((row) => row.id), marks);
  }

  private async present(row: ContractRow) {
    const [billing, proposal, classRows, rentals, measurements, works, progress] = await Promise.all([
      this.billing([row.id]),
      this.prisma.commercial_Proposal.findUnique({ where: { id: row.proposalId }, select: { id: true, number: true, schedule: true } }),
      this.classesOf(row),
      this.measurements.rentalsOf(row.companyId, row.id),
      this.measurements.ofContract(row.id),
      this.measurements.worksOf(row),
      this.progressOf([row]),
    ]);
    const work = progress.get(row.id);
    const b = billing.get(row.id);
    const recordOf = new Map((b?.records ?? []).map((record) => [record.id, record]));
    const value = Number(row.value);
    const classById = new Map(classRows.map((c) => [c.id, c]));
    return {
      id: row.id, number: row.number, kind: row.kind, entityId: row.entityId, status: row.status, title: row.title, value, acceptedAt: row.acceptedAt,
      startDate: iso(row.startDate), endDate: iso(row.endDate), notes: row.notes, statusNote: row.statusNote,
      customerOrder: customerOrderOf(row), serviceOrder: await this.orders.ofContract(row.id),
      customer: row.customer, proposal: proposal ? { id: proposal.id, number: proposal.number } : null,
      scheduleSteps: (((proposal?.schedule ?? null) as { steps?: Array<{ title: string; duration: number }> } | null)?.steps ?? []).map((step) => ({ title: step.title, duration: Number(step.duration) || 1 })),
      documentHash: row.documentHash, hasDocument: Boolean(row.documentHtml), signer: row.signer,
      billed: round2(b?.billed ?? 0), received: round2(b?.received ?? 0),
      toBill: row.billingMode === 'periodo' ? round2(rentals.reduce((sum, r) => sum + r.value, 0)) : works ? works.summary.balance : round2(value - (b?.billed ?? 0)),
      billingMode: row.billingMode,
      // medição de obra: o plano (frentes, mobilização, caução), os boletins e o resumo
      measurementPlan: row.measurementPlan, works,
      retentionRates: ratesOf(row.retentionRates),
      // avanço da obra (RDO fechado) e caução das parcelas
      workProgress: row.kind === 'servico' ? { percent: work?.percent ?? null, date: work?.date ?? null } : null,
      deposit: Number(row.depositRate) > 0 ? { rate: Number(row.depositRate), releaseDays: row.depositReleaseDays } : null,
      // locação: as ordens de locação, o que cada uma tem para faturar agora e as medições já faturadas
      rentals: rentals.map(({ rental, pending, value: pendingValue, open }) => ({
        id: rental.id, number: rental.number, status: rental.status, startDate: iso(rental.startDate), expectedEnd: iso(rental.expectedEnd), returnedAt: iso(rental.returnedAt),
        billing: rental.billing, period: rental.period, billedUntil: iso(rental.billedUntil), pending, pendingValue, openPeriod: open,
        ratePerPeriod: round2(rental.lines.reduce((sum, l) => sum + Number(l.rate) * Number(l.quantity), 0)),
      })),
      measurements,
      installments: row.installments.map((inst) => {
        const record = inst.financialRecordId ? recordOf.get(inst.financialRecordId) : undefined;
        return {
          id: inst.id, number: inst.number, total: inst.total, description: inst.description, value: Number(inst.value),
          dueRule: inst.dueRule, dueDate: iso(inst.dueDate), dueDays: inst.dueDays, suggestedDue: this.suggestedDue(inst, row, today()),
          ...(inst.dueRule === 'percentual_obra' ? { work: workStateOf(work, Number(inst.workPercent ?? 0)) } : {}),
          depositValue: inst.depositValue === null ? (record ? null : depositOf(row, Number(inst.value)) || null) : Number(inst.depositValue),
          record: record ? {
            id: record.id, status: record.status, dueDate: iso(record.dueDate), paidAt: record.paidAt, invoiceNumber: record.invoiceNumber,
            invoiceIssuedAt: iso(record.invoiceIssuedAt), hasInvoiceFile: Boolean(record.invoiceUrl), paid: PAID.includes(record.status),
            netValue: record.netValue === null ? null : Number(record.netValue),
          } : null,
        };
      }),
      classes: ((row.classes as unknown as ClassSlot[]) ?? []).map((slot, index) => ({
        index, ...slot, classes: (slot.classIds ?? []).map((id) => classById.get(id)).filter(Boolean),
      })),
      // turmas ligadas à venda pela própria turma (venda rápida, "ligar a uma venda") que não ocupam um item
      otherClasses: classRows.filter((c) => !((row.classes as unknown as ClassSlot[]) ?? []).some((slot) => (slot.classIds ?? []).includes(c.id))),
    };
  }

  private async classesOf(row: ContractRow) {
    const linked = await this.prisma.commercial_ClassBilling.findMany({ where: { contractId: row.id, mode: 'contrato' }, select: { classId: true } });
    const ids = [...new Set([...((row.classes as unknown as ClassSlot[]) ?? []).flatMap((slot) => slot.classIds ?? []), ...linked.map((l) => l.classId)])];
    if (!ids.length) return [];
    return this.prisma.courseClass.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, initialDate: true, inactiveAt: true }, orderBy: { id: 'asc' } });
  }

  async get(actor: ContractActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    const own = await ownProposalIds(this.prisma, { ...actor, seesAll: actor.seesAll !== false });
    if (own && !own.includes(row.proposalId)) throw new NotFoundException('Contrato não encontrado');
    return this.present(row);
  }

  async document(actor: ContractActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    if (!row.documentHtml) throw new NotFoundException('Este contrato não tem documento: o aceite foi registrado sem envio pelo sistema');
    return { html: row.documentHtml, hash: row.documentHash };
  }

  /** Contrato de uma proposta (para a tela da proposta mostrar o link). */
  async ofProposal(companyId: number, proposalId: number) {
    const row = await this.prisma.commercial_Contract.findFirst({
      where: { companyId, proposalId },
      select: { id: true, number: true, status: true, customerOrderNumber: true, customerOrderDate: true, customerOrderUrl: true, customerOrderFileName: true },
    });
    return row ? { id: row.id, number: row.number, status: row.status, customerOrder: customerOrderOf(row), serviceOrder: await this.orders.ofContract(row.id) } : null;
  }

  // ------------------------------------------------------------------ pedido do cliente

  /**
   * Pedido de compra do cliente: número, data e arquivo. É o que confirma o
   * aceite na maioria das vendas e o que o financeiro cita na nota fiscal.
   */
  async setCustomerOrder(actor: ContractActor, id: number, body: Body, file?: { location?: string; originalname?: string }) {
    await this.byId(actor.companyId, id);
    await this.prisma.commercial_Contract.update({ where: { id }, data: this.customerOrderData(body, file) });
    // com o pedido em mãos, a ordem de serviço que esperava por ele segue para a mobilização
    await this.orders.onCustomerOrder(id, actor.userId);
    return this.get(actor, id);
  }

  /** Campos do pedido do cliente a gravar: só o que veio no corpo muda. */
  customerOrderData(body: Body, file?: { location?: string; originalname?: string }): Prisma.Commercial_ContractUncheckedUpdateInput {
    const data: Prisma.Commercial_ContractUncheckedUpdateInput = {};
    if ('number' in body) data.customerOrderNumber = clean(body.number, 60) || null;
    if ('date' in body) data.customerOrderDate = blank(body.date) ? null : asDate(dateOf(body.date, 'Data do pedido'));
    if (file?.location) {
      data.customerOrderUrl = file.location;
      data.customerOrderFileName = clean(file.originalname, 200) || 'pedido';
    } else if (body.removeFile === true || body.removeFile === 'true') {
      data.customerOrderUrl = null;
      data.customerOrderFileName = null;
    }
    return data;
  }

  // ------------------------------------------------------------------ fila de faturamento

  /**
   * "A faturar": as parcelas de todas as vendas fechadas, na etapa em que estão.
   * aguardando = a condição combinada ainda não aconteceu (conclusão do serviço);
   * liberada = já pode emitir a nota; faturada = virou conta a receber; recebida = paga.
   */
  async billingQueue(actor: ContractActor, query: Record<string, string>) {
    await this.backfill(actor.companyId);
    const term = clean(query.search, 80);
    const recentDays = Math.min(365, Math.max(1, Number(query.recentDays) || 45));
    const contracts = await this.prisma.commercial_Contract.findMany({
      where: {
        companyId: actor.companyId, inactiveAt: null, status: { not: 'cancelado' },
        ...(['servico', 'treinamento', 'locacao'].includes(query.kind) ? { kind: query.kind as ContractRow['kind'] } : {}),
        ...(term ? { OR: [
          { number: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } }, { customerOrderNumber: { contains: term, mode: 'insensitive' } },
          { customer: { name: { contains: term, mode: 'insensitive' } } }, { customer: { corporateName: { contains: term, mode: 'insensitive' } } },
        ] } : {}),
      },
      include: FULL, orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }], take: 500,
    });
    const [billing, proposals] = await Promise.all([
      this.billing(contracts.map((contract) => contract.id)),
      this.prisma.commercial_Proposal.findMany({ where: { id: { in: contracts.map((contract) => contract.proposalId) } }, select: { id: true, number: true } }),
    ]);
    const proposalOf = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const progress = await this.progressOf(contracts);
    const since = new Date(Date.now() - recentDays * 86400000);
    const rows = contracts.flatMap((contract) => {
      const recordOf = new Map((billing.get(contract.id)?.records ?? []).map((record) => [record.id, record]));
      return contract.installments.flatMap((inst) => {
        const record = inst.financialRecordId ? recordOf.get(inst.financialRecordId) : undefined;
        const paid = Boolean(record && PAID.includes(record.status));
        // recebidas antigas saem do quadro: ficam em Contas a Receber
        if (paid && record!.paidAt && record!.paidAt < since) return [];
        const waitsEnd = inst.dueRule === 'dias_apos_conclusao' && !contract.endDate && contract.status !== 'concluido';
        // % da obra: fica "aguardando" até o RDO fechado cruzar o marco (dá para faturar antes, se o cliente pedir)
        const work = inst.dueRule === 'percentual_obra' ? workStateOf(progress.get(contract.id), Number(inst.workPercent ?? 0)) : null;
        const waitsWork = Boolean(work && !work.reached && contract.status !== 'concluido');
        const stage = paid ? 'recebida' : record ? 'faturada' : waitsEnd || waitsWork ? 'aguardando' : 'liberada';
        const pctBr = (value: number) => `${String(Math.round(value * 100) / 100).replace('.', ',')}%`;
        return [{
          source: 'parcela', id: inst.id, stage, contractId: contract.id, contractNumber: contract.number, contractStatus: contract.status, kind: contract.kind, title: contract.title,
          proposal: proposalOf.get(contract.proposalId) ?? null, customer: { id: contract.customer.id, name: contract.customer.name },
          number: inst.number, total: inst.total, description: inst.description, value: Number(inst.value),
          dueRule: inst.dueRule, dueDate: iso(inst.dueDate), dueDays: inst.dueDays, suggestedDue: this.suggestedDue(inst, contract, today()),
          waitingFor: waitsEnd ? 'a conclusão do serviço'
            : waitsWork ? `a obra chegar a ${pctBr(work!.workPercent)} (${work!.workProgress === null ? 'sem RDO fechado' : `agora em ${pctBr(work!.workProgress)}`})` : null,
          ...(work ? { work } : {}), depositValue: inst.depositValue === null ? depositOf(contract, Number(inst.value)) || null : Number(inst.depositValue),
          customerOrder: customerOrderOf(contract), retentionRates: ratesOf(contract.retentionRates),
          record: record ? {
            id: record.id, status: record.status, dueDate: iso(record.dueDate), paidAt: record.paidAt, invoiceNumber: record.invoiceNumber,
            invoiceIssuedAt: iso(record.invoiceIssuedAt), hasInvoiceFile: Boolean(record.invoiceUrl), paid,
          } : null,
        }];
      });
    });
    // locação (cobrança por período): uma linha por OL com o que fechou (a faturar) ou o período em curso
    // (aguardando), e uma por medição já faturada
    const measured: typeof rows = [];
    for (const contract of contracts.filter((c) => c.billingMode === 'medicao')) {
      const works = await this.measurements.worksOf(contract);
      const base = {
        contractId: contract.id, contractNumber: contract.number, contractStatus: contract.status, kind: contract.kind, title: contract.title,
        proposal: proposalOf.get(contract.proposalId) ?? null, customer: { id: contract.customer.id, name: contract.customer.name }, customerOrder: customerOrderOf(contract),
        retentionRates: ratesOf(contract.retentionRates), number: 1, total: 1, dueRule: 'dias_apos_nf' as ContractRow['installments'][number]['dueRule'], dueDate: null, dueDays: 30,
        suggestedDue: addDays(today(), 30), source: 'obra', rental: null,
      };
      const WAIT: Record<string, string> = { rascunho: 'o envio do boletim ao cliente', enviada: 'a aprovação do cliente', contestada: 'a revisão do boletim (contestado pelo cliente)' };
      for (const m of works?.measurements ?? []) {
        const period = m.periodStart ? ` · ${m.periodStart.split('-').reverse().join('/')} a ${m.periodEnd!.split('-').reverse().join('/')}` : '';
        if (m.status !== 'faturada') {
          measured.push({ ...base, id: `bw-${m.id}` as unknown as number, stage: m.status === 'aprovada' ? 'liberada' : 'aguardando', description: `${m.label} (medição de obra)${period}`,
            value: m.value, waitingFor: WAIT[m.status] ?? null, record: null, measurementId: m.id, lines: m.lines, invoiceValue: m.invoiceValue, depositValue: m.depositValue, measurementStatus: m.status } as never);
          continue;
        }
        if (!m.record || (m.record.paid && m.record.paidAt && m.record.paidAt < since)) continue;
        measured.push({ ...base, id: `bm-${m.id}` as unknown as number, stage: m.record.paid ? 'recebida' : 'faturada', description: `${m.label} (medição de obra)${period}`,
          value: m.value, waitingFor: null, record: m.record, measurementId: m.id, lines: m.lines, invoiceValue: m.invoiceValue, depositValue: m.depositValue, measurementStatus: m.status } as never);
      }
    }
    for (const contract of contracts.filter((c) => c.billingMode === 'periodo')) {
      const base = {
        contractId: contract.id, contractNumber: contract.number, contractStatus: contract.status, kind: contract.kind, title: contract.title,
        proposal: proposalOf.get(contract.proposalId) ?? null, customer: { id: contract.customer.id, name: contract.customer.name }, customerOrder: customerOrderOf(contract),
        retentionRates: ratesOf(contract.retentionRates), number: 1, total: 1, dueRule: 'dias_apos_nf' as ContractRow['installments'][number]['dueRule'], dueDate: null, dueDays: 7, suggestedDue: addDays(today(), 7),
      };
      for (const { rental, pending, value, open } of await this.measurements.rentalsOf(actor.companyId, contract.id)) {
        if (pending.length) {
          measured.push({ ...base, id: `ol-${rental.id}` as unknown as number, stage: 'liberada', description: `${rental.number}: ${pending.map((l) => l.description).join('; ')}`, value, waitingFor: null, record: null,
            source: 'medicao', rental: { id: rental.id, number: rental.number }, lines: pending } as never);
        } else if (open && contract.status === 'vigente') {
          const rate = round2(rental.lines.reduce((sum, l) => sum + Number(l.rate) * Number(l.quantity), 0));
          measured.push({ ...base, id: `op-${rental.id}` as unknown as number, stage: 'aguardando', description: `${rental.number}: aluguel de ${open.start.split('-').reverse().join('/')} a ${open.end.split('-').reverse().join('/')}`, value: rate,
            waitingFor: `o fim do período em ${open.end.split('-').reverse().join('/')}`, record: null, source: 'medicao', rental: { id: rental.id, number: rental.number }, lines: [] } as never);
        }
      }
      for (const m of await this.measurements.ofContract(contract.id)) {
        if (m.record?.paid && m.record.paidAt && m.record.paidAt < since) continue;
        if (!m.record) continue;
        measured.push({ ...base, id: `bm-${m.id}` as unknown as number, stage: m.record.paid ? 'recebida' : 'faturada', description: `${m.label}${m.rentalNumber ? ` · ${m.rentalNumber}` : ''}${m.periodStart ? ` · ${m.periodStart.split('-').reverse().join('/')} a ${m.periodEnd!.split('-').reverse().join('/')}` : ''}`,
          value: m.value, waitingFor: null, record: m.record, source: 'medicao', measurementId: m.id, rental: m.rentalId ? { id: m.rentalId, number: m.rentalNumber } : null, lines: m.lines } as never);
      }
    }
    rows.push(...measured);
    const summary: Record<string, { count: number; total: number }> = {};
    for (const stage of ['aguardando', 'liberada', 'faturada', 'recebida']) summary[stage] = { count: 0, total: 0 };
    for (const row of rows) { summary[row.stage].count += 1; summary[row.stage].total = round2(summary[row.stage].total + row.value); }
    return { rows, summary, recentDays };
  }

  // ------------------------------------------------------------------ alteração

  async update(actor: ContractActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    const startDate = 'startDate' in body ? (blank(body.startDate) ? null : dateOf(body.startDate, 'Início')) : iso(row.startDate);
    const endDate = 'endDate' in body ? (blank(body.endDate) ? null : dateOf(body.endDate, 'Conclusão')) : iso(row.endDate);
    if (startDate && endDate && endDate < startDate) throw new BadRequestException('A conclusão não pode ser antes do início');
    await this.prisma.commercial_Contract.update({ where: { id }, data: {
      startDate: startDate ? asDate(startDate) : null, endDate: endDate ? asDate(endDate) : null,
      ...('notes' in body ? { notes: String(body.notes ?? '').trim().slice(0, 5000) || null } : {}),
    } });
    return this.get(actor, id);
  }

  async setStatus(actor: ContractActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    const target = String(body.status) as CommercialContractStatus;
    if (!STATUSES.includes(target)) throw new BadRequestException('Situação inválida');
    if (target === row.status) return this.get(actor, id);
    if (target === 'cancelado') {
      const open = await this.prisma.financialRecords.count({ where: { contractId: id, inactiveAt: null, status: { notIn: [...PAID, 'cancelled'] } } });
      if (open > 0) throw new ConflictException(`Há ${open} conta(s) a receber em aberto deste contrato: desfaça o faturamento ou dê baixa antes de cancelar`);
    }
    await this.prisma.commercial_Contract.update({ where: { id }, data: { status: target, statusNote: clean(body.note, 500) || null } });
    return this.get(actor, id);
  }

  // ------------------------------------------------------------------ faturamento

  /**
   * Registra a nota fiscal de uma parcela: ela vira conta a receber (baixa
   * manual), já com cliente, valor, vencimento, NF, parcela e contrato.
   */
  async bill(actor: ContractActor, id: number, installmentId: number, body: Body) {
    return this.billMany(actor, id, { ...body, installmentIds: [installmentId], dueDates: blank(body.dueDate) ? undefined : { [installmentId]: body.dueDate } });
  }

  /**
   * Uma nota fiscal para uma ou várias parcelas (NF global): cada parcela vira
   * a sua conta a receber, com o vencimento próprio, todas com o mesmo número de
   * nota. As retenções de imposto informadas valem para a nota inteira e são
   * rateadas entre as parcelas pelo valor de cada uma.
   */
  async billMany(actor: ContractActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    if (row.status !== 'vigente') throw new ConflictException(`Contrato ${row.status}: não recebe faturamento novo`);
    const ids = [...new Set((Array.isArray(body.installmentIds) ? body.installmentIds : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[];
    if (!ids.length) throw new BadRequestException('Escolha as parcelas da nota');
    const chosen = ids.map((installmentId) => {
      const installment = row.installments.find((inst) => inst.id === installmentId);
      if (!installment) throw new NotFoundException('Parcela não encontrada');
      if (installment.financialRecordId) throw new ConflictException(`A parcela ${installment.number}/${installment.total} já foi faturada`);
      return installment;
    }).sort((a, b) => a.number - b.number);
    // "usar nota já emitida": uma nota do contrato inteiro (ou do saldo) cobre estas parcelas
    const values0 = chosen.map((inst) => Number(inst.value));
    const covering = blank(body.fiscalInvoiceId) ? null : await coverageInvoice(this.prisma, actor.companyId, id, Number(body.fiscalInvoiceId), round2(values0.reduce((s, v) => s + v, 0)));
    if (covering) { body = { ...body, invoiceNumber: covering.number, invoiceIssuedAt: covering.issuedAt ?? body.invoiceIssuedAt }; }
    const invoiceNumber = clean(body.invoiceNumber, 60);
    if (!invoiceNumber) throw new BadRequestException('Informe o número da nota fiscal');
    const invoiceDate = blank(body.invoiceIssuedAt) ? today() : dateOf(body.invoiceIssuedAt, 'Data da nota');
    if (invoiceDate > today()) throw new BadRequestException('A data da nota não pode ser futura');
    const dueDates = (body.dueDates && typeof body.dueDates === 'object' ? body.dueDates : {}) as Record<string, unknown>;
    const values = chosen.map((inst) => Number(inst.value));
    const invoiceTotal = round2(values.reduce((sum, v) => sum + v, 0));
    const retentions = parseRetentions(body.retentions, invoiceTotal);
    const netRaw = blank(body.netValue) ? null : Number(String(body.netValue).replace(',', '.'));
    if (chosen.length === 1 && netRaw !== null && (!Number.isFinite(netRaw) || netRaw <= 0 || netRaw > invoiceTotal)) throw new BadRequestException('Valor líquido deve ficar entre zero e o valor da parcela');
    // retenção da nota rateada pelas parcelas (a última fecha os centavos)
    const shares = chosen.map((_, index) => retentions.map((r) => {
      if (index < chosen.length - 1) return { ...r, value: round2((r.value * values[index]) / invoiceTotal) };
      const before = chosen.slice(0, -1).reduce((sum, __, i) => sum + round2((r.value * values[i]) / invoiceTotal), 0);
      return { ...r, value: round2(r.value - before) };
    }).filter((r) => r.value > 0));
    const method = METHODS.includes(body.paymentMethod) ? (body.paymentMethod as paymentMethods) : 'outro';
    const many = chosen.length > 1;
    // caução contratual: parte de cada nota fica retida na conta da caução (a receber = nota − caução)
    const deposits = values.map((value) => depositOf(row, value));
    if (chosen.length === 1 && netRaw !== null && deposits[0] > 0 && netRaw > values[0] - deposits[0]) throw new BadRequestException('Valor líquido deve ficar abaixo do valor da parcela menos a caução');

    const recordIds = await this.prisma.$transaction(async (tx) => {
      const out: number[] = [];
      for (const [index, installment] of chosen.entries()) {
        const invoiceValue = values[index];
        const deposit = deposits[index];
        const value = round2(invoiceValue - deposit);
        const dueDate = blank(dueDates[installment.id]) ? this.suggestedDue(installment, row, invoiceDate) : dateOf(dueDates[installment.id], 'Vencimento');
        const label = `${row.number} — ${installment.total > 1 ? `parcela ${installment.number}/${installment.total}` : 'pagamento único'}`;
        // trava a parcela: duas pessoas faturando a mesma não geram dois títulos
        const locked = await tx.commercial_ContractInstallment.updateMany({ where: { id: installment.id, financialRecordId: null }, data: { billedAt: new Date(), depositValue: deposit > 0 ? deposit : null } });
        if (!locked.count) throw new ConflictException('Esta parcela já foi faturada');
        const share = shares[index];
        const record = await tx.financialRecords.create({ data: {
          companyId: actor.companyId, gateway: 'manual', status: 'waiting', paymentMethod: method,
          customerId: row.customerId, sellerId: row.sellerId, value, netValue: netWith(value, share, many ? null : netRaw === null ? null : round2(netRaw)),
          // Comissão do vendedor: a parte desta parcela na comissão calculada na proposta aceita.
          ...(await commissionFor(tx, row, value)),
          dueDate: noonUtc(dueDate), accrualDate: invoiceDate.slice(0, 7),
          invoiceNumber, invoiceIssuedAt: noonUtc(invoiceDate), installmentNumber: installment.number, installmentTotal: installment.total,
          description: (!many && clean(body.description, 255)) || `${label} · ${row.title}`.slice(0, 255),
          observations: (!many && clean(body.observations, 255)) || [row.customerOrderNumber ? `Pedido do cliente ${row.customerOrderNumber}` : '', deposit > 0 ? `Nota de ${invoiceValue.toFixed(2).replace('.', ',')} com caução de ${deposit.toFixed(2).replace('.', ',')} retida` : ''].filter(Boolean).join(' · ') || null,
          contractId: id, contractInstallmentId: installment.id,
          ...(await classificationDefaults(tx, actor.companyId, 'contrato')),
        } });
        // a base da retenção é a parte desta parcela na nota
        await writeRetentions(tx, { ...record, accrualDate: invoiceDate.slice(0, 7) }, share, invoiceValue, actor.userId);
        await tx.commercial_ContractInstallment.update({ where: { id: installment.id }, data: { financialRecordId: record.id } });
        if (deposit > 0) await addDeposit(tx, row, deposit);
        out.push(record.id);
      }
      return out;
    });
    if (covering) await attachToInvoice(this.prisma, covering.id, recordIds.map((recordId, index) => ({ id: recordId, amount: values[index] })), covering.issuedAtDate);
    for (const recordId of recordIds) await this.wallet.syncRecordSafe(recordId);
    if (deposits.some((d) => d > 0)) {
      const fresh = await this.prisma.commercial_Contract.findUnique({ where: { id }, select: { depositRecordId: true } });
      if (fresh?.depositRecordId) await this.wallet.syncRecordSafe(fresh.depositRecordId);
    }
    return { ...(await this.get(actor, id)), financialRecordId: recordIds[0], financialRecordIds: recordIds };
  }

  /** Alíquotas que o cliente deste contrato costuma reter (sugeridas ao faturar). */
  async setRetentionRates(actor: ContractActor, id: number, body: Body) {
    await this.byId(actor.companyId, id);
    const rates = parseRates(body.rates);
    await this.prisma.commercial_Contract.update({ where: { id }, data: { retentionRates: rates ? (rates as Prisma.InputJsonValue) : Prisma.JsonNull } });
    return this.get(actor, id);
  }

  /** Desfaz o faturamento de uma parcela que ainda não foi paga: o título sai do Contas a Receber. */
  async unbill(actor: ContractActor, id: number, installmentId: number) {
    const row = await this.byId(actor.companyId, id);
    const installment = row.installments.find((inst) => inst.id === installmentId);
    if (!installment) throw new NotFoundException('Parcela não encontrada');
    if (!installment.financialRecordId) throw new ConflictException('Esta parcela ainda não foi faturada');
    const record = await this.prisma.financialRecords.findUnique({ where: { id: installment.financialRecordId }, select: { id: true, status: true } });
    if (record && PAID.includes(record.status)) throw new ConflictException('Esta parcela já foi paga: estorne a baixa em Contas a Receber antes de desfazer o faturamento');
    await assertNoAuthorizedInvoice(this.prisma, record?.id);
    const deposit = Number(installment.depositValue ?? 0);
    if (deposit > 0) await assertDepositOpen(this.prisma, id);
    const depositRecordId = await this.prisma.$transaction(async (tx) => {
      if (record) await tx.financialRecords.update({ where: { id: record.id }, data: { inactiveAt: new Date(), status: 'cancelled' } });
      await tx.commercial_ContractInstallment.update({ where: { id: installmentId }, data: { financialRecordId: null, billedAt: null, depositValue: null } });
      // a caução retida nesta nota volta
      return removeDeposit(tx, id, deposit);
    });
    // o título saiu do Contas a Receber: a comissão prevista dele é cancelada
    if (record) await this.wallet.syncRecordSafe(record.id);
    if (depositRecordId) await this.wallet.syncRecordSafe(depositRecordId);
    return this.get(actor, id);
  }

  // ------------------------------------------------------------------ turma fechada

  /** Cria a turma fechada (sem checkout, ligada ao cliente) de um item de treinamento do contrato. */
  async createClass(actor: ContractActor, id: number, index: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    if (row.status === 'cancelado') throw new ConflictException('Contrato cancelado');
    const slots = ((row.classes as unknown as ClassSlot[]) ?? []).map((slot) => ({ ...slot, classIds: [...(slot.classIds ?? [])] }));
    const slot = slots[index];
    if (!slot) throw new NotFoundException('Item de treinamento não encontrado no contrato');
    if (!slot.courseId) throw new BadRequestException('Este item não tem curso escolhido: crie a turma em Treinamentos → Turmas');
    if (slot.classIds.length >= Math.max(1, Math.ceil(slot.quantity))) throw new ConflictException('Todas as turmas deste item já foram criadas');
    const course = await this.prisma.course.findFirst({ where: { id: slot.courseId, companyId: actor.companyId }, select: { id: true, name: true, hoursDuration: true, gradeTheory: true, gradePracticle: true } });
    if (!course) throw new BadRequestException('Curso não encontrado');
    const initialDate = blank(body.initialDate) ? null : dateOf(body.initialDate, 'Início');
    const finalDate = blank(body.finalDate) ? initialDate : dateOf(body.finalDate, 'Término');
    if (initialDate && finalDate && finalDate < initialDate) throw new BadRequestException('O término não pode ser antes do início');
    const name = (clean(body.name, 100) || `${course.name} — ${row.customer.name}`).slice(0, 100);

    const created = await this.prisma.$transaction(async (tx) => {
      const klass = await tx.courseClass.create({ data: {
        companyId: actor.companyId, customerId: row.customerId, courseId: course.id, name, classCode: row.number,
        // turma fechada: fora do site, sem venda e sem inscrição pública
        openClass: false, allowCheckout: false, allowSubscriptions: false,
        hoursDuration: slot.workload ?? course.hoursDuration, maxSubscriptions: slot.students ? Math.ceil(slot.students / Math.max(1, slot.quantity)) : null,
        gradeTheory: course.gradeTheory, gradePracticle: course.gradePracticle,
        initialDate: initialDate ? noonUtc(initialDate) : null, finalDate: finalDate ? noonUtc(finalDate) : null,
        address: slot.location || null, description: `Turma fechada do contrato ${row.number}.`,
      } });
      slot.classIds.push(klass.id);
      await tx.commercial_Contract.update({ where: { id }, data: { classes: slots as unknown as Prisma.InputJsonValue } });
      await tx.commercial_ClassBilling.create({ data: { companyId: actor.companyId, classId: klass.id, mode: 'contrato', contractId: id, userId: actor.userId || null } });
      return klass;
    });
    // a listagem de turmas é cacheada: sem isto a turma nova não aparece
    await Promise.all(['training-classes:*', 'cache:*/classes*'].map((pattern) => this.cache.reset(pattern).catch(() => undefined)));
    return { ...(await this.get(actor, id)), classId: created.id };
  }

  // ------------------------------------------------------------------ turma fechada × venda

  /**
   * Liga uma turma a uma venda: grava a origem do dinheiro da turma e, se a
   * venda tiver um item de treinamento do mesmo curso com vaga, ocupa esse item.
   * Se a turma estava em outra venda, sai do item de lá.
   */
  async attachClass(tx: Tx, companyId: number, contractId: number, classId: number, userId: number | null): Promise<void> {
    const contract = await tx.commercial_Contract.findFirst({ where: { id: contractId, companyId, inactiveAt: null } });
    if (!contract) throw new NotFoundException('Venda não encontrada');
    if (contract.status === 'cancelado') throw new ConflictException('Esta venda está cancelada');
    const klass = await tx.courseClass.findFirst({ where: { id: classId, companyId }, select: { id: true, courseId: true, customerId: true } });
    if (!klass) throw new NotFoundException('Turma não encontrada');
    if (klass.customerId && klass.customerId !== contract.customerId) throw new BadRequestException('A venda é de outro cliente');
    if (!klass.customerId) {
      // turma aberta com vagas de empresas não vira turma fechada de um cliente
      if (await tx.courseClassReservation.count({ where: { classId, inactiveAt: null } })) {
        throw new ConflictException('A turma tem vagas reservadas para empresas: use a reserva da venda (Vagas de empresas), não a turma inteira');
      }
      await tx.courseClass.update({ where: { id: classId }, data: { customerId: contract.customerId } });
    }

    const previous = await tx.commercial_ClassBilling.findUnique({ where: { classId } });
    if (previous?.mode === 'contrato' && previous.contractId && previous.contractId !== contractId) await this.releaseSlot(tx, previous.contractId, classId);
    const slots = ((contract.classes as unknown as ClassSlot[]) ?? []).map((slot) => ({ ...slot, classIds: [...(slot.classIds ?? [])] }));
    if (!slots.some((slot) => slot.classIds.includes(classId))) {
      const free = slots.find((slot) => slot.courseId === klass.courseId && slot.classIds.length < Math.max(1, Math.ceil(slot.quantity)));
      if (free) {
        free.classIds.push(classId);
        await tx.commercial_Contract.update({ where: { id: contractId }, data: { classes: slots as unknown as Prisma.InputJsonValue } });
      }
    }
    await tx.commercial_ClassBilling.upsert({
      where: { classId },
      create: { companyId, classId, mode: 'contrato', contractId, userId },
      update: { mode: 'contrato', contractId, reason: null, userId },
    });
  }

  private async releaseSlot(tx: Tx, contractId: number, classId: number) {
    const contract = await tx.commercial_Contract.findUnique({ where: { id: contractId }, select: { classes: true } });
    const slots = ((contract?.classes as unknown as ClassSlot[]) ?? []);
    if (!slots.some((slot) => (slot.classIds ?? []).includes(classId))) return;
    const next = slots.map((slot) => ({ ...slot, classIds: (slot.classIds ?? []).filter((id) => id !== classId) }));
    await tx.commercial_Contract.update({ where: { id: contractId }, data: { classes: next as unknown as Prisma.InputJsonValue } });
  }

  /** De onde vem o dinheiro da turma e as vendas do mesmo cliente a que ela pode ser ligada. */
  async classBilling(actor: ContractActor, classId: number) {
    const klass = await this.prisma.courseClass.findFirst({
      where: { id: classId, companyId: actor.companyId },
      select: { id: true, name: true, courseId: true, customerId: true, customer: { select: { id: true, name: true } } },
    });
    if (!klass) throw new NotFoundException('Turma não encontrada');
    const billing = await this.prisma.commercial_ClassBilling.findUnique({ where: { classId } });
    const [contract, user, candidates] = await Promise.all([
      billing?.contractId ? this.prisma.commercial_Contract.findUnique({ where: { id: billing.contractId }, select: { id: true, number: true, title: true, value: true, status: true, proposalId: true } }) : null,
      billing?.userId ? this.prisma.user.findUnique({ where: { id: billing.userId }, select: { id: true, name: true } }) : null,
      klass.customerId ? this.prisma.commercial_Contract.findMany({
        where: { companyId: actor.companyId, customerId: klass.customerId, inactiveAt: null, status: { not: 'cancelado' } },
        orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }], take: 30,
        select: { id: true, number: true, title: true, kind: true, value: true, acceptedAt: true, classes: true },
      }) : [],
    ]);
    return {
      class: { id: klass.id, name: klass.name, customer: klass.customer },
      // sem cliente a turma é aberta: o dinheiro vem das inscrições
      closed: Boolean(klass.customerId),
      billing: billing ? {
        mode: billing.mode, reason: billing.reason, at: billing.updatedAt, user,
        contract: contract ? { ...contract, value: Number(contract.value) } : null,
      } : null,
      candidates: candidates.map(({ classes, ...row }) => ({
        ...row, value: Number(row.value),
        // itens de treinamento do mesmo curso ainda sem turma
        freeSlots: ((classes as unknown as ClassSlot[]) ?? []).filter((slot) => slot.courseId === klass.courseId && (slot.classIds ?? []).length < Math.max(1, Math.ceil(slot.quantity))).length,
      })),
    };
  }

  /** contrato = ligar a uma venda · sem_cobranca = decisão registrada, com motivo · nenhum = desfazer. */
  async setClassBilling(actor: ContractActor, classId: number, body: Body) {
    const klass = await this.prisma.courseClass.findFirst({ where: { id: classId, companyId: actor.companyId }, select: { id: true, customerId: true } });
    if (!klass) throw new NotFoundException('Turma não encontrada');
    const mode = String(body.mode ?? '');
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.commercial_ClassBilling.findUnique({ where: { classId } });
      if (mode === 'contrato') {
        const contractId = Number(body.contractId);
        if (!(contractId > 0)) throw new BadRequestException('Escolha a venda');
        await this.attachClass(tx, actor.companyId, contractId, classId, actor.userId || null);
        return;
      }
      if (previous?.mode === 'contrato' && previous.contractId) await this.releaseSlot(tx, previous.contractId, classId);
      if (mode === 'sem_cobranca') {
        if (!klass.customerId) throw new BadRequestException('Só turma fechada (com cliente) fica sem cobrança: turma aberta cobra pelas inscrições');
        const reason = clean(body.reason, 300);
        if (reason.length < 3) throw new BadRequestException('Diga o motivo de a turma ficar sem cobrança (cortesia, treinamento interno...)');
        await tx.commercial_ClassBilling.upsert({
          where: { classId },
          create: { companyId: actor.companyId, classId, mode, reason, userId: actor.userId || null },
          update: { mode, reason, contractId: null, userId: actor.userId || null },
        });
        return;
      }
      if (mode === 'nenhum') {
        if (previous) await tx.commercial_ClassBilling.delete({ where: { classId } });
        return;
      }
      throw new BadRequestException('Escolha: ligar a uma venda ou sem cobrança');
    });
    return this.classBilling(actor, classId);
  }

  /** Turmas fechadas (com cliente) que não têm venda nem "sem cobrança": o financeiro não fica sabendo delas. */
  async unbilledClasses(companyId: number) {
    const billed = (await this.prisma.commercial_ClassBilling.findMany({ where: { companyId }, select: { classId: true } })).map((b) => b.classId);
    return this.prisma.courseClass.findMany({
      where: { companyId, customerId: { not: null }, inactiveAt: null, ...(billed.length ? { id: { notIn: billed } } : {}) },
      orderBy: [{ initialDate: 'asc' }, { id: 'asc' }], take: 50,
      select: { id: true, name: true, initialDate: true, customer: { select: { id: true, name: true } } },
    });
  }
}
