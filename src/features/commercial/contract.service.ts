import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommercialContractStatus, Prisma, financialRecordsStatus, paymentMethods } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CacheService } from 'src/common/cache/cache.service';
import { classificationDefaults } from 'src/features/financial/classification';
import { installmentValues } from './installments';

type Body = Record<string, any>;
type Tx = Prisma.TransactionClient;
export interface ContractActor { userId: number; companyId: number }

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
  if (!DATE.test(out) || Number.isNaN(asDate(out).getTime())) throw new BadRequestException(`${label}: data inválida`);
  return out;
}

interface ClassSlot { courseId: number | null; description: string; quantity: number; students: number | null; workload: number | null; dates: string; location: string; classIds: number[] }

const FULL = {
  installments: { orderBy: { number: 'asc' as const } },
  customer: { select: { id: true, name: true, corporateName: true, cnpj: true, email: true, phone: true } },
};
type ContractRow = Prisma.Commercial_ContractGetPayload<{ include: typeof FULL }>;

@Injectable()
export class ContractService {
  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService) {}

  // ------------------------------------------------------------------ criação

  /**
   * Contrato de uma proposta aceita: copia o documento congelado, o valor, as
   * parcelas previstas e os itens de treinamento. Chamar duas vezes devolve o
   * mesmo contrato.
   */
  async createFromProposal(tx: Tx, proposalId: number, signer: Record<string, unknown>): Promise<{ id: number; number: string }> {
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
      installments: { create: proposal.installments.map((inst, index) => ({
        companyId: proposal.companyId, number: index + 1, total: proposal.installments.length, description: inst.description,
        value: values[index], dueRule: inst.dueRule, dueDate: inst.dueDate, dueDays: inst.dueDays,
      })) },
    } });
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
      select: { id: true, contractId: true, contractInstallmentId: true, value: true, status: true, dueDate: true, paidAt: true, invoiceNumber: true, invoiceIssuedAt: true, receivedValue: true, invoiceUrl: true },
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
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const term = clean(query.search, 80);
    const status = STATUSES.includes(query.status as CommercialContractStatus) ? (query.status as CommercialContractStatus) : undefined;
    const scope: Prisma.Commercial_ContractWhereInput = {
      companyId: actor.companyId, inactiveAt: null,
      ...(Number(query.customerId) > 0 ? { customerId: Number(query.customerId) } : {}),
      ...(term ? { OR: [
        { number: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } },
        { customer: { name: { contains: term, mode: 'insensitive' } } }, { customer: { corporateName: { contains: term, mode: 'insensitive' } } },
      ] } : {}),
    };
    const where = { ...scope, ...(status ? { status } : {}) };
    const [rows, total, groups] = await Promise.all([
      this.prisma.commercial_Contract.findMany({
        where, orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }], skip: page * limit, take: limit,
        select: { id: true, number: true, kind: true, status: true, title: true, value: true, acceptedAt: true, proposalId: true, customer: { select: { id: true, name: true } },
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
    const days = installment.dueDays ?? 0;
    const base = installment.dueRule === 'dias_apos_aceite' ? iso(contract.acceptedAt)!
      : installment.dueRule === 'dias_apos_conclusao' ? iso(contract.endDate) ?? invoiceDate
        : invoiceDate;
    const due = addDays(base, days);
    // vencimento antes da nota não faz sentido: no mínimo, a data da nota
    return due < invoiceDate ? invoiceDate : due;
  }

  private async present(row: ContractRow) {
    const [billing, proposal, classRows] = await Promise.all([
      this.billing([row.id]),
      this.prisma.commercial_Proposal.findUnique({ where: { id: row.proposalId }, select: { id: true, number: true } }),
      this.classesOf(row),
    ]);
    const b = billing.get(row.id);
    const recordOf = new Map((b?.records ?? []).map((record) => [record.id, record]));
    const value = Number(row.value);
    const classById = new Map(classRows.map((c) => [c.id, c]));
    return {
      id: row.id, number: row.number, kind: row.kind, status: row.status, title: row.title, value, acceptedAt: row.acceptedAt,
      startDate: iso(row.startDate), endDate: iso(row.endDate), notes: row.notes, statusNote: row.statusNote,
      customer: row.customer, proposal, documentHash: row.documentHash, hasDocument: Boolean(row.documentHtml), signer: row.signer,
      billed: round2(b?.billed ?? 0), received: round2(b?.received ?? 0), toBill: round2(value - (b?.billed ?? 0)),
      installments: row.installments.map((inst) => {
        const record = inst.financialRecordId ? recordOf.get(inst.financialRecordId) : undefined;
        return {
          id: inst.id, number: inst.number, total: inst.total, description: inst.description, value: Number(inst.value),
          dueRule: inst.dueRule, dueDate: iso(inst.dueDate), dueDays: inst.dueDays, suggestedDue: this.suggestedDue(inst, row, today()),
          record: record ? {
            id: record.id, status: record.status, dueDate: iso(record.dueDate), paidAt: record.paidAt, invoiceNumber: record.invoiceNumber,
            invoiceIssuedAt: iso(record.invoiceIssuedAt), hasInvoiceFile: Boolean(record.invoiceUrl), paid: PAID.includes(record.status),
          } : null,
        };
      }),
      classes: ((row.classes as unknown as ClassSlot[]) ?? []).map((slot, index) => ({
        index, ...slot, classes: (slot.classIds ?? []).map((id) => classById.get(id)).filter(Boolean),
      })),
    };
  }

  private async classesOf(row: ContractRow) {
    const ids = ((row.classes as unknown as ClassSlot[]) ?? []).flatMap((slot) => slot.classIds ?? []);
    if (!ids.length) return [];
    return this.prisma.courseClass.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, initialDate: true, inactiveAt: true } });
  }

  async get(actor: ContractActor, id: number) {
    return this.present(await this.byId(actor.companyId, id));
  }

  async document(actor: ContractActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    if (!row.documentHtml) throw new NotFoundException('Este contrato não tem documento: o aceite foi registrado sem envio pelo sistema');
    return { html: row.documentHtml, hash: row.documentHash };
  }

  /** Contrato de uma proposta (para a tela da proposta mostrar o link). */
  async ofProposal(companyId: number, proposalId: number) {
    return this.prisma.commercial_Contract.findFirst({ where: { companyId, proposalId }, select: { id: true, number: true, status: true } });
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
    const row = await this.byId(actor.companyId, id);
    if (row.status !== 'vigente') throw new ConflictException(`Contrato ${row.status}: não recebe faturamento novo`);
    const installment = row.installments.find((inst) => inst.id === installmentId);
    if (!installment) throw new NotFoundException('Parcela não encontrada');
    const invoiceNumber = clean(body.invoiceNumber, 60);
    if (!invoiceNumber) throw new BadRequestException('Informe o número da nota fiscal');
    const invoiceDate = blank(body.invoiceIssuedAt) ? today() : dateOf(body.invoiceIssuedAt, 'Data da nota');
    if (invoiceDate > today()) throw new BadRequestException('A data da nota não pode ser futura');
    const dueDate = blank(body.dueDate) ? this.suggestedDue(installment, row, invoiceDate) : dateOf(body.dueDate, 'Vencimento');
    const value = Number(installment.value);
    const netRaw = blank(body.netValue) ? null : Number(String(body.netValue).replace(',', '.'));
    if (netRaw !== null && (!Number.isFinite(netRaw) || netRaw <= 0 || netRaw > value)) throw new BadRequestException('Valor líquido deve ficar entre zero e o valor da parcela');
    const method = METHODS.includes(body.paymentMethod) ? (body.paymentMethod as paymentMethods) : 'outro';
    const label = `${row.number} — ${installment.total > 1 ? `parcela ${installment.number}/${installment.total}` : 'pagamento único'}`;

    const recordId = await this.prisma.$transaction(async (tx) => {
      // trava a parcela: duas pessoas faturando a mesma não geram dois títulos
      const locked = await tx.commercial_ContractInstallment.updateMany({ where: { id: installmentId, financialRecordId: null }, data: { billedAt: new Date() } });
      if (!locked.count) throw new ConflictException('Esta parcela já foi faturada');
      const record = await tx.financialRecords.create({ data: {
        companyId: actor.companyId, gateway: 'manual', status: 'waiting', paymentMethod: method,
        customerId: row.customerId, sellerId: row.sellerId, value, netValue: netRaw === null ? null : round2(netRaw),
        dueDate: noonUtc(dueDate), accrualDate: invoiceDate.slice(0, 7),
        invoiceNumber, invoiceIssuedAt: noonUtc(invoiceDate), installmentNumber: installment.number, installmentTotal: installment.total,
        description: clean(body.description, 255) || `${label} · ${row.title}`.slice(0, 255),
        observations: clean(body.observations, 255) || null,
        contractId: id, contractInstallmentId: installmentId,
        ...(await classificationDefaults(tx, actor.companyId, 'contrato')),
      } });
      await tx.commercial_ContractInstallment.update({ where: { id: installmentId }, data: { financialRecordId: record.id } });
      return record.id;
    });
    return { ...(await this.get(actor, id)), financialRecordId: recordId };
  }

  /** Desfaz o faturamento de uma parcela que ainda não foi paga: o título sai do Contas a Receber. */
  async unbill(actor: ContractActor, id: number, installmentId: number) {
    const row = await this.byId(actor.companyId, id);
    const installment = row.installments.find((inst) => inst.id === installmentId);
    if (!installment) throw new NotFoundException('Parcela não encontrada');
    if (!installment.financialRecordId) throw new ConflictException('Esta parcela ainda não foi faturada');
    const record = await this.prisma.financialRecords.findUnique({ where: { id: installment.financialRecordId }, select: { id: true, status: true } });
    if (record && PAID.includes(record.status)) throw new ConflictException('Esta parcela já foi paga: estorne a baixa em Contas a Receber antes de desfazer o faturamento');
    await this.prisma.$transaction(async (tx) => {
      if (record) await tx.financialRecords.update({ where: { id: record.id }, data: { inactiveAt: new Date(), status: 'cancelled' } });
      await tx.commercial_ContractInstallment.update({ where: { id: installmentId }, data: { financialRecordId: null, billedAt: null } });
    });
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
      return klass;
    });
    // a listagem de turmas é cacheada: sem isto a turma nova não aparece
    await Promise.all(['training-classes:*', 'cache:*/classes*'].map((pattern) => this.cache.reset(pattern).catch(() => undefined)));
    return { ...(await this.get(actor, id)), classId: created.id };
  }
}
