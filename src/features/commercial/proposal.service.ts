import { DealEvents } from './deal.events';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommercialDueRule, CommercialItemType, CommercialProposalKind, CommercialProposalStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ActivityService } from './activity.service';
import { CommercialService, PricingSnapshot } from './commercial.service';
import { ContractService } from './contract.service';
import { installmentValues, workMarksProblem } from './installments';
import { ProposalImage, Schedule } from './document.blocks';
import { DocumentData, DocumentService, ITEMS_MODES, ItemsMode, VARIABLES, renderDocument, sanitizeBody, sha256 } from './document.service';
import { computeBase, price, PriceInput, PriceItemInput, PriceResult, PricingError, professionalCost, resolveRentalTax, resolveTax, round2 } from './pricing/engine';
import { RentalError, RentalLine, RentPeriod, rentalCost, rentalDefaultsOf, rentalLine } from './pricing/rental';
import { loadRentalItems } from './rental.items';
import { MeasurementPlanInput, contractPlanOf, parsePlan, planProblem, planTerms } from './measurement.plan';
import { RentalTerms, periodsEnd, rentalAvailability, rentalTermsOf } from 'src/features/stock/rental.service';

type Body = Record<string, any>;
type Tx = Prisma.TransactionClient;
import { proposalsVisibleTo } from './ownership';

export interface Actor { userId: number; companyId: number; canSeeCosts: boolean; seesAll: boolean }

