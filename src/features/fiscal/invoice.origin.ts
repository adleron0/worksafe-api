import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ContractService } from 'src/features/commercial/contract.service';
import { measurementLabel, MeasurementService } from 'src/features/commercial/measurement.service';
import { WorkMeasurementService } from 'src/features/commercial/work.service';
import { ratesOf } from 'src/features/financial/retention.service';
import { pendingLines } from 'src/features/stock/rental.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { round2, todayBr } from './fiscal.utils';
import { coverageUsed } from './fiscal.guards';
import type { CalcLine } from './invoice.calc';

/**
 * Origem da nota: a parcela da proposta, o boletim de medição de obra ou o que
 * uma ordem de locação tem a faturar. A nota nasce preenchida a partir dela e,
 * quando é autorizada, o sistema fatura a origem com o número da nota (conta a
 * receber, caução, comissão e retenções saem do faturamento que já existe).
 */

export type OriginKind = 'installments' | 'measurement' | 'rental' | 'contract';
export type ContractMode = 'total' | 'saldo' | 'livre';

export interface InvoiceOrigin {
  kind: OriginKind;
  contractId: number;
  installmentIds?: number[];
  measurementId?: number;
  rentalId?: number;
  // nota do contrato: inteiro, o saldo que falta notar ou um valor livre (adiantamento, aditivo)
  mode?: ContractMode;
  amount?: number;
  dueDate?: string | null; // vazio = a regra de vencimento da própria origem
  paymentMethod?: string | null;
}

export interface ResolvedOrigin {
  origin: InvoiceOrigin;
  amount: number; // valor da nota (bruto, antes da caução)
  label: string;
  customerId: number;
  links: Array<{ contractId: number; installmentId?: number; measurementId?: number; amount: number }>;
  balance?: number; // saldo a notar do contrato (nota do contrato)
  contract: { id: number; number: string; title: string; customerOrderNumber: string | null; proposalNumber: string | null; retentionRates: unknown };
}

interface Actor { userId: number; companyId: number }

const ACTIVE = ['rascunho', 'emitindo', 'rejeitada', 'autorizada'] as const;
const dateOnly = (value: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').slice(0, 10)) ? String(value).slice(0, 10) : null);

export function originOf(raw: unknown): InvoiceOrigin | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = String(o.kind ?? '') as OriginKind;
  if (!['installments', 'measurement', 'rental', 'contract'].includes(kind)) return null;
  const contractId = Number(o.contractId) || 0;
  if (!contractId) return null;
  return {
    kind,
    contractId,
    installmentIds: kind === 'installments' ? [...new Set((Array.isArray(o.installmentIds) ? o.installmentIds : String(o.installmentIds ?? '').split(',')).map(Number).filter((n) => n > 0))] : undefined,
    measurementId: kind === 'measurement' ? Number(o.measurementId) || undefined : undefined,
    rentalId: kind === 'rental' ? Number(o.rentalId) || undefined : undefined,
    mode: kind === 'contract' ? ((['total', 'saldo', 'livre'].includes(String(o.mode)) ? String(o.mode) : 'saldo') as ContractMode) : undefined,
    amount: kind === 'contract' && o.amount !== undefined && o.amount !== null && o.amount !== '' ? Number(o.amount) : undefined,
    dueDate: dateOnly(o.dueDate),
    paymentMethod: o.paymentMethod ? String(o.paymentMethod) : null,
  };
}

