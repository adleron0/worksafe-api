import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommercialDueRule, CommercialItemType, CommercialProposalKind, CommercialProposalStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CommercialService, PricingSnapshot } from './commercial.service';
import { computeBase, price, PriceInput, PriceItemInput, PriceResult, PricingError, professionalCost, resolveTax, round2 } from './pricing/engine';

type Body = Record<string, any>;
type Tx = Prisma.TransactionClient;
export interface Actor { userId: number; companyId: number; canSeeCosts: boolean }

const KINDS: CommercialProposalKind[] = ['servico', 'treinamento', 'misto'];
const ITEM_TYPES: CommercialItemType[] = ['mao_de_obra', 'locacao', 'material', 'treinamento', 'avulso'];
const DUE_RULES: CommercialDueRule[] = ['data_fixa', 'dias_apos_aceite', 'dias_apos_nf', 'dias_apos_conclusao'];
/** Ainda em negociação: pode ser revisada, cancelada ou decidida. */
const SENT: CommercialProposalStatus[] = ['enviada', 'visualizada'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Seções com que cada tipo de proposta nasce. */
const PRESETS: Record<CommercialProposalKind, Array<{ title: string; kind: CommercialItemType }>> = {
  servico: [{ title: 'Mão de obra', kind: 'mao_de_obra' }, { title: 'Locações', kind: 'locacao' }, { title: 'Materiais de consumo', kind: 'material' }],
  treinamento: [{ title: 'Treinamentos', kind: 'treinamento' }],
  misto: [{ title: 'Treinamentos', kind: 'treinamento' }, { title: 'Mão de obra', kind: 'mao_de_obra' }, { title: 'Locações', kind: 'locacao' }, { title: 'Materiais de consumo', kind: 'material' }],
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

/**
 * Valor de cada parcela, em centavos fechados. Percentual é sobre o total já
 * arredondado; quando as parcelas são todas percentuais e somam 100%, a última
 * absorve o centavo que sobrar, para a soma bater com o total.
 */
export function installmentValues(total: number, installments: Array<{ percent: number | null; amount: number | null }>): number[] {
  const rounded = round2(total);
  const values = installments.map((inst) => round2(inst.percent !== null ? rounded * inst.percent : inst.amount ?? 0));
  const allPercent = installments.length > 0 && installments.every((inst) => inst.percent !== null);
  const percentSum = installments.reduce((sum, inst) => sum + (inst.percent ?? 0), 0);
  if (allPercent && Math.abs(percentSum - 1) < 1e-6) {
    const others = values.slice(0, -1).reduce((sum, value) => sum + value, 0);
    values[values.length - 1] = round2(rounded - others);
  }
  return values;
}

export interface DraftItem {
  id?: number; type: CommercialItemType; description: string; unit: string | null; quantity: number;
  professionalId: number | null; night: boolean; travel: boolean; weekend: boolean;
  workDays: number | null; weekendDays: number | null; hoursPerDay: number | null;
  courseId: number | null; extra: { students?: number | null; workload?: number | null; dates?: string; location?: string } | null;
  unitCost: number; extraCost: number; margin: number | null; finalValue: number | null; showInDocument: boolean;
}
export interface DraftSection { id?: number; title: string; kind: CommercialItemType; margin: number; showInDocument: boolean; items: DraftItem[] }
export interface DraftInstallment { percent: number | null; amount: number | null; dueRule: CommercialDueRule; dueDate: string | null; dueDays: number | null; description: string | null }
export interface Draft {
  kind: CommercialProposalKind; customerId: number; contactName: string | null; contactEmail: string | null; contactPhone: string | null;
  requester: string | null; department: string | null; title: string; description: string | null; sellerId: number | null;
  validUntil: string | null; referenceDate: string; workDays: number; weekendDays: number;
  contingencyRate: number; commissionRate: number; commissionBase: 'faturado' | 'lucro'; commissionInPrice: boolean;
  taxRegime: 'tradicional' | 'hibrido' | null; discount: number; internalNotes: string | null;
  sections: DraftSection[]; installments: DraftInstallment[];
}

type ProposalRow = Prisma.Commercial_ProposalGetPayload<{ include: { sections: true; items: true; installments: true; customer: { select: { id: true; name: true; corporateName: true; cnpj: true; email: true; phone: true } } } }>;
const FULL = {
  sections: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
  items: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
  installments: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
  customer: { select: { id: true, name: true, corporateName: true, cnpj: true, email: true, phone: true } },
};

@Injectable()
export class ProposalService {
  constructor(private readonly prisma: PrismaService, private readonly commercial: CommercialService) {}

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
          courseId: type === 'treinamento' ? optional(entry.courseId, 'Curso', 1, 2147483647) : null,
          extra: type === 'treinamento' ? extra : null,
          unitCost: type === 'mao_de_obra' ? 0 : round2(number(entry.unitCost, `Custo de ${label}`, 0, 1e10, 0)),
          extraCost: type === 'mao_de_obra' ? 0 : round2(number(entry.extraCost, `Taxas de ${label}`, 0, 1e10, 0)),
          margin: actor.canSeeCosts ? optional(entry.margin, `Margem de ${label}`, 0, 0.95) : (itemId ? itemMarginOf.get(itemId) ?? null : null),
          finalValue: blank(entry.finalValue) ? null : round2(number(entry.finalValue, `Valor de ${label}`, 0, 1e11)),
          showInDocument: entry.showInDocument !== false && entry.showInDocument !== 'false',
        };
      });
      return { id, title: sectionTitle, kind: sectionKind, margin, showInDocument: raw.showInDocument !== false && raw.showInDocument !== 'false', items };
    });

    const rawInstallments = Array.isArray(body.installments) ? body.installments : [];
    if (rawInstallments.length > 60) throw new BadRequestException('Parcelas demais');
    const installments = rawInstallments.map((raw: Body, index: number): DraftInstallment => {
      const label = `Parcela ${index + 1}`;
      const percent = optional(raw.percent, `${label} — percentual`, 0, 1);
      const amount = optional(raw.amount, `${label} — valor`, 0, 1e11);
      if ((percent === null) === (amount === null)) throw new BadRequestException(`${label}: informe o percentual ou o valor`);
      const dueRule = (DUE_RULES.includes(raw.dueRule) ? raw.dueRule : 'dias_apos_nf') as CommercialDueRule;
      const dueDate = dueRule === 'data_fixa' ? dateOf(raw.dueDate, `${label} — vencimento`) : null;
      const dueDays = dueRule === 'data_fixa' ? null : Math.round(number(raw.dueDays, `${label} — dias`, 0, 3650, 0));
      return { percent, amount: amount === null ? null : round2(amount), dueRule, dueDate, dueDays, description: clean(raw.description, 200) || null };
    });

    const commission = (body.commission ?? {}) as Body;
    const commissionDefault = defaults.commission ?? {};
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
      discount: round2(number(body.discount, 'Desconto', 0, 1e11, 0)),
      sections, installments,
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
    for (const item of items) {
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

  private calc(draft: Draft, snapshot: PricingSnapshot): PriceResult & { taxResult: ReturnType<typeof resolveTax> } {
    try {
      const base = computeBase(snapshot.params, snapshot.items, snapshot.date);
      const tax = resolveTax(snapshot.tax.input);
      const input: PriceInput = {
        workDays: draft.workDays, weekendDays: draft.weekendDays, contingencyRate: draft.contingencyRate, discount: draft.discount,
        commission: { rate: draft.commissionRate, base: draft.commissionBase, inPrice: draft.commissionInPrice },
        sections: draft.sections.map((section) => ({
          margin: section.margin,
          items: section.items.map((item): PriceItemInput => item.type === 'mao_de_obra'
            ? { type: item.type, quantity: item.quantity, salary: snapshot.salaries[item.professionalId!].salary, night: item.night, travel: item.travel, weekend: item.weekend,
              workDays: item.workDays ?? undefined, weekendDays: item.weekendDays ?? undefined, hoursPerDay: item.hoursPerDay ?? undefined, margin: item.margin, finalValue: item.finalValue }
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
          listPrice: draft.sections[s].items[i].type === 'treinamento' ? r(this.listPrice(draft.sections[s].items[i], snapshot)) : null,
          ...(see ? { cost: r(line.cost), margin: rate(line.margin), hourCost: r(line.hourCost) } : {}),
        })),
      })),
      totals: {
        suggested: r(t.suggested), subtotal: r(t.subtotal), contingency: r(t.contingency), discount: r(t.discount), net: r(t.net),
        taxOutside: r(t.taxOutside), total: r(t.total),
        ...(see ? { cost: r(t.cost), taxInside: r(t.taxInside), tax: r(t.tax), profit: r(t.profit), profitRate: rate(t.profitRate), commission: r(t.commission),
          customerCredit: r(t.customerCredit), customerCost: r(t.customerCost) } : {}),
      },
      installments, installmentsTotal: r(planned), installmentsDiff: r(round2(t.total) - planned),
      ...(see ? {
        margin: Object.fromEntries(Object.entries(result.margin).map(([key, value]) => [key, key.endsWith('Rate') ? rate(value) : r(value)])),
        tax: { name: snapshot.tax.name, regime: result.taxResult.regime, inside: rate(result.taxResult.inside), outside: rate(result.taxResult.outside) },
        costBase: snapshot.costBase.name,
      } : { tax: { regime: result.taxResult.regime, outside: rate(result.taxResult.outside) } }),
    };
  }

  // ------------------------------------------------------------------ apoio

  private async assertRefs(companyId: number, draft: Draft) {
    const customer = await this.prisma.customer.findFirst({ where: { id: draft.customerId, companyId }, select: { id: true } });
    if (!customer) throw new BadRequestException('Cliente não encontrado');
    if (draft.sellerId) {
      const seller = await this.prisma.user.findFirst({ where: { id: draft.sellerId, companyId }, select: { id: true } });
      if (!seller) throw new BadRequestException('Vendedor não encontrado');
    }
  }

  private async byId(companyId: number, id: number): Promise<ProposalRow> {
    const row = await this.prisma.commercial_Proposal.findFirst({ where: { id, companyId }, include: FULL });
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
      sections: row.sections.map((section) => ({
        id: section.id, title: section.title, kind: section.kind, margin: Number(section.margin), showInDocument: section.showInDocument,
        items: row.items.filter((item) => item.sectionId === section.id).map((item) => ({
          id: item.id, type: item.type, description: item.description, unit: item.unit, quantity: Number(item.quantity),
          professionalId: item.professionalId, night: item.night, travel: item.travel, weekend: item.weekend,
          workDays: item.workDays, weekendDays: item.weekendDays, hoursPerDay: n(item.hoursPerDay), courseId: item.courseId,
          extra: (item.extra as DraftItem['extra']) ?? null, unitCost: Number(item.unitCost), extraCost: Number(item.extraCost),
          margin: n(item.margin), finalValue: n(item.finalValue), showInDocument: item.showInDocument,
        })),
      })),
      installments: row.installments.map((inst) => ({
        percent: n(inst.percent), amount: n(inst.amount), dueRule: inst.dueRule, dueDate: iso(inst.dueDate), dueDays: inst.dueDays, description: inst.description,
      })),
    };
  }

  /** Grava cabeçalho, seções, itens e parcelas de uma vez (substitui os filhos). */
  private async persist(tx: Tx, companyId: number, id: number, draft: Draft, snapshot: PricingSnapshot, result: ReturnType<ProposalService['calc']>) {
    const t = result.totals;
    const { sections, installments, ...header } = draft;
    await tx.commercial_Proposal.update({ where: { id }, data: {
      ...header, validUntil: header.validUntil ? asDate(header.validUntil) : null, referenceDate: asDate(header.referenceDate),
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
      sentAt: row.sentAt, decidedAt: row.decidedAt, statusNote: row.statusNote, createdAt: row.createdAt, updatedAt: row.updatedAt,
      // só interessa avisar quando ainda dá para recalcular
      baseOutdated: editable ? !(await this.commercial.snapshotIsCurrent(row.companyId, snapshot, row.taxRegime)) : false,
      baseCapturedAt: snapshot.capturedAt,
      versions: versions.map((v) => ({ ...v, total: Number(v.total) })),
      draft: actor.canSeeCosts ? draft : this.hideMargins(draft),
      calc: this.view(draft, result, snapshot, actor),
    };
  }

  private hideMargins(draft: Draft) {
    const { commissionRate: _r, commissionBase: _b, commissionInPrice: _p, ...rest } = draft;
    return { ...rest, sections: draft.sections.map(({ margin: _m, ...section }) => ({ ...section, items: section.items.map(({ margin: _im, ...item }) => item) })) };
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
      this.prisma.user.findMany({ where: { companyId: actor.companyId, inactiveAt: null, isSeller: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    const priceOf = new Map(prices.map((p) => [p.courseId, p]));
    const defaults = snapshot.defaults ?? {};
    return {
      date, canSeeCosts: actor.canSeeCosts,
      defaults: {
        contingencyLevels: defaults.contingencyLevels ?? [], contingencyRate: defaults.contingencyRate ?? 0,
        ...(actor.canSeeCosts ? { margins: defaults.margins ?? {}, commission: defaults.commission ?? {} } : {}),
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
      sellers,
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
        contacts: { where: { inactiveAt: null }, select: { id: true, name: true, email: true, phone: true }, orderBy: { name: 'asc' } } },
    });
    return rows;
  }

  async list(actor: Actor, query: Record<string, string>) {
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const status = query.status as CommercialProposalStatus | undefined;
    const term = clean(query.search, 80);
    const scope: Prisma.Commercial_ProposalWhereInput = {
      companyId: actor.companyId,
      ...(query.inactive === 'true' ? {} : { inactiveAt: null }),
      ...(KINDS.includes(query.kind as CommercialProposalKind) ? { kind: query.kind as CommercialProposalKind } : {}),
      ...(Number(query.customerId) > 0 ? { customerId: Number(query.customerId) } : {}),
      ...(Number(query.sellerId) > 0 ? { sellerId: Number(query.sellerId) } : {}),
      ...(term ? { OR: [
        { number: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } },
        { customer: { name: { contains: term, mode: 'insensitive' } } }, { customer: { corporateName: { contains: term, mode: 'insensitive' } } },
      ] } : {}),
    };
    // Versões substituídas só aparecem quando pedidas pelo status.
    const where: Prisma.Commercial_ProposalWhereInput = { ...scope, status: status && Object.values(CommercialProposalStatus).includes(status) ? status : { not: 'substituida' } };
    const [rows, total, groups] = await Promise.all([
      this.prisma.commercial_Proposal.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page * limit, take: limit,
        select: { id: true, number: true, revision: true, kind: true, status: true, title: true, total: true, validUntil: true, createdAt: true, sentAt: true,
          inactiveAt: true, sellerId: true, customer: { select: { id: true, name: true } } },
      }),
      this.prisma.commercial_Proposal.count({ where }),
      this.prisma.commercial_Proposal.groupBy({ by: ['status'], where: scope, _count: { _all: true }, _sum: { total: true } }),
    ]);
    const sellerIds = [...new Set(rows.map((r) => r.sellerId).filter((id): id is number => !!id))];
    const sellers = sellerIds.length ? await this.prisma.user.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true } }) : [];
    const sellerName = new Map(sellers.map((s) => [s.id, s.name]));
    return {
      total,
      rows: rows.map((row) => ({
        ...row, total: Number(row.total), validUntil: iso(row.validUntil), seller: row.sellerId ? sellerName.get(row.sellerId) ?? null : null,
        expired: SENT.includes(row.status) && !!row.validUntil && iso(row.validUntil)! < today(),
      })),
      summary: Object.fromEntries(groups.map((g) => [g.status, { count: g._count._all, total: Number(g._sum.total ?? 0) }])),
    };
  }

  async get(actor: Actor, id: number) {
    return this.present(await this.byId(actor.companyId, id), actor);
  }

  /** Calcula o rascunho da tela sem gravar. Com `id`, usa a fotografia da proposta. */
  async preview(actor: Actor, body: Body) {
    const existing = Number(body.id) > 0 ? await this.byId(actor.companyId, Number(body.id)) : undefined;
    const snapshot = await this.snapshotFor(actor.companyId, body, existing);
    const draft = this.parse({ ...body, title: clean(body.title) || 'Rascunho', customerId: body.customerId || existing?.customerId || 1 }, actor, snapshot, existing);
    await this.fill(actor.companyId, draft, snapshot);
    return this.view(draft, this.calc(draft, snapshot), snapshot, actor);
  }

  /** Fotografia a usar: a guardada, salvo se pedirem para recalcular ou se a data/regime mudaram. */
  private async snapshotFor(companyId: number, body: Body, existing?: ProposalRow): Promise<PricingSnapshot> {
    const date = blank(body.referenceDate) ? (existing ? iso(existing.referenceDate)! : today()) : dateOf(body.referenceDate, 'Data prevista');
    const regime = body.taxRegime === 'tradicional' || body.taxRegime === 'hibrido' ? body.taxRegime : 'taxRegime' in body ? null : existing?.taxRegime ?? null;
    if (existing && !bool(body.refreshBase)) {
      const stored = existing.snapshot as unknown as PricingSnapshot;
      const sameRegime = (existing.taxRegime ?? null) === regime;
      if (stored?.date === date && sameRegime) return JSON.parse(JSON.stringify(stored));
    }
    return this.commercial.snapshot(companyId, date, regime);
  }

  async create(actor: Actor, body: Body) {
    const snapshot = await this.snapshotFor(actor.companyId, body);
    // Sem seções no corpo, a proposta nasce com as do tipo escolhido.
    const kind = (KINDS.includes(body.kind) ? body.kind : 'servico') as CommercialProposalKind;
    const seeded = Array.isArray(body.sections) ? body : { ...body, sections: PRESETS[kind].map((section) => ({ ...section, items: [] })) };
    const draft = this.parse(seeded, actor, snapshot);
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
    const existing = await this.byId(actor.companyId, id);
    if (existing.inactiveAt) throw new ConflictException('Proposta inativa');
    if (existing.status !== 'rascunho') throw new ConflictException('Só rascunho pode ser editado. Para mudar uma proposta enviada, crie uma revisão.');
    const snapshot = await this.snapshotFor(actor.companyId, body, existing);
    const draft = this.parse(body, actor, snapshot, existing);
    await this.assertRefs(actor.companyId, draft);
    await this.fill(actor.companyId, draft, snapshot);
    const result = this.calc(draft, snapshot);
    await this.prisma.$transaction((tx) => this.persist(tx, actor.companyId, id, draft, snapshot, result));
    return this.get(actor, id);
  }

  /** Copia uma proposta existente para outra linha. `revisionOf` faz a cópia virar a revisão seguinte. */
  private async copy(actor: Actor, source: ProposalRow, revisionOf?: ProposalRow) {
    const draft = this.draftOf(source);
    // Cópia nova recalcula com a configuração de hoje; revisão mantém a fotografia da original.
    const snapshot = revisionOf ? JSON.parse(JSON.stringify(source.snapshot)) as PricingSnapshot
      : await this.commercial.snapshot(actor.companyId, draft.referenceDate, draft.taxRegime);
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
      } else {
        numbering = await this.nextNumber(tx, actor.companyId);
      }
      const created = await tx.commercial_Proposal.create({ data: {
        companyId: actor.companyId, ...numbering, kind: draft.kind, customerId: draft.customerId,
        title: revisionOf ? draft.title : `${draft.title} (cópia)`.slice(0, 200),
        referenceDate: asDate(draft.referenceDate), snapshot: {}, createdByUserId: actor.userId || null,
      } });
      await this.persist(tx, actor.companyId, created.id, { ...draft, title: revisionOf ? draft.title : `${draft.title} (cópia)`.slice(0, 200) }, snapshot, result);
      return created.id;
    });
  }

  async duplicate(actor: Actor, id: number) {
    const source = await this.byId(actor.companyId, id);
    return this.get(actor, await this.copy(actor, source));
  }

  /** Proposta enviada não é editada: nasce uma revisão em rascunho e a anterior fica como substituída. */
  async revise(actor: Actor, id: number) {
    const source = await this.byId(actor.companyId, id);
    if (source.inactiveAt) throw new ConflictException('Proposta inativa');
    if (![...SENT, 'recusada', 'expirada'].includes(source.status)) {
      throw new ConflictException(source.status === 'rascunho' ? 'Esta proposta ainda é um rascunho: edite direto' : 'Esta proposta não pode mais ser revisada');
    }
    return this.get(actor, await this.copy(actor, source, source));
  }

  async setStatus(actor: Actor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    if (row.inactiveAt) throw new ConflictException('Proposta inativa');
    const target = String(body.status) as CommercialProposalStatus;
    const allowed: Partial<Record<CommercialProposalStatus, CommercialProposalStatus[]>> = {
      enviada: ['rascunho'], aceita: SENT, recusada: SENT, cancelada: ['rascunho', ...SENT],
    };
    if (!allowed[target]) throw new BadRequestException('Situação inválida');
    if (!allowed[target]!.includes(row.status)) throw new ConflictException(`Uma proposta ${row.status} não pode passar para ${target}`);
    if (target === 'enviada') {
      if (!row.items.length) throw new BadRequestException('Adicione ao menos um item antes de enviar');
      if (!(Number(row.total) > 0)) throw new BadRequestException('O total da proposta está zerado');
      if (!row.installments.length) throw new BadRequestException('Defina as condições de pagamento antes de enviar');
      const total = Number(row.total);
      const planned = installmentValues(total, row.installments.map((inst) => ({
        percent: inst.percent === null ? null : Number(inst.percent), amount: inst.amount === null ? null : Number(inst.amount),
      }))).reduce((sum, value) => sum + value, 0);
      if (Math.abs(planned - total) > 0.005) {
        throw new BadRequestException('As parcelas não somam o total da proposta');
      }
    }
    await this.prisma.commercial_Proposal.update({ where: { id }, data: {
      status: target, statusNote: clean(body.note, 500) || null,
      ...(target === 'enviada' ? { sentAt: new Date() } : {}),
      ...(target === 'aceita' || target === 'recusada' ? { decidedAt: new Date() } : {}),
    } });
    return this.get(actor, id);
  }

  async setActive(actor: Actor, id: number, active: boolean) {
    const row = await this.byId(actor.companyId, id);
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