const KINDS: CommercialProposalKind[] = ['servico', 'treinamento', 'locacao'];
const ITEM_TYPES: CommercialItemType[] = ['mao_de_obra', 'locacao', 'material', 'treinamento', 'avulso', 'locacao_cliente'];
const RENT_PERIODS = ['dia', 'semana', 'mes'];
const DUE_RULES: CommercialDueRule[] = ['data_fixa', 'dias_apos_aceite', 'dias_apos_nf', 'dias_apos_conclusao', 'percentual_obra'];
/** Ainda em negociação: pode ser revisada, cancelada ou decidida. */
const SENT: CommercialProposalStatus[] = ['enviada', 'visualizada'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Seções com que cada tipo de proposta nasce. */
const PRESETS: Record<CommercialProposalKind, Array<{ title: string; kind: CommercialItemType }>> = {
  servico: [{ title: 'Mão de obra', kind: 'mao_de_obra' }, { title: 'Locações', kind: 'locacao' }, { title: 'Materiais de consumo', kind: 'material' }],
  treinamento: [{ title: 'Treinamentos', kind: 'treinamento' }],
  locacao: [{ title: 'Equipamentos', kind: 'locacao_cliente' }, { title: 'Frete e mobilização', kind: 'avulso' }],
};

/**
 * Itens que cada tipo aceita. O tipo decide o que nasce do aceite (OS, turma,
 * ordem de locação), então um tipo não carrega itens de outro: serviço e
 * locação juntos são duas propostas (duas notas).
 */
export const KIND_ITEMS: Record<CommercialProposalKind, CommercialItemType[]> = {
  servico: ['mao_de_obra', 'locacao', 'material', 'avulso'],
  treinamento: ['treinamento', 'material', 'avulso'],
  locacao: ['locacao_cliente', 'material', 'avulso'],
};
const KIND_LABEL: Record<CommercialProposalKind, string> = { servico: 'serviço', treinamento: 'treinamento', locacao: 'locação' };
const ITEM_LABEL: Record<CommercialItemType, string> = {
  mao_de_obra: 'mão de obra', locacao: 'locação de terceiros', material: 'material', treinamento: 'treinamento', avulso: 'outros', locacao_cliente: 'equipamento para locação',
};

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const text = (value: unknown, max = 10000) => String(value ?? '').trim().slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const bool = (value: unknown) => value === true || value === 'true';
const today = () => new Date().toISOString().slice(0, 10);
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

function number(value: unknown, label: string, min: number, max: number, fallback?: number): number {
  if (blank(value) && fallback !== undefined) return fallback;
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  if (blank(value) || !Number.isFinite(n)) throw new BadRequestException(`${label}: informe um número`);
  if (n < min || n > max) throw new BadRequestException(`${label}: valor fora do intervalo permitido`);
  return n;
}
const optional = (value: unknown, label: string, min: number, max: number) => (blank(value) ? null : number(value, label, min, max));
function dateOf(value: unknown, label: string): string {
  const out = String(value ?? '').slice(0, 10);
  if (!DATE.test(out) || Number.isNaN(asDate(out).getTime())) throw new BadRequestException(`${label}: data inválida`);
  return out;
}

export { installmentValues };

/**
 * Locação a cliente com valor do período digitado na proposta: quantidade ×
 * valor × períodos (vira o preço de tabela do item). Sem valor digitado, o
 * preço sai da base de cálculo da locação (`rentalOf`).
 */
export const rentPrice = (item: Pick<DraftItem, 'quantity' | 'extra'>) => {
  const rate = Number(item.extra?.rate ?? 0);
  return rate > 0 ? round2(Number(item.quantity) * rate * Number(item.extra?.periods ?? 1)) : null;
};

/** Conta da locação de uma linha: custo pela base, ou nulo quando o item não tem dados para a conta. */
export function rentalOf(item: DraftItem, snapshot: PricingSnapshot): { line: RentalLine; perRentedMonth: number; handling: number; value: number } | { error: string } | null {
  if (item.type !== 'locacao_cliente' || !item.stockItemId) return null;
  const stock = snapshot.rentals?.[item.stockItemId];
  if (!stock) return null;
  const defaults = rentalDefaultsOf(snapshot.defaults?.rental);
  try {
    const cost = rentalCost(stock.input, defaults);
    const period = (RENT_PERIODS.includes(String(item.extra?.period)) ? item.extra!.period : 'mes') as RentPeriod;
    const line = rentalLine(cost, { quantity: item.quantity, period, periods: Number(item.extra?.periods ?? 1), closed: item.extra?.closed === true }, defaults);
    return { line, perRentedMonth: cost.perRentedMonth, handling: cost.handling, value: cost.value };
  } catch (error) {
    if (error instanceof RentalError) return { error: error.message };
    throw error;
  }
}

export interface DraftItem {
  id?: number; type: CommercialItemType; description: string; unit: string | null; quantity: number;
  professionalId: number | null; night: boolean; travel: boolean; weekend: boolean;
  workDays: number | null; weekendDays: number | null; hoursPerDay: number | null; overtimeHours: number;
  courseId: number | null; stockItemId: number | null;
  extra: { students?: number | null; workload?: number | null; dates?: string; location?: string; period?: string; periods?: number | null; rate?: number | null; closed?: boolean } | null;
  unitCost: number; extraCost: number; margin: number | null; finalValue: number | null; showInDocument: boolean;
}
export interface DraftSection { id?: number; title: string; kind: CommercialItemType; margin: number; showInDocument: boolean; items: DraftItem[] }
export interface DraftInstallment { percent: number | null; amount: number | null; dueRule: CommercialDueRule; dueDate: string | null; dueDays: number | null; workPercent?: number | null; description: string | null }
export interface Draft {
  kind: CommercialProposalKind; customerId: number; contactName: string | null; contactEmail: string | null; contactPhone: string | null;
  requester: string | null; department: string | null; title: string; description: string | null; sellerId: number | null;
  validUntil: string | null; referenceDate: string; workDays: number; weekendDays: number;
  contingencyRate: number; commissionRate: number; commissionBase: 'faturado' | 'lucro'; commissionInPrice: boolean;
  taxRegime: 'tradicional' | 'hibrido' | null; discount: number; internalNotes: string | null;
  /** parte desta proposta no desconto de fechamento conjunto da negociação (não vem da tela da proposta) */
  dealDiscount: number;
  /** base de cálculo escolhida à mão; nulo = a vigente na data prevista */
  costBaseId: number | null;
  /** documento: cópia editável do modelo, termos escolhidos e formato da tabela de itens */
  templateId: number | null; documentBody: string | null; itemsMode: ItemsMode; termIds: number[];
  /** fotos e desenhos da proposta, com descrição e marcações */
  images: ProposalImage[];
  /** cronograma em etapas (opcional) */
  schedule: Schedule;
  /** proposta de locação: período, nº de períodos ou "até devolver", cobrança, caução e entrega */
  rental: RentalTerms | null;
  /** serviço: faturamento por medição de obra (frentes, mobilização, caução); null = parcelas */
  measurement: MeasurementPlanInput | null;
  /** caução contratual nas parcelas: fração retida de cada nota (0–0,3) e dias após a conclusão para liberar */
  depositRate: number; depositReleaseDays: number;
  sections: DraftSection[]; installments: DraftInstallment[];
}

type ProposalRow = Prisma.Commercial_ProposalGetPayload<{ include: { sections: true; items: true; installments: true; customer: { select: { id: true; name: true; corporateName: true; cnpj: true; email: true; phone: true } } } }>;
const FULL = {
  sections: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
  items: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
  installments: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
  customer: { select: { id: true, name: true, corporateName: true, cnpj: true, email: true, phone: true } },
};

export interface CommissionDefault { rate: number; base: 'faturado' | 'lucro'; inPrice: boolean; source: 'vendedor' | 'padrao' | 'zero' }

/** Padrão da base de cálculo, só quando a diretoria o ligou; desligado (ou ausente) = zero. */
export function baseCommission(defaults: Record<string, any> | undefined): CommissionDefault {
  const commission = defaults?.commission;
  if (commission?.enabled === true) {
    const base = commission.base === 'faturado' ? 'faturado' : 'lucro';
    return { rate: Number(commission.rate ?? 0), base, inPrice: base === 'faturado' && commission.inPrice === true, source: 'padrao' };
  }
  return { rate: 0, base: 'lucro', inPrice: false, source: 'zero' };
}

/** Endereço em até duas linhas: "Rua, número, complemento" e "Bairro - Cidade - UF - CEP 00000-000". */
function addressLines(street: Array<string | number | null | undefined>, neighborhood?: string | null, city?: string | null, uf?: string | null, zip?: string | null): string[] {
  const digits = String(zip ?? '').replace(/\D/g, '');
  const cep = digits.length === 8 ? `CEP ${digits.slice(0, 5)}-${digits.slice(5)}` : '';
  // sem rua não há o que numerar; e número 0 é campo em branco no cadastro, não endereço
  const [road, number, complement] = street.map((part) => String(part ?? '').trim());
  const numbered = road ? [road, number && number !== '0' ? number : '', complement] : [];
  return [
    numbered.filter(Boolean).join(', '),
    [neighborhood, city, uf, cep].map((part) => String(part ?? '').trim()).filter(Boolean).join(' - '),
  ].filter(Boolean);
}

@Injectable()
export class ProposalService {
  constructor(private readonly prisma: PrismaService, private readonly commercial: CommercialService, private readonly documents: DocumentService,
    private readonly contracts: ContractService, private readonly activities: ActivityService, private readonly dealEvents: DealEvents) {}

  // ------------------------------------------------------------------ leitura do corpo

  /**
   * Lê e valida o corpo. Quem não vê custos não muda margem, comissão nem
   * regime: esses campos são mantidos como estavam (`keep`), e seções novas
   * nascem com a margem padrão da base.
   */
  private parse(body: Body, actor: Actor, snapshot: PricingSnapshot, keep?: ProposalRow): Draft {
    const kind = (KINDS.includes(body.kind) ? body.kind : keep?.kind ?? 'servico') as CommercialProposalKind;
    const title = clean(body.title, 200);
    if (title.length < 2) throw new BadRequestException('Informe o título da proposta');
    const customerId = number(body.customerId, 'Cliente', 1, 2147483647);
    const referenceDate = blank(body.referenceDate) ? today() : dateOf(body.referenceDate, 'Data prevista');
    const workDays = Math.round(number(body.workDays, 'Prazo em dias úteis', 0, 3660, 0));
    const weekendDays = Math.round(number(body.weekendDays, 'Dias de FDS/feriado', 0, 3660, 0));
    if (weekendDays > workDays) throw new BadRequestException('Dias de FDS/feriado não podem passar do prazo');

    const defaults = snapshot.defaults ?? {};
    const marginOf = new Map<number, number>((keep?.sections ?? []).map((s) => [s.id, Number(s.margin)]));
    const itemMarginOf = new Map<number, number | null>((keep?.items ?? []).map((i) => [i.id, i.margin === null ? null : Number(i.margin)]));

    const rawSections = Array.isArray(body.sections) ? body.sections : [];
    if (rawSections.length > 30) throw new BadRequestException('Seções demais na proposta');
    let itemCount = 0;
    const sections = rawSections.map((raw: Body): DraftSection => {
      const sectionKind = (ITEM_TYPES.includes(raw.kind) ? raw.kind : 'avulso') as CommercialItemType;
      const sectionTitle = clean(raw.title, 120);
      if (!sectionTitle) throw new BadRequestException('Toda seção precisa de um título');
      const id = Number(raw.id) > 0 ? Number(raw.id) : undefined;
      const fallbackMargin = id && marginOf.has(id) ? marginOf.get(id)! : Number(defaults.margins?.[sectionKind] ?? 0);
      const margin = actor.canSeeCosts ? number(raw.margin, `Margem de ${sectionTitle}`, 0, 0.95, fallbackMargin) : fallbackMargin;
      const rawItems = Array.isArray(raw.items) ? raw.items : [];
      itemCount += rawItems.length;
      if (itemCount > 500) throw new BadRequestException('Itens demais na proposta');
      const items = rawItems.map((entry: Body): DraftItem => {
        const type = (ITEM_TYPES.includes(entry.type) ? entry.type : sectionKind) as CommercialItemType;
        const itemId = Number(entry.id) > 0 ? Number(entry.id) : undefined;
        const label = clean(entry.description, 80) || 'item';
        const rentExtra = type === 'locacao_cliente' ? {
          period: RENT_PERIODS.includes(entry.extra?.period) ? String(entry.extra.period) : 'mes',
          periods: optional(entry.extra?.periods, `Períodos de ${label}`, 0, 100000) ?? 1,
          // valor do período digitado na proposta; vazio = o preço sai da base de cálculo da locação
          rate: optional(entry.extra?.rate, `Valor do período de ${label}`, 0, 1e10),
          // período fechado (em meses): ganha o desconto do prazo da base
          closed: bool(entry.extra?.closed),
        } : null;
        const extra = entry.extra && typeof entry.extra === 'object' ? {
          students: optional(entry.extra.students, 'Alunos', 0, 100000),
          workload: optional(entry.extra.workload, 'Carga horária', 0, 100000),
          dates: clean(entry.extra.dates, 200), location: clean(entry.extra.location, 200),
        } : null;
        return {
          id: itemId, type, description: clean(entry.description, 300), unit: clean(entry.unit, 30) || null,
          quantity: number(entry.quantity, `Quantidade de ${label}`, 0, 1e7, 1),
          professionalId: type === 'mao_de_obra' ? optional(entry.professionalId, 'Profissional', 1, 2147483647) : null,
          night: type === 'mao_de_obra' && bool(entry.night), travel: type === 'mao_de_obra' && bool(entry.travel), weekend: type === 'mao_de_obra' && bool(entry.weekend),
          workDays: type === 'mao_de_obra' ? optional(entry.workDays, `Dias de ${label}`, 0, 3660) : null,
          weekendDays: type === 'mao_de_obra' ? optional(entry.weekendDays, `Dias de FDS de ${label}`, 0, 3660) : null,
          hoursPerDay: type === 'mao_de_obra' ? optional(entry.hoursPerDay, `Horas por dia de ${label}`, 0.5, 24) : null,
          overtimeHours: type === 'mao_de_obra' ? number(entry.overtimeHours, `Horas extras de ${label}`, 0, 100000, 0) : 0,
          courseId: type === 'treinamento' ? optional(entry.courseId, 'Curso', 1, 2147483647) : null,
          stockItemId: type === 'locacao_cliente' ? optional(entry.stockItemId, 'Item do estoque', 1, 2147483647) : null,
          extra: type === 'treinamento' ? extra : rentExtra,
          unitCost: type === 'mao_de_obra' ? 0 : round2(number(entry.unitCost, `Custo de ${label}`, 0, 1e10, 0)),
          extraCost: type === 'mao_de_obra' ? 0 : round2(number(entry.extraCost, `Taxas de ${label}`, 0, 1e10, 0)),
          margin: actor.canSeeCosts ? optional(entry.margin, `Margem de ${label}`, 0, 0.95) : (itemId ? itemMarginOf.get(itemId) ?? null : null),
          finalValue: blank(entry.finalValue) ? null : round2(number(entry.finalValue, `Valor de ${label}`, 0, 1e11)),
          showInDocument: entry.showInDocument !== false && entry.showInDocument !== 'false',
        };
      });
      return { id, title: sectionTitle, kind: sectionKind, margin, showInDocument: raw.showInDocument !== false && raw.showInDocument !== 'false', items };
    });
    // locação: período e nº de períodos valem para a proposta inteira (uma OL, um período); as linhas seguem
    const firstRent = sections.flatMap((section) => section.items).find((item) => item.type === 'locacao_cliente');
    const rental = kind === 'locacao' ? rentalTermsOf('rental' in body ? body.rental : keep?.rental, firstRent?.extra ?? undefined) : null;
    if (rental) {
      for (const item of sections.flatMap((section) => section.items)) {
        if (item.type === 'locacao_cliente') item.extra = { ...(item.extra ?? {}), period: rental.period, periods: rental.periods };
      }
    }
    // serviço pode ser faturado por medição de obra (frentes, mobilização, caução) em vez de parcelas
    const schedule = this.documents.parseSchedule('schedule' in body ? body.schedule : keep?.schedule);
    const measurement = kind === 'servico' ? parsePlan('measurement' in body ? body.measurement : keep?.measurement, schedule) : null;
    const allowed = KIND_ITEMS[kind];
    for (const section of sections) {
      const wrong = [section.kind, ...section.items.map((item) => item.type)].find((type) => !allowed.includes(type));
      if (wrong) throw new BadRequestException(`Proposta de ${KIND_LABEL[kind]} não leva itens de ${ITEM_LABEL[wrong]} (seção "${section.title}"). Para vender os dois, faça uma proposta de cada tipo.`);
    }

    const rawInstallments = Array.isArray(body.installments) ? body.installments : [];
    if (rawInstallments.length > 60) throw new BadRequestException('Parcelas demais');
    const installments = rawInstallments.map((raw: Body, index: number): DraftInstallment => {
      const label = `Parcela ${index + 1}`;
      const percent = optional(raw.percent, `${label} — percentual`, 0, 1);
      const amount = optional(raw.amount, `${label} — valor`, 0, 1e11);
      if ((percent === null) === (amount === null)) throw new BadRequestException(`${label}: informe o percentual ou o valor`);
      // "% da obra" só existe no serviço (é o avanço da OS, lido do RDO)
      const asked = (DUE_RULES.includes(raw.dueRule) ? raw.dueRule : 'dias_apos_nf') as CommercialDueRule;
      const dueRule = asked === 'percentual_obra' && kind !== 'servico' ? 'dias_apos_nf' : asked;
      const dueDate = dueRule === 'data_fixa' ? dateOf(raw.dueDate, `${label} — vencimento`) : null;
      const byWork = dueRule === 'percentual_obra';
      const dueDays = dueRule === 'data_fixa' || byWork ? null : Math.round(number(raw.dueDays, `${label} — dias`, 0, 3650, 0));
      const workPercent = byWork ? Math.round(number(raw.workPercent, `${label} — % da obra`, 0, 100, 0) * 1e4) / 1e4 : null;
      return { percent, amount: amount === null ? null : round2(amount), dueRule, dueDate, dueDays, workPercent, description: clean(raw.description, 200) || null };
    });

    const commission = (body.commission ?? {}) as Body;
    // o valor inicial (vendedor → padrão da base → zero) é decidido em `applyCommissionDefault`
    const commissionDefault = { rate: 0, base: 'lucro', inPrice: false };
    const seeCosts = actor.canSeeCosts;
    return {
      kind, customerId, title, referenceDate, workDays, weekendDays,
      contactName: clean(body.contactName, 160) || null, contactEmail: clean(body.contactEmail, 255) || null, contactPhone: clean(body.contactPhone, 60) || null,
      requester: clean(body.requester, 160) || null, department: clean(body.department, 160) || null,
      description: text(body.description) || null, internalNotes: text(body.internalNotes) || null,
      sellerId: optional(body.sellerId, 'Vendedor', 1, 2147483647),
      validUntil: blank(body.validUntil) ? null : dateOf(body.validUntil, 'Validade'),
      contingencyRate: number(body.contingencyRate, 'Imprevisibilidade', 0, 1, keep ? Number(keep.contingencyRate) : Number(defaults.contingencyRate ?? 0)),
      commissionRate: seeCosts ? number(commission.rate, 'Comissão', 0, 0.5, keep ? Number(keep.commissionRate) : Number(commissionDefault.rate ?? 0))
        : keep ? Number(keep.commissionRate) : Number(commissionDefault.rate ?? 0),
      commissionBase: ((seeCosts && commission.base ? commission.base : keep?.commissionBase ?? commissionDefault.base) === 'lucro' ? 'lucro' : 'faturado'),
      commissionInPrice: seeCosts && 'inPrice' in commission ? bool(commission.inPrice) : keep ? keep.commissionInPrice : bool(commissionDefault.inPrice),
      taxRegime: seeCosts ? (body.taxRegime === 'tradicional' || body.taxRegime === 'hibrido' ? body.taxRegime : null) : keep?.taxRegime ?? null,
      costBaseId: seeCosts ? ('costBaseId' in body ? optional(body.costBaseId, 'Base de cálculo', 1, 2147483647) : keep?.costBaseId ?? null) : keep?.costBaseId ?? null,
      discount: round2(number(body.discount, 'Desconto', 0, 1e11, 0)),
      dealDiscount: keep ? Number(keep.dealDiscount) : 0,
      templateId: 'templateId' in body ? optional(body.templateId, 'Modelo', 1, 2147483647) : keep?.templateId ?? null,
      documentBody: 'documentBody' in body ? (sanitizeBody(body.documentBody) || null) : keep?.documentBody ?? null,
      itemsMode: (ITEMS_MODES.includes(body.itemsMode) ? body.itemsMode : keep?.itemsMode ?? 'detalhado') as ItemsMode,
      termIds: Array.isArray(body.termIds) ? body.termIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0).slice(0, 40) : keep?.termIds ?? [],
      images: 'images' in body ? this.documents.parseImages(body.images) : this.documents.parseImages(keep?.images ?? []),
      schedule: this.documents.parseSchedule('schedule' in body ? body.schedule : keep?.schedule),
      // locação é cobrada por medição: parcelas não se aplicam
      rental, sections, installments: kind === 'locacao' || measurement ? [] : installments, measurement,
      // caução contratual das parcelas (no serviço; a locação tem a caução própria e a medição de obra, a do plano)
      depositRate: kind === 'servico' && !measurement ? Math.round(number('depositRate' in body ? body.depositRate : keep ? Number(keep.depositRate) : 0, 'Caução', 0, 0.3, 0) * 1e6) / 1e6 : 0,
      depositReleaseDays: kind === 'servico' && !measurement ? Math.round(number('depositReleaseDays' in body ? body.depositReleaseDays : keep?.depositReleaseDays ?? 0, 'Prazo de liberação da caução', 0, 3650, 0)) : 0,
    };
  }

  // ------------------------------------------------------------------ cálculo

  /**
   * Completa a fotografia com o salário dos profissionais e a tabela dos
   * cursos usados que ainda não estão nela. O que já está guardado não muda.
   */
  private async fill(companyId: number, draft: Draft, snapshot: PricingSnapshot): Promise<void> {
    const items = draft.sections.flatMap((s) => s.items);
    const proIds = [...new Set(items.map((i) => i.professionalId).filter((id): id is number => !!id && !snapshot.salaries[id]))];
    if (proIds.length) {
      const rows = await this.prisma.commercial_Professional.findMany({ where: { companyId, id: { in: proIds } } });
      for (const row of rows) snapshot.salaries[row.id] = { name: row.name, salary: Number(row.salary) };
    }
    const courseIds = [...new Set(items.map((i) => i.courseId).filter((id): id is number => !!id && !snapshot.coursePrices[id]))];
    if (courseIds.length) {
      const [courses, prices] = await Promise.all([
        this.prisma.course.findMany({ where: { companyId, id: { in: courseIds } }, select: { id: true, name: true } }),
        this.prisma.commercial_CoursePrice.findMany({ where: { companyId, courseId: { in: courseIds } } }),
      ]);
      const priceOf = new Map(prices.map((p) => [p.courseId, p]));
      for (const course of courses) {
        const p = priceOf.get(course.id);
        snapshot.coursePrices[course.id] = {
          name: course.name, classPrice: p?.classPrice == null ? null : Number(p.classPrice),
          includedStudents: p?.includedStudents ?? null, studentPrice: p?.studentPrice == null ? null : Number(p.studentPrice),
        };
      }
    }
    const rentalIds = [...new Set(items.map((i) => (i.type === 'locacao_cliente' ? i.stockItemId : null)).filter((id): id is number => !!id && !snapshot.rentals?.[id]))];
    if (rentalIds.length) {
      const loaded = await loadRentalItems(this.prisma, companyId, rentalIds);
      snapshot.rentals = { ...(snapshot.rentals ?? {}), ...loaded };
    }
    for (const item of items) {
      if (item.type === 'locacao_cliente' && item.stockItemId) {
        const stock = snapshot.rentals?.[item.stockItemId];
        if (!stock) throw new BadRequestException('Item do estoque não encontrado');
        if (stock.rentMode === 'com_operador') throw new BadRequestException(`${stock.name} só sai com operador da empresa: venda como serviço, não como locação`);
        if (!item.description) item.description = stock.name;
      }
      if (item.type === 'mao_de_obra') {
        if (!item.professionalId || !snapshot.salaries[item.professionalId]) throw new BadRequestException('Escolha o profissional de cada linha de mão de obra');
        if (!item.description) item.description = snapshot.salaries[item.professionalId].name;
      }
      if (item.type === 'treinamento' && item.courseId) {
        if (!snapshot.coursePrices[item.courseId]) throw new BadRequestException('Curso não encontrado');
        if (!item.description) item.description = snapshot.coursePrices[item.courseId].name;
      }
      if (!item.description) throw new BadRequestException('Todo item precisa de uma descrição');
    }
  }

  /** Preço de tabela de um item de treinamento: turmas × preço da turma + alunos além dos incluídos. */
  private listPrice(item: DraftItem, snapshot: PricingSnapshot): number | null {
    const table = item.courseId ? snapshot.coursePrices[item.courseId] : null;
    if (!table || (table.classPrice === null && table.studentPrice === null)) return null;
    const students = Number(item.extra?.students ?? 0);
    if (table.classPrice === null) return (table.studentPrice ?? 0) * students;
    const beyond = Math.max(0, students - (table.includedStudents ?? 0) * item.quantity);
    return item.quantity * table.classPrice + (table.studentPrice ?? 0) * beyond;
  }

  /**
   * Linha de locação ao cliente: o custo sai da base da locação (peças × mês
   * alugado × meses + preparação). O preço é o sugerido pelo divisor, salvo
   * valor do período digitado na proposta ou preço manual do cadastro.
   */
  private rentalInput(item: DraftItem, snapshot: PricingSnapshot): PriceItemInput {
    const rental = rentalOf(item, snapshot);
    const typed = rentPrice(item);
    const stock = item.stockItemId ? snapshot.rentals?.[item.stockItemId] : undefined;
    const period = (item.extra?.period ?? 'mes') as 'dia' | 'semana' | 'mes';
    const manual = stock?.priceMode === 'manual' && stock.rent[period] ? round2(item.quantity * stock.rent[period]! * Number(item.extra?.periods ?? 1)) : null;
    const computed = rental && 'line' in rental;
    return {
      type: item.type, quantity: item.quantity, margin: item.margin, finalValue: item.finalValue,
      unitCost: computed ? 0 : item.unitCost, extraCost: computed ? rental.line.cost : item.extraCost,
      listPrice: typed ?? manual,
    };
  }

  private calc(draft: Draft, snapshot: PricingSnapshot): PriceResult & { taxResult: ReturnType<typeof resolveTax> } {
    try {
      const base = computeBase(snapshot.params, snapshot.items, snapshot.date);
      // proposta de locação usa a alíquota da locação do perfil (sem ISS), quando cadastrada
      const tax = draft.kind === 'locacao' ? resolveRentalTax(snapshot.tax.input) : resolveTax(snapshot.tax.input);
      const input: PriceInput = {
        workDays: draft.workDays, weekendDays: draft.weekendDays, contingencyRate: draft.contingencyRate, discount: draft.discount + (draft.dealDiscount ?? 0),
        commission: { rate: draft.commissionRate, base: draft.commissionBase, inPrice: draft.commissionInPrice },
        sections: draft.sections.map((section) => ({
          margin: section.margin,
          items: section.items.map((item): PriceItemInput => item.type === 'mao_de_obra'
            ? { type: item.type, quantity: item.quantity, salary: snapshot.salaries[item.professionalId!].salary, night: item.night, travel: item.travel, weekend: item.weekend,
              workDays: item.workDays ?? undefined, weekendDays: item.weekendDays ?? undefined, hoursPerDay: item.hoursPerDay ?? undefined,
              overtimeHours: item.overtimeHours, margin: item.margin, finalValue: item.finalValue }
            : item.type === 'locacao_cliente' ? this.rentalInput(item, snapshot)
            : { type: item.type, quantity: item.quantity, unitCost: item.unitCost, extraCost: item.extraCost, margin: item.margin, finalValue: item.finalValue,
              listPrice: item.type === 'treinamento' ? this.listPrice(item, snapshot) : null }),
        })),
      };
      return { ...price(input, { params: snapshot.params, base, tax }), taxResult: tax };
    } catch (error) {
      if (error instanceof PricingError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /** O que a tela recebe do cálculo. Sem a permissão de custos, só sugerido, valor e totais de venda. */
  private view(draft: Draft, result: ReturnType<ProposalService['calc']>, snapshot: PricingSnapshot, actor: Actor) {
    const r = (n: number | null | undefined) => (n === null || n === undefined ? null : round2(n));
    const rate = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 1e6) / 1e6);
    const see = actor.canSeeCosts;
    const t = result.totals;
    const values = installmentValues(t.total, draft.installments);
    const installments = draft.installments.map((inst, index) => ({ ...inst, value: values[index] }));
    const planned = values.reduce((sum, value) => sum + value, 0);
    return {
      sections: result.sections.map((section, s) => ({
        suggested: r(section.suggested), value: r(section.value),
        ...(see ? { cost: r(section.cost), margin: rate(section.margin) } : {}),
        lines: section.lines.map((line, i) => ({
          suggested: r(line.suggested), value: r(line.value), hours: line.hours ?? null,
          listPrice: draft.sections[s].items[i].type === 'treinamento' ? r(this.listPrice(draft.sections[s].items[i], snapshot)) : draft.sections[s].items[i].type === 'locacao_cliente' ? r(rentPrice(draft.sections[s].items[i])) : null,
          ...(see ? { cost: r(line.cost), margin: rate(line.margin), hourCost: r(line.hourCost) } : {}),
          ...(draft.sections[s].items[i].type === 'locacao_cliente' ? { rental: this.rentalView(draft.sections[s].items[i], snapshot, line, see) } : {}),
        })),
      })),
      totals: {
        suggested: r(t.suggested), subtotal: r(t.subtotal), contingency: r(t.contingency), discount: r(t.discount), dealDiscount: r(draft.dealDiscount ?? 0), net: r(t.net),
        taxOutside: r(t.taxOutside), total: r(t.total),
        ...(see ? { cost: r(t.cost), taxInside: r(t.taxInside), tax: r(t.tax), profit: r(t.profit), profitRate: rate(t.profitRate), commission: r(t.commission),
          customerCredit: r(t.customerCredit), customerCost: r(t.customerCost) } : {}),
      },
      installments, installmentsTotal: r(planned), installmentsDiff: r(round2(t.total) - planned), installmentsProblem: workMarksProblem(draft.installments),
      // medição de obra: o valor de cada frente e da mobilização com o total de agora
      measurementPlan: draft.measurement ? { ...contractPlanOf(draft.measurement, round2(t.total)), problem: planProblem(draft.measurement) } : null,
      ...(see ? {
        margin: Object.fromEntries(Object.entries(result.margin).map(([key, value]) => [key, key.endsWith('Rate') ? rate(value) : r(value)])),
        tax: { name: snapshot.tax.name, regime: result.taxResult.regime, inside: rate(result.taxResult.inside), outside: rate(result.taxResult.outside) },
        costBase: snapshot.costBase.name,
      } : { tax: { regime: result.taxResult.regime, outside: rate(result.taxResult.outside) } }),
    };
  }

  /** Detalhe da locação de uma linha: valor por período para todos; custo, piso e mercado só para quem vê custos. */
  private rentalView(item: DraftItem, snapshot: PricingSnapshot, line: PriceResult['sections'][number]['lines'][number], see: boolean) {
    const rental = rentalOf(item, snapshot);
    if (!rental) return null;
    if ('error' in rental) return { error: rental.error };
    const r = (n: number) => round2(n);
    const periods = Math.max(1, Number(item.extra?.periods ?? 1));
    const quantity = Math.max(item.quantity, 0) || 1;
    const out: Record<string, unknown> = {
      months: Math.round(rental.line.months * 1e4) / 1e4, discountRate: rental.line.discountRate,
      periodValue: r(line.value / quantity / periods),
    };
    if (see) {
      // preço do mês implícito no valor em uso (mesma proporção valor ÷ custo da linha)
      const defaults = rentalDefaultsOf(snapshot.defaults?.rental);
      const month = line.cost > 0 ? (line.value / line.cost) * rental.perRentedMonth : 0;
      const share = rental.value > 0 ? month / rental.value : 0;
      Object.assign(out, {
        perRentedMonth: r(rental.perRentedMonth), handling: r(rental.handling), value: r(rental.value),
        floorCost: r(rental.line.floorCost), monthPrice: r(month), valueShare: Math.round(share * 1e4) / 1e4,
        market: share < defaults.marketBand.min ? 'abaixo' : share > defaults.marketBand.max ? 'acima' : 'dentro',
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ apoio

  /** Comissão informada à mão por quem pode mexer nela (quem não vê custos nunca informa). */
  private explicitCommission(actor: Actor, body: Body): boolean {
    const commission = body.commission as Body | undefined;
    return actor.canSeeCosts && !!commission && typeof commission === 'object' && !blank(commission.rate);
  }

  /**
   * Comissão inicial de uma proposta, em ordem de prioridade: a própria do
   * vendedor, se houver; senão o padrão da base de cálculo, se a diretoria o
   * ligou; senão zero.
   */
  async commissionDefault(companyId: number, sellerId: number | null, defaults: Record<string, any> | undefined): Promise<CommissionDefault> {
    if (sellerId) {
      const seller = await this.prisma.user.findFirst({ where: { id: sellerId, companyId }, select: { commissionRate: true, commissionBase: true } });
      if (seller?.commissionRate != null) {
        return { rate: Number(seller.commissionRate), base: seller.commissionBase === 'faturado' ? 'faturado' : 'lucro', inPrice: false, source: 'vendedor' };
      }
    }
    return baseCommission(defaults);
  }

  private async applyCommissionDefault(companyId: number, draft: Draft, snapshot: PricingSnapshot) {
    const chosen = await this.commissionDefault(companyId, draft.sellerId, snapshot.defaults);
    draft.commissionRate = chosen.rate;
    draft.commissionBase = chosen.base;
    draft.commissionInPrice = chosen.inPrice;
  }

  private async assertRefs(companyId: number, draft: Draft) {
    const customer = await this.prisma.customer.findFirst({ where: { id: draft.customerId, companyId }, select: { id: true } });
    if (!customer) throw new BadRequestException('Cliente não encontrado');
    if (draft.sellerId) {
      const seller = await this.prisma.user.findFirst({ where: { id: draft.sellerId, companyId }, select: { id: true } });
      if (!seller) throw new BadRequestException('Vendedor não encontrado');
    }
    // só termos e modelo ativos da própria empresa
    draft.termIds = await this.documents.cleanTermIds(companyId, draft.termIds);
    if (draft.templateId && !(await this.prisma.commercial_ProposalTemplate.findFirst({ where: { id: draft.templateId, companyId }, select: { id: true } }))) draft.templateId = null;
  }

  private async byId(actor: Actor, id: number): Promise<ProposalRow> {
    const row = await this.prisma.commercial_Proposal.findFirst({ where: { id, companyId: actor.companyId, AND: [proposalsVisibleTo(actor)] }, include: FULL });
    if (!row) throw new NotFoundException('Proposta não encontrada');
    return row;
  }

  private draftOf(row: ProposalRow): Draft {
    const n = (value: Prisma.Decimal | null) => (value === null ? null : Number(value));
    return {
      kind: row.kind, customerId: row.customerId, contactName: row.contactName, contactEmail: row.contactEmail, contactPhone: row.contactPhone,
      requester: row.requester, department: row.department, title: row.title, description: row.description, sellerId: row.sellerId,
      validUntil: iso(row.validUntil), referenceDate: iso(row.referenceDate)!, workDays: row.workDays, weekendDays: row.weekendDays,
      contingencyRate: Number(row.contingencyRate), commissionRate: Number(row.commissionRate), commissionBase: row.commissionBase === 'lucro' ? 'lucro' : 'faturado',
      commissionInPrice: row.commissionInPrice, taxRegime: row.taxRegime, discount: Number(row.discount), internalNotes: row.internalNotes,
      dealDiscount: Number(row.dealDiscount),
      costBaseId: row.costBaseId,
      templateId: row.templateId, documentBody: row.documentBody, itemsMode: (ITEMS_MODES.includes(row.itemsMode as ItemsMode) ? row.itemsMode : 'detalhado') as ItemsMode, termIds: row.termIds,
      images: this.documents.parseImages(row.images ?? []),
      schedule: this.documents.parseSchedule(row.schedule),
      rental: row.kind === 'locacao' ? rentalTermsOf(row.rental, (row.items.find((item) => item.type === 'locacao_cliente')?.extra ?? undefined) as Record<string, unknown> | undefined) : null,
      measurement: row.kind === 'servico' ? parsePlan(row.measurement, row.schedule) : null,
      depositRate: Number(row.depositRate), depositReleaseDays: row.depositReleaseDays,
      sections: row.sections.map((section) => ({
        id: section.id, title: section.title, kind: section.kind, margin: Number(section.margin), showInDocument: section.showInDocument,
        items: row.items.filter((item) => item.sectionId === section.id).map((item) => ({
          id: item.id, type: item.type, description: item.description, unit: item.unit, quantity: Number(item.quantity),
          professionalId: item.professionalId, night: item.night, travel: item.travel, weekend: item.weekend,
          workDays: item.workDays, weekendDays: item.weekendDays, hoursPerDay: n(item.hoursPerDay), overtimeHours: Number(item.overtimeHours), courseId: item.courseId, stockItemId: item.stockItemId,
          extra: (item.extra as DraftItem['extra']) ?? null, unitCost: Number(item.unitCost), extraCost: Number(item.extraCost),
          margin: n(item.margin), finalValue: n(item.finalValue), showInDocument: item.showInDocument,
        })),
      })),
      installments: row.installments.map((inst) => ({
        percent: n(inst.percent), amount: n(inst.amount), dueRule: inst.dueRule, dueDate: iso(inst.dueDate), dueDays: inst.dueDays, workPercent: n(inst.workPercent), description: inst.description,
      })),
    };
  }

  /** Grava cabeçalho, seções, itens e parcelas de uma vez (substitui os filhos). */
  private async persist(tx: Tx, companyId: number, id: number, draft: Draft, snapshot: PricingSnapshot, result: ReturnType<ProposalService['calc']>) {
    const t = result.totals;
    const { sections, installments, images, schedule, rental, measurement, ...header } = draft;
    await tx.commercial_Proposal.update({ where: { id }, data: {
      ...header, rental: rental ? (rental as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      measurement: measurement ? (measurement as unknown as Prisma.InputJsonValue) : Prisma.JsonNull, images: images as unknown as Prisma.InputJsonValue, schedule: schedule as unknown as Prisma.InputJsonValue, validUntil: header.validUntil ? asDate(header.validUntil) : null, referenceDate: asDate(header.referenceDate),
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      totalCost: round2(t.cost), totalSuggested: round2(t.suggested), totalNet: round2(t.net), totalTax: round2(t.tax), total: round2(t.total),
      profit: round2(t.profit), commission: round2(t.commission),
    } });
    await tx.commercial_ProposalSection.deleteMany({ where: { proposalId: id } });
    await tx.commercial_ProposalInstallment.deleteMany({ where: { proposalId: id } });
    for (const [s, section] of sections.entries()) {
      const created = await tx.commercial_ProposalSection.create({ data: {
        companyId, proposalId: id, title: section.title, kind: section.kind, margin: section.margin, order: s, showInDocument: section.showInDocument,
      } });
      if (!section.items.length) continue;
      await tx.commercial_ProposalItem.createMany({ data: section.items.map(({ id: _id, extra, ...item }, i) => {
        const line = result.sections[s].lines[i];
        return {
          ...item, extra: (extra ?? Prisma.JsonNull) as Prisma.InputJsonValue, companyId, proposalId: id, sectionId: created.id, order: i,
          cost: round2(line.cost), suggestedValue: round2(line.suggested), value: round2(line.value),
        };
      }) });
    }
    if (installments.length) {
      await tx.commercial_ProposalInstallment.createMany({ data: installments.map((inst, order) => ({
        ...inst, dueDate: inst.dueDate ? asDate(inst.dueDate) : null, companyId, proposalId: id, order,
      })) });
    }
  }

  private async nextNumber(tx: Tx, companyId: number) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(740115::int, ${companyId}::int)`;
    const year = new Date().getFullYear();
    const last = await tx.commercial_Proposal.aggregate({ where: { companyId, year }, _max: { sequence: true } });
    const sequence = (last._max.sequence ?? 0) + 1;
    return { year, sequence, number: `PC-${year}-${String(sequence).padStart(4, '0')}` };
  }

  private async present(row: ProposalRow, actor: Actor) {
    const draft = this.draftOf(row);
    const snapshot = row.snapshot as unknown as PricingSnapshot;
    const result = this.calc(draft, snapshot);
    const rootId = row.rootId ?? row.id;
    const versions = await this.prisma.commercial_Proposal.findMany({
      where: { companyId: row.companyId, OR: [{ id: rootId }, { rootId }] }, orderBy: { revision: 'asc' },
      select: { id: true, number: true, revision: true, status: true, total: true, createdAt: true },
    });
    const editable = row.status === 'rascunho' && !row.inactiveAt;
    return {
      id: row.id, number: row.number, revision: row.revision, rootId: row.rootId, status: row.status, inactiveAt: row.inactiveAt,
      expired: SENT.includes(row.status) && !!row.validUntil && iso(row.validUntil)! < today(),
      editable, canSeeCosts: actor.canSeeCosts, customer: row.customer,
      deal: row.dealId ? await this.prisma.commercial_Deal.findUnique({ where: { id: row.dealId }, select: { id: true, number: true, title: true } }) : null,
      sentAt: row.sentAt, decidedAt: row.decidedAt, statusNote: row.statusNote, createdAt: row.createdAt, updatedAt: row.updatedAt,
      // só interessa avisar quando ainda dá para recalcular
      baseOutdated: editable ? !(await this.commercial.snapshotIsCurrent(row.companyId, snapshot, row.taxRegime, row.costBaseId)) : false,
      baseCapturedAt: snapshot.capturedAt,
      versions: versions.map((v) => ({ ...v, total: Number(v.total) })),
      // link do cliente e trilha (enviada, visualizada, aceite com as evidências)
      publicKey: row.publicKey, publicUrl: row.publicKey ? await this.documents.publicUrl(row.companyId, row.publicKey) : null,
      documentFrozen: Boolean(row.frozenHtml), documentHash: row.frozenHash, viewedAt: row.viewedAt,
      emailConfigured: this.documents.emailConfigured(),
      contract: row.status === 'aceita' ? await this.contracts.ofProposal(row.companyId, row.id) : null,
      events: (await this.documents.events(row.id)).map((e) => ({
        id: e.id, type: e.type, at: e.createdAt, name: e.name, role: e.role, email: e.email, cpf: e.cpf, ip: e.ip, userAgent: e.userAgent,
        note: e.note, codeVerified: e.codeVerified, documentHash: e.documentHash,
      })),
      // serviço e locação do mesmo cliente perto da mesma data: confirmar que o equipamento é operado pelo cliente (plano 09, 4.3)
      overlap: await this.serviceRentalOverlap(row),
      availability: editable || ['enviada', 'visualizada'].includes(row.status) ? await this.availabilityOf(row.companyId, draft) : null,
      draft: actor.canSeeCosts ? draft : this.hideMargins(draft),
      calc: this.view(draft, result, snapshot, actor),
    };
  }

  /**
   * Disponibilidade dos itens alugados no período da proposta de locação:
   * o que há de frota livre (descontadas as OL que cruzam o período).
   */
  private async availabilityOf(companyId: number, draft: Draft) {
    if (draft.kind !== 'locacao' || !draft.rental) return null;
    const requests = draft.sections.flatMap((section) => section.items)
      .filter((item) => item.type === 'locacao_cliente' && item.stockItemId)
      .map((item) => ({ itemId: item.stockItemId!, quantity: item.quantity || 1 }));
    if (!requests.length) return null;
    const start = draft.referenceDate;
    const end = periodsEnd(start, draft.rental.period, draft.rental.periods);
    const items = await rentalAvailability(this.prisma, companyId, requests, start, draft.rental.untilReturn ? null : end);
    return { start, end: draft.rental.untilReturn ? null : end, estimatedEnd: end, items, ok: items.every((item) => item.ok) };
  }

  private async serviceRentalOverlap(row: ProposalRow) {
    if (row.kind !== 'locacao' && row.kind !== 'servico') return [];
    const day = 86400000;
    const ref = row.referenceDate.getTime();
    const others = await this.prisma.commercial_Proposal.findMany({
      where: {
        companyId: row.companyId, customerId: row.customerId, kind: row.kind === 'locacao' ? 'servico' : 'locacao', inactiveAt: null,
        status: { in: ['rascunho', 'enviada', 'visualizada', 'aceita'] },
        referenceDate: { gte: new Date(ref - 60 * day), lte: new Date(ref + 60 * day) },
      },
      select: { id: true, number: true, title: true, status: true, kind: true }, orderBy: { referenceDate: 'asc' }, take: 5,
    });
    return others;
  }

  private hideMargins(draft: Draft) {
    const { commissionRate: _r, commissionBase: _b, commissionInPrice: _p, ...rest } = draft;
    return { ...rest, sections: draft.sections.map(({ margin: _m, ...section }) => ({ ...section, items: section.items.map(({ margin: _im, ...item }) => item) })) };
  }

  // ------------------------------------------------------------------ documento

  /**
   * O que vai para o documento do cliente. Os valores das linhas são
   * escalados para somar o total (contingência, desconto e tributo destacado
   * ficam diluídos): o cliente nunca vê custo, margem nem "imprevisibilidade".
   */
  private async documentData(companyId: number, number: string, date: Date, draft: Draft, result: ReturnType<ProposalService['calc']>): Promise<DocumentData> {
    const [company, customer, seller, brand] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: {
        comercial_name: true, corporate_name: true, cnpj: true, address: true, addressNumber: true, addressComplement: true, neighborhood: true, zipCode: true,
        city: { select: { name: true } }, state: { select: { uf: true } },
      } }),
      this.prisma.customer.findFirst({ where: { id: draft.customerId, companyId }, select: {
        name: true, corporateName: true, cnpj: true, email: true, phone: true, street: true, number: true, complement: true, neighborhood: true, zipcode: true,
        city: { select: { name: true } }, state: { select: { uf: true } },
      } }),
      draft.sellerId ? this.prisma.user.findFirst({ where: { id: draft.sellerId, companyId }, select: { name: true, email: true, phone: true } }) : null,
      this.documents.brand(companyId),
    ]);
    const total = round2(result.totals.total);
    const factor = result.totals.subtotal > 0 ? result.totals.total / result.totals.subtotal : 0;
    const sectionValues = result.sections.map((section) => round2(section.value * factor));
    // a última seção com valor absorve o centavo de arredondamento
    const lastSection = sectionValues.map((value, index) => (value > 0 ? index : -1)).filter((index) => index >= 0).pop();
    if (lastSection !== undefined) sectionValues[lastSection] = round2(total - sectionValues.reduce((sum, value, index) => (index === lastSection ? sum : sum + value), 0));
    const sections = draft.sections.map((section, s) => {
      const values = result.sections[s].lines.map((line) => round2(line.value * factor));
      const lastItem = values.map((value, index) => (value > 0 ? index : -1)).filter((index) => index >= 0).pop();
      if (lastItem !== undefined) values[lastItem] = round2(sectionValues[s] - values.reduce((sum, value, index) => (index === lastItem ? sum : sum + value), 0));
      return {
        // seção sem itens não vai para o documento
        title: section.title, show: section.showInDocument && section.items.length > 0, value: sectionValues[s],
        items: section.items.map((item, i) => {
          const days = item.workDays ?? draft.workDays;
          const detail = item.type === 'mao_de_obra'
            ? [days ? `${days} dia${days === 1 ? '' : 's'} útei${days === 1 ? 'l' : 's'}` : '', item.night ? 'noturno' : '', item.weekend ? 'inclui fim de semana/feriado' : ''].filter(Boolean).join(' · ')
            : item.type === 'locacao_cliente'
              ? `${draft.rental?.untilReturn ? 'até a devolução, previsão de ' : ''}${item.extra?.periods ?? 1} ${({ dia: 'dia(s)', semana: 'semana(s)', mes: 'mês(es)' } as Record<string, string>)[item.extra?.period ?? 'mes']} de locação${item.extra?.closed ? ', período fechado' : ''} · entregue inspecionado`
            : item.type === 'treinamento'
              ? [item.extra?.students ? `${item.extra.students} alunos` : '', item.extra?.workload ? `${item.extra.workload} h` : '', item.extra?.dates ?? '', item.extra?.location ?? ''].filter(Boolean).join(' · ')
              : '';
          return {
            description: item.description, quantity: item.quantity, value: values[i], show: item.showInDocument, detail,
            unit: item.unit ?? (item.type === 'mao_de_obra' ? 'prof.' : item.type === 'treinamento' ? 'turma' : null),
          };
        }),
      };
    });
    const values = installmentValues(result.totals.total, draft.installments);
    return {
      company: {
        name: company?.comercial_name ?? '', corporateName: company?.corporate_name ?? '', cnpj: company?.cnpj ?? '',
        addressLines: addressLines([company?.address, company?.addressNumber, company?.addressComplement], company?.neighborhood, company?.city?.name, company?.state?.uf, company?.zipCode),
      },
      customer: {
        name: customer?.name ?? '', corporateName: customer?.corporateName ?? '', cnpj: customer?.cnpj ?? '', email: customer?.email ?? '', phone: customer?.phone ?? '',
        addressLines: addressLines([customer?.street, customer?.number, customer?.complement], customer?.neighborhood, customer?.city?.name, customer?.state?.uf, customer?.zipcode),
      },
      contactName: draft.contactName, contactEmail: draft.contactEmail, contactPhone: draft.contactPhone, sellerName: seller?.name ?? null, number, title: draft.title, description: draft.description,
      date, validUntil: draft.validUntil, workDays: draft.workDays, total, sections,
      brand, images: draft.images, schedule: draft.schedule, kind: draft.kind, seller: { name: seller?.name ?? null, email: seller?.email ?? null, phone: seller?.phone ?? null },
      installments: draft.installments.map((inst, index) => ({ description: inst.description, value: values[index], dueRule: inst.dueRule, dueDate: inst.dueDate, dueDays: inst.dueDays, workPercent: inst.workPercent ?? null })),
      depositTerms: draft.depositRate > 0 && draft.installments.length
        ? `Caução contratual: ${String(Math.round(draft.depositRate * 10000) / 100).replace('.', ',')}% de cada nota fiscal fica retido e é pago ${draft.depositReleaseDays ? `${draft.depositReleaseDays} dias após` : 'na'} conclusão da obra.`
        : null,
      rentalTerms: draft.kind === 'locacao' && draft.rental ? this.rentalTermsText(draft, result)
        // medição de obra: as condições da medição entram no lugar das parcelas
        : draft.measurement ? planTerms(draft.measurement, total) : null,
    };
  }

  /** Condições da locação no documento: como cobra, prazo, caução e entrega. */
  private rentalTermsText(draft: Draft, result: ReturnType<ProposalService['calc']>): string[] {
    const rental = draft.rental!;
    const unit = ({ dia: ['dia', 'dias', 'diária'], semana: ['semana', 'semanas', 'semanal'], mes: ['mês', 'meses', 'mensal'] } as Record<string, string[]>)[rental.period];
    const money = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
    const rents = draft.sections.flatMap((section, s) => section.items.map((item, i) => ({ item, value: result.sections[s].lines[i].value }))).filter((x) => x.item.type === 'locacao_cliente');
    const factor = result.totals.subtotal > 0 ? result.totals.total / result.totals.subtotal : 0;
    const perPeriod = round2(rents.reduce((sum, x) => sum + x.value * factor, 0) / Math.max(1, rental.periods));
    const count = `${rental.periods} ${rental.periods === 1 ? unit[0] : unit[1]}`;
    const lines = [
      rental.billing === 'unico'
        ? rental.untilReturn ? `Pagamento único na devolução, pelos períodos usados (${money(perPeriod)} por ${unit[0]})` : `Pagamento único pelo período contratado (${count})`
        : `Cobrança ${unit[2]}: ${money(perPeriod)} por ${unit[0]}, faturado a cada período vencido`,
      rental.untilReturn ? `Prazo: até a devolução (previsão de ${count}); prorrogação segue a mesma cobrança` : `Prazo: ${count}, contados da entrega; prorrogação segue a mesma cobrança por ${unit[0]}`,
      'Frete, avarias e faltas (pelo valor de reposição) são cobrados na medição seguinte',
    ];
    if (rental.deposit) lines.push(`Caução de ${money(rental.deposit)}, paga na entrega e devolvida no fim (descontadas avarias e faltas)`);
    if (rental.deliveryAddress) lines.push(`Entrega em: ${rental.deliveryAddress}`);
    return lines;
  }

  /** Corpo, termos e formato a usar: os da proposta, ou os do modelo quando ela ainda não tem documento. */
  private async documentSource(companyId: number, draft: Draft) {
    if (draft.documentBody) return { body: draft.documentBody, termIds: draft.termIds, itemsMode: draft.itemsMode, templateId: draft.templateId };
    const template = await this.documents.templateFor(companyId, draft.kind, draft.templateId);
    if (!template) throw new BadRequestException('Cadastre um modelo de proposta antes de gerar o documento');
    return { body: template.body, termIds: draft.termIds.length ? draft.termIds : template.termIds, itemsMode: (draft.documentBody ? draft.itemsMode : template.itemsMode) as ItemsMode, templateId: template.id };
  }

  private async renderFor(companyId: number, number: string, date: Date, draft: Draft, result: ReturnType<ProposalService['calc']>) {
    const source = await this.documentSource(companyId, draft);
    const terms = await this.documents.termsByIds(companyId, source.termIds);
    const html = renderDocument(source.body, await this.documentData(companyId, number, date, draft, result), terms, source.itemsMode);
    return { html, source };
  }

  /** Pré-visualização do documento com o rascunho da tela (nada é gravado). */
  async documentPreview(actor: Actor, id: number, body: Body) {
    const existing = await this.byId(actor, id);
    // proposta já enviada mostra exatamente o que o cliente recebeu
    if (existing.frozenHtml && existing.status !== 'rascunho') return { html: existing.frozenHtml, frozen: true };
    const snapshot = await this.snapshotFor(actor, body, existing);
    const draft = this.parse({ ...this.draftOf(existing), ...body, customerId: body.customerId || existing.customerId, title: clean(body.title) || existing.title }, actor, snapshot, existing);
    await this.fill(actor.companyId, draft, snapshot);
    draft.termIds = await this.documents.cleanTermIds(actor.companyId, draft.termIds);
    const { html } = await this.renderFor(actor.companyId, existing.number, new Date(), draft, this.calc(draft, snapshot));
    return { html, frozen: false };
  }

  /**
   * A página do cliente, montada com a proposta como está salva: é o que ele
   * vai ver pelo link (documento, botão de aceite, formulário). Nada é
   * registrado; a tela mostra a tarja de rascunho.
   */
  async clientView(actor: Actor, id: number) {
    const row = await this.byId(actor, id);
    const frozen = Boolean(row.frozenHtml) && row.status !== 'rascunho';
    const draft = this.draftOf(row);
    const html = frozen ? row.frozenHtml!
      : (await this.renderFor(actor.companyId, row.number, new Date(), draft, this.calc(draft, row.snapshot as unknown as PricingSnapshot))).html;
    const [company, brand, seller] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: actor.companyId }, select: { comercial_name: true } }),
      this.documents.brand(actor.companyId),
      row.sellerId ? this.prisma.user.findFirst({ where: { id: row.sellerId, companyId: actor.companyId }, select: { name: true } }) : null,
    ]);
    const requiresCode = this.documents.emailConfigured() && Boolean(row.contactEmail);
    return {
      preview: true, sent: frozen, proposalStatus: row.status,
      company: { name: company?.comercial_name ?? '', logoUrl: brand.logoUrl, color: brand.color },
      total: Number(row.total), contact: { name: seller?.name ?? null, phone: brand.phone || null, email: brand.email || null },
      number: row.number, title: row.title, status: 'visualizada', validUntil: iso(row.validUntil), html, hash: row.frozenHash,
      canDecide: true, requiresCode, codeEmail: requiresCode ? row.contactEmail!.replace(/^(.{2}).*(@.*)$/, '$1***$2') : null, accepted: null,
    };
  }

  async sendEmail(actor: Actor, id: number, body: Body) {
    const row = await this.byId(actor, id);
    if (row.status !== 'enviada' && row.status !== 'visualizada') throw new ConflictException('Só proposta enviada tem link para mandar por e-mail');
    return this.documents.sendLink(row, body, actor.userId);
  }

  // ------------------------------------------------------------------ rotas

  /** O que o editor precisa para começar: padrões, profissionais, cursos, vendedores e as seções do tipo. */
  async options(actor: Actor, query: { date?: string; regime?: string }) {
    const date = blank(query.date) ? today() : dateOf(query.date, 'Data');
    const snapshot = await this.commercial.snapshot(actor.companyId, date, query.regime);
    const base = computeBase(snapshot.params, snapshot.items, date);
    const [professionals, courses, prices, sellers] = await Promise.all([
      this.prisma.commercial_Professional.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' } }),
      this.prisma.course.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, hoursDuration: true } }),
      this.prisma.commercial_CoursePrice.findMany({ where: { companyId: actor.companyId } }),
      // vendedor da proposta é qualquer usuário ativo da empresa (não depende da subconta de "seller" do gateway)
      this.prisma.user.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, commissionRate: true, commissionBase: true } }),
    ]);
    const priceOf = new Map(prices.map((p) => [p.courseId, p]));
    const defaults = snapshot.defaults ?? {};
    return {
      date, canSeeCosts: actor.canSeeCosts,
      defaults: {
        contingencyLevels: defaults.contingencyLevels ?? [], contingencyRate: defaults.contingencyRate ?? 0,
        // `commission` = o que vale para proposta sem vendedor (ou vendedor sem comissão própria)
        ...(actor.canSeeCosts ? { margins: defaults.margins ?? {}, commission: baseCommission(defaults) } : {}),
      },
      presets: Object.fromEntries(Object.entries(PRESETS).map(([kind, list]) => [kind, list.map((section) => ({
        ...section, ...(actor.canSeeCosts ? { margin: Number(defaults.margins?.[section.kind] ?? 0) } : {}),
      }))])),
      hoursPerDay: snapshot.params.hoursPerDay,
      tax: { regime: snapshot.tax.input.regime, ...(actor.canSeeCosts ? { name: snapshot.tax.name } : {}) },
      professionals: professionals.map((p) => ({
        id: p.id, name: p.name, ...(actor.canSeeCosts ? { hourCost: round2(professionalCost(Number(p.salary), snapshot.params, base).hourCost) } : {}),
      })),
      courses: courses.map((c) => {
        const p = priceOf.get(c.id);
        return { id: c.id, name: c.name, hoursDuration: c.hoursDuration, classPrice: p?.classPrice == null ? null : Number(p.classPrice),
          includedStudents: p?.includedStudents ?? null, studentPrice: p?.studentPrice == null ? null : Number(p.studentPrice) };
      }),
      // a comissão própria do vendedor só vai para quem vê custos; nula = segue o padrão
      sellers: sellers.map((u) => ({ id: u.id, name: u.name, ...(actor.canSeeCosts ? {
        commission: u.commissionRate == null ? null : { rate: Number(u.commissionRate), base: u.commissionBase === 'faturado' ? 'faturado' : 'lucro', inPrice: false, source: 'vendedor' },
      } : {}) })),
      // versões da base para escolher à mão (a automática é a vigente na data prevista)
      costBases: actor.canSeeCosts ? (await this.commercial.listBases(actor.companyId, date)).filter((base) => !base.inactiveAt).map((base) => ({ id: base.id, name: base.name, effectiveFrom: base.effectiveFrom, current: base.current })) : [],
      templates: (await this.documents.listTemplates(actor.companyId)).map((t) => ({ id: t.id, name: t.name, kind: t.kind, isDefault: t.isDefault, body: t.body, itemsMode: t.itemsMode, termIds: t.termIds })),
      terms: (await this.documents.listTerms(actor.companyId)).map((t) => ({ id: t.id, title: t.title, kind: t.kind, body: t.body })),
      variables: VARIABLES,
      // a tela avisa quando a seção "por que nós" ainda está vazia
      brandReady: await this.documents.brand(actor.companyId).then((brand) => Boolean(brand.about || brand.differentials.length || brand.highlights.length)),
    };
  }

  /** Clientes para o seletor da proposta (com contatos), por nome ou CNPJ. */
  async customers(actor: Actor, search?: string) {
    const term = clean(search, 80);
    const digits = term.replace(/\D/g, '');
    const rows = await this.prisma.customer.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, ...(term ? { OR: [
        { name: { contains: term, mode: 'insensitive' } }, { corporateName: { contains: term, mode: 'insensitive' } },
        ...(digits.length >= 3 ? [{ cnpj: { contains: digits } }] : []),
      ] } : {}) },
      orderBy: { name: 'asc' }, take: 30,
      select: { id: true, name: true, corporateName: true, cnpj: true, email: true, phone: true,
        city: { select: { name: true } }, state: { select: { uf: true } },
        // o contato comercial padrão vem primeiro: a proposta nova já nasce com ele
        contacts: { where: { inactiveAt: null }, select: { id: true, name: true, email: true, phone: true, isCommercial: true, defaultCommercial: true },
          orderBy: [{ defaultCommercial: 'desc' }, { isCommercial: 'desc' }, { name: 'asc' }] } },
    });
    // cidade/UF ajudam a reconhecer o cliente na lista
    return rows.map(({ city, state, ...row }) => ({ ...row, place: [city?.name, state?.uf].filter(Boolean).join('/') || null }));
  }

  async list(actor: Actor, query: Record<string, string>) {
    await this.documents.expireDue(actor.companyId);
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    // uma ou mais situações separadas por vírgula (ex.: "enviada,visualizada" = em negociação)
    const statuses = String(query.status ?? '').split(',').map((s) => s.trim())
      .filter((s): s is CommercialProposalStatus => (Object.values(CommercialProposalStatus) as string[]).includes(s));
    const term = clean(query.search, 80);
    const scope: Prisma.Commercial_ProposalWhereInput = {
      companyId: actor.companyId, AND: [proposalsVisibleTo(actor)],
      ...(query.inactive === 'true' ? {} : { inactiveAt: null }),
      ...(KINDS.includes(query.kind as CommercialProposalKind) ? { kind: query.kind as CommercialProposalKind } : {}),
      ...(Number(query.customerId) > 0 ? { customerId: Number(query.customerId) } : {}),
      ...(Number(query.sellerId) > 0 ? { sellerId: Number(query.sellerId) } : {}),
      ...(Number(query.dealId) > 0 ? { dealId: Number(query.dealId) } : {}),
      ...(term ? { OR: [
        { number: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } },
        { customer: { name: { contains: term, mode: 'insensitive' } } }, { customer: { corporateName: { contains: term, mode: 'insensitive' } } },
      ] } : {}),
    };
    // Versões substituídas só aparecem quando pedidas pelo status.
    const where: Prisma.Commercial_ProposalWhereInput = { ...scope, status: statuses.length ? { in: statuses } : { not: 'substituida' } };
    const [rows, total, groups] = await Promise.all([
      this.prisma.commercial_Proposal.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page * limit, take: limit,
        select: { id: true, number: true, revision: true, kind: true, status: true, title: true, total: true, validUntil: true, createdAt: true, sentAt: true,
          inactiveAt: true, sellerId: true, createdByUserId: true, dealId: true, customer: { select: { id: true, name: true } } },
      }),
      this.prisma.commercial_Proposal.count({ where }),
      this.prisma.commercial_Proposal.groupBy({ by: ['status'], where: scope, _count: { _all: true }, _sum: { total: true } }),
    ]);
    // vendedor e quem criou a proposta: nomes numa consulta só
    const userIds = [...new Set(rows.flatMap((r) => [r.sellerId, r.createdByUserId]).filter((id): id is number => !!id))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const userName = new Map(users.map((s) => [s.id, s.name]));
    // acompanhamento: próximo retorno marcado e último contato de cada proposta
    const followUps = await this.activities.followUps(actor.companyId, rows.map((row) => row.id));
    return {
      total,
      rows: rows.map((row) => ({
        ...row, followUp: followUps.get(row.id) ?? { next: null, pending: 0, lastAt: null }, total: Number(row.total), validUntil: iso(row.validUntil), seller: row.sellerId ? userName.get(row.sellerId) ?? null : null,
        createdBy: row.createdByUserId ? userName.get(row.createdByUserId) ?? null : null,
        expired: SENT.includes(row.status) && !!row.validUntil && iso(row.validUntil)! < today(),
      })),
      summary: Object.fromEntries(groups.map((g) => [g.status, { count: g._count._all, total: Number(g._sum.total ?? 0) }])),
    };
  }

  async get(actor: Actor, id: number) {
    await this.documents.expireDue(actor.companyId);
    return this.present(await this.byId(actor, id), actor);
  }

  /** Calcula o rascunho da tela sem gravar. Com `id`, usa a fotografia da proposta. */
  async preview(actor: Actor, body: Body) {
    const existing = Number(body.id) > 0 ? await this.byId(actor, Number(body.id)) : undefined;
    const snapshot = await this.snapshotFor(actor, body, existing);
    const draft = this.parse({ ...body, title: clean(body.title) || 'Rascunho', customerId: body.customerId || existing?.customerId || 1 }, actor, snapshot, existing);
    await this.fill(actor.companyId, draft, snapshot);
    return { ...this.view(draft, this.calc(draft, snapshot), snapshot, actor), availability: await this.availabilityOf(actor.companyId, draft) };
  }

  /** Fotografia a usar: a guardada, salvo se pedirem para recalcular ou se a data/regime mudaram. */
  private async snapshotFor(actor: Actor, body: Body, existing?: ProposalRow): Promise<PricingSnapshot> {
    const companyId = actor.companyId;
    const date = blank(body.referenceDate) ? (existing ? iso(existing.referenceDate)! : today()) : dateOf(body.referenceDate, 'Data prevista');
    // regime e base só mudam para quem vê custos; para os demais vale o que a proposta já tinha
    const see = actor.canSeeCosts;
    const regime = !see ? existing?.taxRegime ?? null
      : body.taxRegime === 'tradicional' || body.taxRegime === 'hibrido' ? body.taxRegime : 'taxRegime' in body ? null : existing?.taxRegime ?? null;
    const costBaseId = !see ? existing?.costBaseId ?? null
      : 'costBaseId' in body ? (Number(body.costBaseId) > 0 ? Number(body.costBaseId) : null) : existing?.costBaseId ?? null;
    if (existing && !bool(body.refreshBase)) {
      const stored = existing.snapshot as unknown as PricingSnapshot;
      const same = (existing.taxRegime ?? null) === regime && (existing.costBaseId ?? null) === costBaseId;
      if (stored?.date === date && same) return JSON.parse(JSON.stringify(stored));
    }
    return this.commercial.snapshot(companyId, date, regime, costBaseId);
  }

  async create(actor: Actor, body: Body) {
    const snapshot = await this.snapshotFor(actor, body);
    // Sem seções no corpo, a proposta nasce com as do tipo escolhido.
    const kind = (KINDS.includes(body.kind) ? body.kind : 'servico') as CommercialProposalKind;
    const seeded = Array.isArray(body.sections) ? body : { ...body, sections: PRESETS[kind].map((section) => ({ ...section, items: [] })) };
    const draft = this.parse(seeded, actor, snapshot);
    // sem vendedor informado, a proposta nasce com quem a está criando
    if (!('sellerId' in body) && actor.userId && (await this.prisma.user.findFirst({ where: { id: actor.userId, companyId: actor.companyId, inactiveAt: null }, select: { id: true } }))) draft.sellerId = actor.userId;
    if (!this.explicitCommission(actor, body)) await this.applyCommissionDefault(actor.companyId, draft, snapshot);
    await this.assertRefs(actor.companyId, draft);
    await this.fill(actor.companyId, draft, snapshot);
    const result = this.calc(draft, snapshot);
    const id = await this.prisma.$transaction(async (tx) => {
      const numbering = await this.nextNumber(tx, actor.companyId);
      const created = await tx.commercial_Proposal.create({ data: {
        companyId: actor.companyId, ...numbering, kind: draft.kind, customerId: draft.customerId, title: draft.title,
        referenceDate: asDate(draft.referenceDate), snapshot: {}, createdByUserId: actor.userId || null,
      } });
      await this.persist(tx, actor.companyId, created.id, draft, snapshot, result);
      return created.id;
    });
    return this.get(actor, id);
  }

  async update(actor: Actor, id: number, body: Body) {
    const existing = await this.byId(actor, id);
    if (existing.inactiveAt) throw new ConflictException('Proposta inativa');
    if (existing.status !== 'rascunho') throw new ConflictException('Só rascunho pode ser editado. Para mudar uma proposta enviada, crie uma revisão.');
    const snapshot = await this.snapshotFor(actor, body, existing);
    const draft = this.parse(body, actor, snapshot, existing);
    // trocou o vendedor sem informar a comissão: vale a do novo vendedor (ou o padrão)
    if ((draft.sellerId ?? null) !== (existing.sellerId ?? null) && !this.explicitCommission(actor, body)) await this.applyCommissionDefault(actor.companyId, draft, snapshot);
    await this.assertRefs(actor.companyId, draft);
    await this.fill(actor.companyId, draft, snapshot);
    const result = this.calc(draft, snapshot);
    await this.prisma.$transaction((tx) => this.persist(tx, actor.companyId, id, draft, snapshot, result));
    return this.get(actor, id);
  }

  /** Copia uma proposta existente para outra linha. `revisionOf` faz a cópia virar a revisão seguinte. */
  private async copy(actor: Actor, source: ProposalRow, revisionOf?: ProposalRow, dealDiscount?: number) {
    const draft = this.draftOf(source);
    // a revisão continua na negociação (com o desconto conjunto, ou o novo, se veio); a cópia nasce fora dela
    draft.dealDiscount = revisionOf ? dealDiscount ?? draft.dealDiscount : 0;
    // Cópia nova recalcula com a configuração de hoje; revisão mantém a fotografia da original.
    const snapshot = revisionOf ? JSON.parse(JSON.stringify(source.snapshot)) as PricingSnapshot
      : await this.commercial.snapshot(actor.companyId, draft.referenceDate, draft.taxRegime, draft.costBaseId).catch(() => this.commercial.snapshot(actor.companyId, draft.referenceDate, draft.taxRegime));
    await this.fill(actor.companyId, draft, snapshot);
    const result = this.calc(draft, snapshot);
    return this.prisma.$transaction(async (tx) => {
      let numbering: { year: number; sequence: number; number: string; revision?: number; rootId?: number };
      if (revisionOf) {
        const rootId = revisionOf.rootId ?? revisionOf.id;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(740115::int, ${actor.companyId}::int)`;
        const last = await tx.commercial_Proposal.aggregate({ where: { companyId: actor.companyId, OR: [{ id: rootId }, { rootId }] }, _max: { revision: true } });
        const revision = (last._max.revision ?? 0) + 1;
        const root = rootId === revisionOf.id ? revisionOf : await tx.commercial_Proposal.findUniqueOrThrow({ where: { id: rootId } });
        numbering = { year: root.year, sequence: root.sequence, number: `${root.number}-R${revision}`, revision, rootId };
        await tx.commercial_Proposal.update({ where: { id: revisionOf.id }, data: { status: 'substituida' } });
        await this.documents.event(revisionOf, 'revisada', { userId: actor.userId || null, note: `Substituída por ${numbering.number}` }, tx);
      } else {
        numbering = await this.nextNumber(tx, actor.companyId);
      }
      const created = await tx.commercial_Proposal.create({ data: {
        companyId: actor.companyId, ...numbering, kind: draft.kind, customerId: draft.customerId,
        title: revisionOf ? draft.title : `${draft.title} (cópia)`.slice(0, 200),
        referenceDate: asDate(draft.referenceDate), snapshot: {}, createdByUserId: actor.userId || null, dealId: revisionOf ? revisionOf.dealId : null,
      } });
      await this.persist(tx, actor.companyId, created.id, { ...draft, title: revisionOf ? draft.title : `${draft.title} (cópia)`.slice(0, 200) }, snapshot, result);
      return created.id;
    });
  }

  /**
   * Grava a parte do desconto conjunto numa proposta em rascunho e recalcula
   * (mesma fotografia de preço). Devolve o total novo.
   */
  async setDealDiscount(companyId: number, id: number, value: number): Promise<number> {
    const row = await this.prisma.commercial_Proposal.findFirst({ where: { id, companyId }, include: FULL });
    if (!row) throw new NotFoundException('Proposta não encontrada');
    if (row.status !== 'rascunho') throw new ConflictException(`A ${row.number} não está em rascunho: precisa de revisão para mudar o valor`);
    const draft = this.draftOf(row);
    draft.dealDiscount = round2(Math.max(0, value));
    const snapshot = JSON.parse(JSON.stringify(row.snapshot)) as PricingSnapshot;
    await this.fill(companyId, draft, snapshot);
    const result = this.calc(draft, snapshot);
    await this.prisma.$transaction((tx) => this.persist(tx, companyId, id, draft, snapshot, result));
    return round2(result.totals.total);
  }

  /** Proposta já enviada: nasce a revisão em rascunho com o desconto conjunto novo (precisa ser enviada de novo). */
  async reviseWithDealDiscount(actor: Actor, id: number, value: number): Promise<number> {
    const source = await this.byId(actor, id);
    if (!SENT.includes(source.status)) throw new ConflictException(`A ${source.number} não está enviada`);
    return this.copy(actor, source, source, round2(Math.max(0, value)));
  }

  /** Base do rateio: o valor da proposta sem o desconto conjunto (com o desconto dela própria). */
  baseOf(row: { totalNet: Prisma.Decimal | number; dealDiscount: Prisma.Decimal | number }) {
    return round2(Number(row.totalNet) + Number(row.dealDiscount));
  }

  async duplicate(actor: Actor, id: number) {
    const source = await this.byId(actor, id);
    return this.get(actor, await this.copy(actor, source));
  }

  /** Proposta enviada não é editada: nasce uma revisão em rascunho e a anterior fica como substituída. */
  async revise(actor: Actor, id: number) {
    const source = await this.byId(actor, id);
    if (source.inactiveAt) throw new ConflictException('Proposta inativa');
    if (![...SENT, 'recusada', 'expirada'].includes(source.status)) {
      throw new ConflictException(source.status === 'rascunho' ? 'Esta proposta ainda é um rascunho: edite direto' : 'Esta proposta não pode mais ser revisada');
    }
    return this.get(actor, await this.copy(actor, source, source));
  }

  async setStatus(actor: Actor, id: number, body: Body) {
    const row = await this.byId(actor, id);
    if (row.inactiveAt) throw new ConflictException('Proposta inativa');
    const target = String(body.status) as CommercialProposalStatus;
    const allowed: Partial<Record<CommercialProposalStatus, CommercialProposalStatus[]>> = {
      enviada: ['rascunho'], aceita: SENT, recusada: SENT, cancelada: ['rascunho', ...SENT],
    };
    if (!allowed[target]) throw new BadRequestException('Situação inválida');
    if (!allowed[target]!.includes(row.status)) throw new ConflictException(`Uma proposta ${row.status} não pode passar para ${target}`);
    if (target === 'enviada') {
      if (row.validUntil && iso(row.validUntil)! < today()) throw new BadRequestException('A validade da proposta já venceu: ajuste a data antes de enviar');
      if (!row.items.length) throw new BadRequestException('Adicione ao menos um item antes de enviar');
      if (!(Number(row.total) > 0)) throw new BadRequestException('O total da proposta está zerado');
      const plan = row.kind === 'servico' ? parsePlan(row.measurement, row.schedule) : null;
      // locação é cobrada por medição (período a período): não tem parcelas
      if (row.kind === 'locacao') {
        if (!row.items.some((item) => item.type === 'locacao_cliente' && item.stockItemId)) throw new BadRequestException('Adicione ao menos um equipamento do estoque antes de enviar');
      } else if (plan) {
        const problem = planProblem(plan);
        if (problem) throw new BadRequestException(problem);
      } else if (!row.installments.length) throw new BadRequestException('Defina as condições de pagamento antes de enviar');
      const total = Number(row.total);
      const planned = installmentValues(total, row.installments.map((inst) => ({
        percent: inst.percent === null ? null : Number(inst.percent), amount: inst.amount === null ? null : Number(inst.amount),
      }))).reduce((sum, value) => sum + value, 0);
      if (row.kind !== 'locacao' && !plan && Math.abs(planned - total) > 0.005) {
        throw new BadRequestException('As parcelas não somam o total da proposta');
      }
      const marks = workMarksProblem(row.installments.map((inst) => ({ dueRule: inst.dueRule, workPercent: inst.workPercent === null ? null : Number(inst.workPercent) })));
      if (row.kind !== 'locacao' && !plan && marks) throw new BadRequestException(marks);
    }
    // "Enviar por e-mail": o link segue para o e-mail do contato DESTA proposta, exatamente como está nela.
    const notify = target === 'enviada' && (body.notify === true || body.notify === 'true');
    if (notify) {
      if (!this.documents.emailConfigured()) throw new BadRequestException('O envio de e-mail não está configurado. Gere o link e envie por outro canal.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.contactEmail ?? '')) throw new BadRequestException('Informe o e-mail do contato do cliente (passo Proposta, em Mais opções) antes de enviar por e-mail');
    }
    // Ao enviar, o documento é montado e congelado: é ele (e o hash dele) que o cliente lê e aceita.
    let frozen: { frozenHtml: string; frozenHash: string; publicKey: string; documentBody: string; termIds: number[]; itemsMode: string; templateId: number | null } | null = null;
    if (target === 'enviada') {
      const draft = this.draftOf(row);
      const sentAt = new Date();
      const { html, source } = await this.renderFor(actor.companyId, row.number, sentAt, draft, this.calc(draft, row.snapshot as unknown as PricingSnapshot));
      frozen = { frozenHtml: html, frozenHash: sha256(html), publicKey: this.documents.newKey(), documentBody: source.body, termIds: source.termIds, itemsMode: source.itemsMode, templateId: source.templateId };
    }
    const note = clean(body.note, 500) || null;
    await this.prisma.$transaction(async (tx) => {
      await tx.commercial_Proposal.update({ where: { id }, data: {
        status: target, statusNote: note,
        ...(frozen ? { ...frozen, sentAt: new Date() } : {}),
        ...(target === 'aceita' || target === 'recusada' ? { decidedAt: new Date() } : {}),
      } });
      await this.documents.event(row, target, { userId: actor.userId || null, note, documentHash: frozen?.frozenHash ?? row.frozenHash }, tx);
      // aceite registrado à mão também vira contrato
      if (target === 'aceita') {
        // o pedido de compra do cliente pode vir junto com o aceite (o arquivo sobe depois, pela venda)
        const order = this.contracts.customerOrderData({
          ...(body.customerOrderNumber !== undefined ? { number: body.customerOrderNumber } : {}),
          ...(body.customerOrderDate !== undefined ? { date: body.customerOrderDate } : {}),
        });
        await this.contracts.createFromProposal(tx, id, { manual: true, userId: actor.userId || null, note, at: new Date().toISOString() }, order);
      }
    });
    if (['aceita', 'recusada', 'cancelada'].includes(target)) await this.dealEvents.decided(actor.companyId, id);
    if (notify && frozen) {
      // a proposta já está enviada e com link: se o e-mail falhar, avisa em vez de desfazer o envio
      try {
        await this.documents.sendLink({ id, companyId: actor.companyId, number: row.number, title: row.title, publicKey: frozen.publicKey }, { to: row.contactEmail }, actor.userId);
      } catch (error) {
        return { ...(await this.get(actor, id)), emailError: error instanceof Error ? error.message : 'Não foi possível enviar o e-mail' };
      }
    }
    return this.get(actor, id);
  }

  /**
   * Venda rápida: treinamento combinado fora do sistema (WhatsApp, telefone).
   * Cria por baixo uma proposta já aceita (registro manual, sem documento
   * enviado) e o contrato, para a turma cair no mesmo faturamento das outras
   * vendas. Com `classId`, a turma fechada já sai ligada à venda.
   */
  async quickSale(actor: Actor, body: Body) {
    const classId = optional(body.classId, 'Turma', 1, 2147483647);
    const klass = classId ? await this.prisma.courseClass.findFirst({
      where: { id: classId, companyId: actor.companyId }, select: { id: true, name: true, courseId: true, customerId: true, maxSubscriptions: true },
    }) : null;
    if (classId && !klass) throw new NotFoundException('Turma não encontrada');
    if (klass) {
      const billing = await this.prisma.commercial_ClassBilling.findUnique({ where: { classId: klass.id } });
      if (billing?.mode === 'contrato') throw new ConflictException('Esta turma já está ligada a uma venda');
    }
    const customerId = number(body.customerId ?? klass?.customerId, 'Cliente', 1, 2147483647);
    if (klass?.customerId && klass.customerId !== customerId) throw new BadRequestException('A turma é de outro cliente');
    const value = round2(number(body.value, 'Valor da venda', 0.01, 1e11));
    const title = clean(body.title, 200) || (klass ? `Turma fechada — ${klass.name}` : '');
    if (title.length < 2) throw new BadRequestException('Informe o que foi vendido');
    const installments = Array.isArray(body.installments) && body.installments.length ? body.installments : [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 0 }];
    const courseId = klass?.courseId ?? optional(body.courseId, 'Curso', 1, 2147483647);
    const item = (finalValue: number) => ({
      type: 'treinamento', description: clean(body.description, 300) || title, quantity: 1, courseId,
      extra: { students: optional(body.students, 'Alunos', 0, 100000) ?? klass?.maxSubscriptions ?? null }, finalValue,
    });
    const draftBody = (finalValue: number) => ({
      kind: 'treinamento', customerId, title, referenceDate: body.referenceDate, contingencyRate: 0, discount: 0, installments,
      ...('sellerId' in body ? { sellerId: body.sellerId } : {}),
      internalNotes: 'Venda rápida: registrada sem proposta enviada ao cliente.',
      sections: [{ title: 'Treinamentos', kind: 'treinamento', items: [item(finalValue)] }],
    });
    const created = await this.create(actor, draftBody(value));
    const id = Number(created.id);
    // imposto "por fora" (regime híbrido) entra no total: ajusta o item para o total bater com o valor combinado
    const stored = await this.prisma.commercial_Proposal.findUniqueOrThrow({ where: { id }, select: { total: true } });
    if (Number(stored.total) > 0 && Math.abs(Number(stored.total) - value) > 0.005) {
      await this.update(actor, id, draftBody(round2((value * value) / Number(stored.total))));
    }
    const row = await this.byId(actor, id);
    if (!row.installments.length) throw new BadRequestException('Defina as condições de pagamento');
    const note = clean(body.note, 500) || 'Venda rápida';
    const contract = await this.prisma.$transaction(async (tx) => {
      await tx.commercial_Proposal.update({ where: { id }, data: { status: 'aceita', statusNote: note, decidedAt: new Date() } });
      await this.documents.event(row, 'aceita', { userId: actor.userId || null, note }, tx);
      const made = await this.contracts.createFromProposal(tx, id, { manual: true, quick: true, userId: actor.userId || null, note, at: new Date().toISOString() });
      if (klass) await this.contracts.attachClass(tx, actor.companyId, made.id, klass.id, actor.userId || null);
      return made;
    });
    return { proposalId: id, proposalNumber: row.number, contractId: contract.id, contractNumber: contract.number, total: Number(row.total) };
  }

  async setActive(actor: Actor, id: number, active: boolean) {
    const row = await this.byId(actor, id);
    if (!active && !['rascunho', 'cancelada', 'recusada'].includes(row.status)) {
      throw new ConflictException('Só rascunho, cancelada ou recusada pode ser inativada');
    }
    await this.prisma.commercial_Proposal.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } });
    return { id, active };
  }

  // ------------------------------------------------------------------ tabela in-company

  async coursePrices(actor: Actor) {
    const [courses, prices] = await Promise.all([
      this.prisma.course.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, hoursDuration: true } }),
      this.prisma.commercial_CoursePrice.findMany({ where: { companyId: actor.companyId } }),
    ]);
    const priceOf = new Map(prices.map((p) => [p.courseId, p]));
    return courses.map((course) => {
      const p = priceOf.get(course.id);
      return { courseId: course.id, name: course.name, hoursDuration: course.hoursDuration,
        classPrice: p?.classPrice == null ? null : Number(p.classPrice), includedStudents: p?.includedStudents ?? null,
        studentPrice: p?.studentPrice == null ? null : Number(p.studentPrice), notes: p?.notes ?? null };
    });
  }

  async setCoursePrice(actor: Actor, courseId: number, body: Body) {
    const course = await this.prisma.course.findFirst({ where: { id: courseId, companyId: actor.companyId }, select: { id: true } });
    if (!course) throw new NotFoundException('Curso não encontrado');
    const money = (value: unknown, label: string) => { const n = optional(value, label, 0, 1e9); return n === null ? null : round2(n); };
    const data = {
      classPrice: money(body.classPrice, 'Preço da turma'), studentPrice: money(body.studentPrice, 'Preço por aluno'),
      includedStudents: blank(body.includedStudents) ? null : Math.round(number(body.includedStudents, 'Alunos incluídos', 0, 100000)),
      notes: clean(body.notes, 255) || null,
    };
    await this.prisma.commercial_CoursePrice.upsert({
      where: { companyId_courseId: { companyId: actor.companyId, courseId } }, update: data, create: { companyId: actor.companyId, courseId, ...data },
    });
    return (await this.coursePrices(actor)).find((row) => row.courseId === courseId);
  }
}