@Injectable()
export class InvoiceOriginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractService,
    private readonly works: WorkMeasurementService,
    private readonly measurements: MeasurementService,
  ) {}

  /**
   * Notas do contrato e o saldo a notar: valor do contrato − notas autorizadas
   * (de parcela, de boletim, de OL e do contrato). Para cada nota do contrato,
   * quanto dela já foi usado para cobrar parcelas.
   */
  async contractSummary(companyId: number, contractId: number) {
    const contract = await this.prisma.commercial_Contract.findFirst({ where: { id: contractId, companyId }, select: { id: true, number: true, value: true, status: true, billingMode: true } });
    if (!contract) throw new NotFoundException('Contrato não encontrado');
    const links = await this.prisma.fiscal_InvoiceLink.findMany({
      where: { contractId, invoice: { companyId } },
      include: { invoice: { select: { id: true, number: true, status: true, provider: true, environment: true, grossValue: true, discountValue: true, netValue: true, issuedAt: true, origin: true, createdAt: true } } },
      orderBy: { id: 'asc' },
    });
    const byInvoice = new Map<number, { invoice: (typeof links)[number]['invoice']; amount: number }>();
    for (const link of links) {
      const cur = byInvoice.get(link.invoiceId) ?? { invoice: link.invoice, amount: 0 };
      cur.amount = round2(cur.amount + Number(link.amount));
      byInvoice.set(link.invoiceId, cur);
    }
    const invoices = [];
    for (const { invoice, amount } of byInvoice.values()) {
      const origin = (invoice.origin ?? {}) as { kind?: string; label?: string; mode?: string };
      const used = origin.kind === 'contract' ? await coverageUsed(this.prisma, invoice.id) : null;
      invoices.push({
        id: invoice.id, number: invoice.number, status: invoice.status, provider: invoice.provider, environment: invoice.environment,
        amount, issuedAt: invoice.issuedAt, kind: origin.kind ?? null, mode: origin.mode ?? null, label: origin.label ?? null,
        coverage: used === null ? null : { used, left: round2(amount - used) },
      });
    }
    const value = Number(contract.value);
    // nota de teste (produção restrita) não conta no saldo
    const invoiced = round2(invoices.filter((i) => i.status === 'autorizada' && i.environment === 'producao' || i.status === 'autorizada' && i.provider === 'externa').reduce((s, i) => s + i.amount, 0));
    const invoicedTest = round2(invoices.filter((i) => i.status === 'autorizada' && i.environment === 'restrita' && i.provider === 'sefin').reduce((s, i) => s + i.amount, 0));
    return {
      contractId, number: contract.number, value, invoiced, invoicedTest, balance: round2(value - invoiced - invoicedTest),
      invoices: invoices.sort((a, b) => b.id - a.id),
      // notas do contrato com saldo para "usar nota já emitida" ao faturar
      available: invoices.filter((i) => i.kind === 'contract' && i.status === 'autorizada' && (i.coverage?.left ?? 0) > 0.009)
        .map((i) => ({ id: i.id, number: i.number, left: i.coverage!.left, issuedAt: i.issuedAt, environment: i.environment })),
    };
  }

  /** Confere a origem (existe, ainda não faturada, sem outra nota em andamento) e calcula o valor da nota. */
  async resolve(companyId: number, origin: InvoiceOrigin, ignoreInvoiceId?: number): Promise<ResolvedOrigin> {
    const contract = await this.prisma.commercial_Contract.findFirst({
      where: { id: origin.contractId, companyId },
      include: { installments: true },
    });
    if (!contract) throw new NotFoundException('Contrato da nota não encontrado');
    if (contract.status === 'cancelado') throw new ConflictException('Contrato cancelado: não recebe faturamento novo');
    const proposal = await this.prisma.commercial_Proposal.findUnique({ where: { id: contract.proposalId }, select: { number: true } });
    const head = { id: contract.id, number: contract.number, title: contract.title, customerOrderNumber: contract.customerOrderNumber, proposalNumber: proposal?.number ?? null, retentionRates: contract.retentionRates };
    const busy = async (where: { installmentId?: number; measurementId?: number; contractId?: number }) =>
      this.prisma.fiscal_InvoiceLink.findFirst({
        where: { ...where, invoice: { companyId, status: { in: [...ACTIVE] }, ...(ignoreInvoiceId ? { id: { not: ignoreInvoiceId } } : {}), originBilledAt: null } },
        include: { invoice: { select: { id: true, status: true, number: true } } },
      });

    if (origin.kind === 'contract') {
      const summary = await this.contractSummary(companyId, contract.id);
      const mode = origin.mode ?? 'saldo';
      const amount = mode === 'total' ? Number(contract.value) : mode === 'saldo' ? summary.balance : round2(Number(origin.amount ?? 0));
      if (mode !== 'livre' && amount <= 0.009) throw new ConflictException('Este contrato não tem saldo a notar');
      const label = mode === 'total' ? 'contrato inteiro' : mode === 'saldo' ? 'saldo do contrato' : 'valor livre do contrato';
      return { origin: { ...origin, mode }, amount, label, customerId: contract.customerId, contract: head, links: [{ contractId: contract.id, amount }], balance: summary.balance };
    }

    if (origin.kind === 'installments') {
      if (!origin.installmentIds?.length) throw new BadRequestException('Escolha as parcelas da nota');
      const chosen = origin.installmentIds.map((id) => {
        const inst = contract.installments.find((i) => i.id === id);
        if (!inst) throw new NotFoundException('Parcela não encontrada neste contrato');
        if (inst.financialRecordId) throw new ConflictException(`A parcela ${inst.number}/${inst.total} já foi faturada`);
        return inst;
      }).sort((a, b) => a.number - b.number);
      for (const inst of chosen) {
        const other = await busy({ installmentId: inst.id });
        if (other) throw new ConflictException(`A parcela ${inst.number}/${inst.total} já tem uma nota em andamento (nota ${other.invoice.number ?? `rascunho ${other.invoice.id}`})`);
      }
      const amount = round2(chosen.reduce((s, i) => s + Number(i.value), 0));
      const label = chosen.length === 1 ? (chosen[0].total > 1 ? `parcela ${chosen[0].number}/${chosen[0].total}` : 'pagamento único') : `parcelas ${chosen.map((i) => `${i.number}/${i.total}`).join(', ')}`;
      return { origin: { ...origin, installmentIds: chosen.map((i) => i.id) }, amount, label, customerId: contract.customerId, contract: head, links: chosen.map((i) => ({ contractId: contract.id, installmentId: i.id, amount: Number(i.value) })) };
    }

    if (origin.kind === 'measurement') {
      const m = await this.prisma.commercial_Measurement.findFirst({ where: { id: origin.measurementId, contractId: contract.id, companyId, source: 'obra' } });
      if (!m) throw new NotFoundException('Boletim de medição não encontrado');
      if (m.status === 'faturada') throw new ConflictException('Este boletim já foi faturado');
      if (m.status !== 'aprovada') throw new ConflictException('O boletim precisa estar aprovado pelo cliente para faturar com a nota');
      const other = await busy({ measurementId: m.id });
      if (other) throw new ConflictException(`Este boletim já tem uma nota em andamento (nota ${other.invoice.number ?? `rascunho ${other.invoice.id}`})`);
      const amount = round2(Number(m.invoiceValue ?? m.value));
      return { origin, amount, label: `${measurementLabel(m.number)} (medição de obra)`, customerId: contract.customerId, contract: head, links: [{ contractId: contract.id, measurementId: m.id, amount }] };
    }

    const rental = await this.prisma.stock_Rental.findFirst({ where: { id: origin.rentalId, companyId, contractId: contract.id, inactiveAt: null }, include: { lines: true, charges: true } });
    if (!rental) throw new NotFoundException('Ordem de locação não encontrada neste contrato');
    const lines = pendingLines(rental);
    const amount = round2(lines.reduce((s, l) => s + l.value, 0));
    if (!lines.length || amount <= 0) throw new ConflictException('Nada a faturar nesta ordem de locação agora');
    const other = await this.prisma.fiscal_Invoice.findFirst({
      where: { companyId, status: { in: [...ACTIVE] }, originBilledAt: null, ...(ignoreInvoiceId ? { id: { not: ignoreInvoiceId } } : {}), origin: { path: ['rentalId'], equals: rental.id } },
      select: { id: true, number: true },
    });
    if (other) throw new ConflictException(`Esta ordem de locação já tem uma nota em andamento (nota ${other.number ?? `rascunho ${other.id}`})`);
    return { origin, amount, label: `${rental.number}: ${lines.map((l) => l.description).join('; ')}`.slice(0, 400), customerId: contract.customerId, contract: head, links: [{ contractId: contract.id, amount }] };
  }

  /** Corpo do formulário da nota já preenchido a partir da origem (a tela abre a nota nova assim). */
  async suggest(companyId: number, query: Record<string, unknown>) {
    const origin = originOf(query);
    if (!origin) throw new BadRequestException('Origem da nota inválida');
    const resolved = await this.resolve(companyId, origin);
    const rates = ratesOf(resolved.contract.retentionRates) as Partial<Record<string, number>>;
    const services = await this.prisma.fiscal_ServiceCode.findMany({ where: { companyId, inactiveAt: null }, orderBy: [{ isDefault: 'desc' }, { id: 'asc' }] });
    // locação: o serviço fiscal de locação (99.04.01) se existir
    const service = origin.kind === 'rental' ? services.find((s) => s.nationalCode === '990401') ?? services[0] : services[0];
    if (origin.kind === 'contract' && origin.mode === 'livre') resolved.amount = resolved.balance ?? resolved.amount;
    const c = resolved.contract;
    return {
      takerKind: 'cliente',
      customerId: resolved.customerId,
      serviceCodeId: service?.id ?? null,
      grossValue: resolved.amount,
      competence: todayBr(),
      issWithheld: !!rates.iss,
      issRate: rates.iss ?? null,
      retentions: Object.fromEntries(['inss', 'ir', 'csll', 'pis', 'cofins'].filter((t) => rates[t]).map((t) => [t, { rate: rates[t] }])),
      reference: [c.proposalNumber ? `Proposta ${c.proposalNumber}` : null, `Contrato ${c.number}`].filter(Boolean).join(' · '),
      order: c.customerOrderNumber,
      description: `${c.title} — ${resolved.label}.`,
      origin: resolved.origin,
      originLabel: `${c.number} · ${resolved.label}`,
    };
  }

  /** Fatura a origem com o número da nota autorizada. Devolve as contas a receber criadas. */
  async bill(actor: Actor, invoice: { id: number; number: string | null; issuedAt: Date | null; origin: unknown }, lines: CalcLine[]): Promise<{ recordIds: number[]; measurementId?: number }> {
    const origin = originOf(invoice.origin);
    // nota do contrato não fatura nada agora: as parcelas usam o saldo dela ao serem faturadas
    if (!origin || origin.kind === 'contract') return { recordIds: [] };
    const issued = invoice.issuedAt ? new Date(invoice.issuedAt.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10) : todayBr();
    const common = {
      invoiceNumber: invoice.number ?? `NFS-e ${invoice.id}`,
      invoiceIssuedAt: issued > todayBr() ? todayBr() : issued,
      paymentMethod: origin.paymentMethod ?? 'boleto',
      retentions: lines.map((l) => ({ tax: l.tax, rate: l.rate, value: l.value })),
    };
    if (origin.kind === 'installments') {
      const ids = origin.installmentIds ?? [];
      const dueDates = origin.dueDate ? Object.fromEntries(ids.map((id) => [id, origin.dueDate])) : undefined;
      const out = await this.contracts.billMany(actor, origin.contractId, { ...common, installmentIds: ids, dueDates });
      return { recordIds: (out as { financialRecordIds?: number[] }).financialRecordIds ?? [] };
    }
    if (origin.kind === 'measurement') {
      const out = await this.works.bill(actor, origin.contractId, origin.measurementId!, { ...common, dueDate: origin.dueDate ?? undefined });
      return { recordIds: out.financialRecordId ? [out.financialRecordId] : [], measurementId: origin.measurementId };
    }
    const out = await this.measurements.billRental(actor, origin.contractId, { ...common, rentalId: origin.rentalId, dueDate: origin.dueDate ?? undefined });
    return { recordIds: out.financialRecordId ? [out.financialRecordId] : [], measurementId: out.measurementId };
  }

  /** Nota cancelada: desfaz o faturamento da origem (a parcela ou o boletim volta para "a faturar"). */
  async unbill(actor: Actor, links: Array<{ contractId: number | null; installmentId: number | null; measurementId: number | null }>) {
    for (const link of links) {
      if (!link.contractId) continue;
      if (link.installmentId) await this.contracts.unbill(actor, link.contractId, link.installmentId);
      else if (link.measurementId) await this.works.unbillAny(actor, link.contractId, link.measurementId);
    }
  }
}
