import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  BaseResult, computeBase, CostBaseParams, CostItem, price, PriceInput, PricingError, professionalCost,
  resolveTax, rounded, TaxBracket, TaxProfileInput,
} from './pricing/engine';
import {
  SHEET_BRACKETS, SHEET_DEFAULTS, SHEET_ITEMS, SHEET_PARAMS, SHEET_PROFESSIONALS, SHEET_RBT12,
} from './pricing/spreadsheet-seed';

type Tx = Prisma.TransactionClient;
type Body = Record<string, unknown>;

/** Campos numéricos da base: [mínimo, máximo]. Tudo fora disso é erro de digitação. */
const PARAM_RULES: Record<Exclude<keyof CostBaseParams, 'weekendPerWorker'>, [number, number]> = {
  daysInYear: [1, 366], restDays: [0, 366], vacationDays: [0, 366], holidays: [0, 366],
  hoursPerDay: [0.5, 24], idleRate: [0, 0.99], monthsDivisor: [1, 12],
  additionalDivisor: [1, 744], nightRate: [0, 5], travelRate: [0, 5], weekendRate: [0, 5],
  mealPerDay: [0, 100000], transportFare: [0, 100000], transportTrips: [0, 100], transportDiscount: [0, 1],
  fareDiscountRate: [0, 1], headcount: [0.01, 100000],
};
const PARAM_LABELS: Record<string, string> = {
  daysInYear: 'Dias no ano', restDays: 'DSR', vacationDays: 'Férias', holidays: 'Feriados', hoursPerDay: 'Horas por dia',
  idleRate: 'Índice de ociosidade', monthsDivisor: 'Divisor de meses', additionalDivisor: 'Divisor dos adicionais',
  nightRate: 'Adicional noturno', travelRate: 'Adicional de viagem', weekendRate: 'Adicional de FDS/feriado',
  mealPerDay: 'Alimentação por dia', transportFare: 'Tarifa de transporte', transportTrips: 'Passagens por dia',
  transportDiscount: 'Desconto do transporte', fareDiscountRate: 'Desconto de vale-transporte', headcount: 'Efetivo médio',
};
const GROUPS = ['encargo', 'pessoal_indireto', 'outro_custo'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ');
const blank = (value: unknown) => value === undefined || value === null || value === '';
const today = () => new Date().toISOString().slice(0, 10);
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const bool = (value: unknown) => value === true || value === 'true';

function number(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  if (blank(value) || !Number.isFinite(n)) throw new BadRequestException(`${label}: informe um número`);
  if (n < min || n > max) throw new BadRequestException(`${label}: valor fora do intervalo permitido`);
  return n;
}

function dateOf(value: unknown, label: string): string {
  const text = String(value ?? '').slice(0, 10);
  if (!DATE.test(text) || Number.isNaN(asDate(text).getTime())) throw new BadRequestException(`${label}: data inválida`);
  return text;
}

/** Erro de conta do motor vira 400 legível, não 500. */
function guarded<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof PricingError) throw new BadRequestException(error.message);
    throw error;
  }
}

type BaseRow = Prisma.Commercial_CostBaseGetPayload<{ include: { items: true } }>;
type TaxRow = Prisma.Commercial_TaxProfileGetPayload<Record<string, never>>;

const paramsOf = (row: Record<string, any>): CostBaseParams => ({
  ...(Object.fromEntries(Object.keys(PARAM_RULES).map((key) => [key, Number(row[key])])) as Omit<CostBaseParams, 'weekendPerWorker'>),
  weekendPerWorker: row.weekendPerWorker === true,
});

const itemOf = (row: Record<string, any>): CostItem & { id?: number; subgroup: string | null; name: string; order: number } => ({
  id: row.id, group: row.group, subgroup: row.subgroup ?? null, name: row.name,
  rate: row.rate === null || row.rate === undefined ? null : Number(row.rate),
  amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
  quantity: Number(row.quantity ?? 1), withCharges: row.withCharges !== false, kind: row.kind ?? 'fixo',
  isDebt: row.isDebt === true, endsAt: row.endsAt instanceof Date ? iso(row.endsAt) : row.endsAt ?? null, order: row.order ?? 0,
});

const taxInputOf = (row: TaxRow): TaxProfileInput => ({
  regime: row.regime, mode: row.mode, rbt12: Number(row.rbt12),
  manualRate: row.manualRate === null ? null : Number(row.manualRate),
  ibsCbsShare: Number(row.ibsCbsShare), outsideRate: Number(row.outsideRate),
  brackets: (row.brackets as unknown as TaxBracket[]) ?? [],
});

@Injectable()
export class CommercialService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ carga

  /**
   * Carrega a base da planilha FORM-COM-001 na primeira vez que a empresa
   * abre o Comercial: uma versão da base, os 16 profissionais e os dois
   * perfis tributários (tradicional, que é o padrão, e híbrido).
   */
  async ensureSeed(companyId: number): Promise<void> {
    if (await this.prisma.commercial_CostBase.findFirst({ where: { companyId }, select: { id: true } })) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(740114::int, ${companyId}::int)`;
      if (await tx.commercial_CostBase.findFirst({ where: { companyId }, select: { id: true } })) return;
      const start = asDate('2026-01-01');
      await tx.commercial_CostBase.create({ data: {
        companyId, name: 'Base da planilha FORM-COM-001', effectiveFrom: start,
        notes: 'Carga inicial com os valores da planilha de formação de preços.',
        ...SHEET_PARAMS, defaults: SHEET_DEFAULTS,
        items: { create: SHEET_ITEMS.map((item, order) => ({
          companyId, group: item.group, subgroup: item.subgroup, name: item.name, rate: item.rate ?? null, amount: item.amount ?? null,
          quantity: item.quantity ?? 1, withCharges: item.withCharges !== false, kind: item.kind ?? 'fixo', isDebt: item.isDebt === true, order,
        })) },
      } });
      if (!(await tx.commercial_Professional.findFirst({ where: { companyId }, select: { id: true } }))) {
        await tx.commercial_Professional.createMany({ data: SHEET_PROFESSIONALS.map((p) => ({ companyId, ...p })) });
      }
      if (!(await tx.commercial_TaxProfile.findFirst({ where: { companyId }, select: { id: true } }))) {
        const common = { companyId, effectiveFrom: start, rbt12: SHEET_RBT12, ibsCbsShare: 0.166, outsideRate: 0.091, brackets: SHEET_BRACKETS as unknown as Prisma.InputJsonValue };
        await tx.commercial_TaxProfile.create({ data: {
          ...common, name: 'Simples Nacional — Anexo III', regime: 'tradicional', mode: 'nominal', isDefault: true,
          notes: 'Como na planilha: alíquota nominal da faixa. Confirmar RBT12 e faixa com a contabilidade.',
        } });
        await tx.commercial_TaxProfile.create({ data: {
          ...common, name: 'Simples híbrido — Anexo III', regime: 'hibrido', mode: 'nominal',
          notes: 'Valores de exemplo: a parte de IBS/CBS no DAS (16,6%) e a alíquota por fora (9,1%) precisam ser confirmadas com a contabilidade.',
        } });
      }
    });
  }

  // ------------------------------------------------------------------ resolução

  private async baseById(companyId: number, id: number): Promise<BaseRow> {
    const row = await this.prisma.commercial_CostBase.findFirst({ where: { id, companyId }, include: { items: { orderBy: [{ order: 'asc' }, { id: 'asc' }] } } });
    if (!row) throw new NotFoundException('Versão da base de cálculo não encontrada');
    return row;
  }

  /** Versão vigente na data: a de maior vigência que não passa dela (ou a mais antiga, se todas são futuras). */
  private async currentBase(companyId: number, date: string): Promise<BaseRow> {
    await this.ensureSeed(companyId);
    const include = { items: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] } };
    const row = (await this.prisma.commercial_CostBase.findFirst({
      where: { companyId, inactiveAt: null, effectiveFrom: { lte: asDate(date) } }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }], include,
    })) ?? (await this.prisma.commercial_CostBase.findFirst({ where: { companyId, inactiveAt: null }, orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }], include }));
    if (!row) throw new NotFoundException('Nenhuma base de cálculo ativa');
    return row;
  }

  /**
   * Perfil tributário em uso na data. A chave tradicional ⟷ híbrido é o
   * `isDefault`: ele escolhe o REGIME; dentro do regime vale a versão vigente.
   */
  private async currentTax(companyId: number, date: string, regime?: string): Promise<TaxRow> {
    await this.ensureSeed(companyId);
    const all = await this.prisma.commercial_TaxProfile.findMany({ where: { companyId, inactiveAt: null }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }] });
    if (!all.length) throw new NotFoundException('Nenhum perfil tributário ativo');
    const wanted = regime === 'tradicional' || regime === 'hibrido' ? regime : (all.find((p) => p.isDefault) ?? all[0]).regime;
    const sameRegime = all.filter((p) => p.regime === wanted);
    const pool = sameRegime.length ? sameRegime : all;
    const limit = asDate(date).getTime();
    return pool.find((p) => p.effectiveFrom.getTime() <= limit) ?? pool[pool.length - 1];
  }

  private async professionals(companyId: number) {
    return this.prisma.commercial_Professional.findMany({ where: { companyId, inactiveAt: null }, orderBy: { name: 'asc' } });
  }

  private table(params: CostBaseParams, base: BaseResult, rows: Array<{ id: number; name: string; salary: Prisma.Decimal | number }>) {
    return rows.map((row) => ({ id: row.id, name: row.name, ...professionalCost(Number(row.salary), params, base) }));
  }

  /** Quanto o custo hora muda com o efetivo: o número mais sensível da base. */
  private sensitivity(params: CostBaseParams, items: CostItem[], date: string, pros: Array<{ name: string; salary: Prisma.Decimal | number }>) {
    if (!pros.length) return [];
    // Referência: o profissional de salário mediano.
    const reference = [...pros].sort((x, y) => Number(x.salary) - Number(y.salary))[Math.floor((pros.length - 1) / 2)];
    const salary = Number(reference.salary);
    const current = params.headcount;
    const steps = [...new Set([Math.max(1, Math.round(current * 0.7)), current, Math.round(current * 1.3)])];
    return steps.map((headcount) => {
      const base = computeBase({ ...params, headcount }, items, date);
      return { headcount, overhead: base.D + base.E, hourCost: professionalCost(salary, { ...params, headcount }, base).hourCost, current: headcount === current, professional: reference.name };
    });
  }

  private present(row: BaseRow, date: string, pros: Awaited<ReturnType<CommercialService['professionals']>>) {
    const params = paramsOf(row);
    const items = row.items.map(itemOf);
    return guarded(() => {
      const result = computeBase(params, items, date);
      return {
        id: row.id, name: row.name, effectiveFrom: iso(row.effectiveFrom), notes: row.notes, inactiveAt: row.inactiveAt,
        weeklyHours: Number(row.weeklyHours), params, defaults: row.defaults as Record<string, any>, items,
        ...rounded({
          result,
          professionals: this.table(params, result, pros),
          sensitivity: this.sensitivity(params, items, date, pros),
        }),
      };
    });
  }

  // ------------------------------------------------------------------ base de custos

  async listBases(companyId: number, date = today()) {
    const current = await this.currentBase(companyId, date);
    const rows = await this.prisma.commercial_CostBase.findMany({
      where: { companyId }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      select: { id: true, name: true, effectiveFrom: true, notes: true, inactiveAt: true, headcount: true, additionalDivisor: true, weeklyHours: true },
    });
    return rows.map((row) => ({
      ...row, effectiveFrom: iso(row.effectiveFrom), headcount: Number(row.headcount),
      additionalDivisor: Number(row.additionalDivisor), weeklyHours: Number(row.weeklyHours), current: row.id === current.id,
    }));
  }

  async getBase(companyId: number, id: number | 'current', date = today()) {
    const row = id === 'current' ? await this.currentBase(companyId, date) : await this.baseById(companyId, id);
    return this.present(row, date, await this.professionals(companyId));
  }

  private parseParams(body: Body, fallback?: Record<string, any>): CostBaseParams & { weeklyHours: number } {
    const source = (body.params ?? body) as Body;
    const out: Record<string, number | boolean> = {};
    for (const [key, [min, max]] of Object.entries(PARAM_RULES)) {
      const value = key in source ? source[key] : fallback?.[key];
      out[key] = number(value, PARAM_LABELS[key], min, max);
    }
    out.weekendPerWorker = 'weekendPerWorker' in source ? bool(source.weekendPerWorker) : fallback?.weekendPerWorker === true;
    out.weeklyHours = number('weeklyHours' in source ? source.weeklyHours : fallback?.weeklyHours ?? 44, 'Jornada semanal', 1, 168);
    return out as unknown as CostBaseParams & { weeklyHours: number };
  }

  private parseItems(raw: unknown) {
    if (!Array.isArray(raw)) throw new BadRequestException('Itens da base inválidos');
    if (raw.length > 400) throw new BadRequestException('Itens demais na base de cálculo');
    return raw.map((entry: Body, order) => {
      const group = String(entry.group) as (typeof GROUPS)[number];
      if (!GROUPS.includes(group)) throw new BadRequestException('Grupo de item inválido');
      const name = clean(entry.name);
      if (name.length < 2) throw new BadRequestException('Todo item da base precisa de um nome');
      const label = `"${name}"`;
      const endsAt = blank(entry.endsAt) ? null : dateOf(entry.endsAt, `${label} — término`);
      return {
        group, subgroup: clean(entry.subgroup).slice(0, 80) || null, name: name.slice(0, 160),
        rate: group === 'encargo' ? number(entry.rate ?? 0, label, 0, 5) : null,
        amount: group === 'encargo' ? null : Math.round(number(entry.amount ?? 0, label, 0, 1e10) * 100) / 100,
        quantity: group === 'encargo' ? 1 : number(blank(entry.quantity) ? 1 : entry.quantity, `${label} — quantidade`, 0, 100000),
        withCharges: group === 'pessoal_indireto' ? entry.withCharges !== false && entry.withCharges !== 'false' : true,
        kind: (group === 'outro_custo' && entry.kind === 'por_pessoa' ? 'por_pessoa' : 'fixo') as 'fixo' | 'por_pessoa',
        isDebt: group === 'outro_custo' && bool(entry.isDebt),
        endsAt, order,
      };
    });
  }

  private parseDefaults(raw: unknown, fallback: unknown) {
    const source = (raw && typeof raw === 'object' ? raw : fallback ?? SHEET_DEFAULTS) as Record<string, any>;
    const rate = (value: unknown, label: string, max = 0.95) => number(value ?? 0, label, 0, max);
    const margins = Object.fromEntries(Object.keys(SHEET_DEFAULTS.margins).map((key) => [key, rate(source.margins?.[key], 'Margem padrão')]));
    const levels = Array.isArray(source.contingencyLevels) ? source.contingencyLevels : SHEET_DEFAULTS.contingencyLevels;
    if (levels.length > 12) throw new BadRequestException('Níveis de imprevisibilidade demais');
    return {
      margins,
      contingencyLevels: levels.map((level: Body) => {
        const label = clean(level.label);
        if (!label) throw new BadRequestException('Todo nível de imprevisibilidade precisa de um nome');
        return { label: label.slice(0, 40), rate: rate(level.rate, `Imprevisibilidade ${label}`, 1) };
      }),
      contingencyRate: rate(source.contingencyRate, 'Imprevisibilidade padrão', 1),
      commission: {
        rate: rate(source.commission?.rate, 'Comissão padrão', 0.5),
        base: source.commission?.base === 'lucro' ? 'lucro' : 'faturado',
        inPrice: bool(source.commission?.inPrice),
      },
    };
  }

  /** Conta ao vivo: recebe o rascunho da tela e devolve A–E e a tabela de custo hora, sem gravar. */
  async computeDraft(companyId: number, body: Body) {
    const date = blank(body.date) ? today() : dateOf(body.date, 'Data');
    const params = this.parseParams(body);
    const items = this.parseItems(body.items ?? []);
    const pros = await this.professionals(companyId);
    return guarded(() => {
      const result = computeBase(params, items, date);
      return rounded({ result, professionals: this.table(params, result, pros), sensitivity: this.sensitivity(params, items, date, pros) });
    });
  }

  private async assertUniqueDate(companyId: number, effectiveFrom: string, exceptId?: number) {
    const clash = await this.prisma.commercial_CostBase.findFirst({
      where: { companyId, inactiveAt: null, effectiveFrom: asDate(effectiveFrom), ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { id: true },
    });
    if (clash) throw new ConflictException('Já existe uma versão ativa com essa data de vigência');
  }

  /** Nova versão: copia uma existente (por padrão a vigente) e muda a data. */
  async createBase(companyId: number, body: Body) {
    const effectiveFrom = dateOf(body.effectiveFrom, 'Vigência a partir de');
    const name = clean(body.name);
    if (name.length < 2) throw new BadRequestException('Informe o nome da versão');
    const source = blank(body.sourceId) ? await this.currentBase(companyId, effectiveFrom) : await this.baseById(companyId, Number(body.sourceId));
    await this.assertUniqueDate(companyId, effectiveFrom);
    const params = this.parseParams(body.params ? body : {}, source);
    guarded(() => computeBase(params, source.items.map(itemOf), effectiveFrom));
    const created = await this.prisma.commercial_CostBase.create({ data: {
      companyId, name: name.slice(0, 120), effectiveFrom: asDate(effectiveFrom), notes: clean(body.notes).slice(0, 500) || null,
      ...params, defaults: source.defaults as Prisma.InputJsonValue,
      items: { create: source.items.map(({ id: _id, costBaseId: _base, ...item }) => item) },
    } });
    return this.getBase(companyId, created.id, effectiveFrom);
  }

  async updateBase(companyId: number, id: number, body: Body) {
    const existing = await this.baseById(companyId, id);
    const params = this.parseParams(body, existing);
    const items = 'items' in body ? this.parseItems(body.items) : null;
    const defaults = 'defaults' in body ? this.parseDefaults(body.defaults, existing.defaults) : null;
    const effectiveFrom = 'effectiveFrom' in body ? dateOf(body.effectiveFrom, 'Vigência a partir de') : iso(existing.effectiveFrom)!;
    const name = 'name' in body ? clean(body.name) : existing.name;
    if (name.length < 2) throw new BadRequestException('Informe o nome da versão');
    if (!existing.inactiveAt) await this.assertUniqueDate(companyId, effectiveFrom, id);
    // A conta precisa fechar antes de gravar: base inválida quebraria toda proposta.
    guarded(() => computeBase(params, items ?? existing.items.map(itemOf), effectiveFrom));

    await this.prisma.$transaction(async (tx: Tx) => {
      await tx.commercial_CostBase.update({ where: { id }, data: {
        ...params, name: name.slice(0, 120), effectiveFrom: asDate(effectiveFrom),
        ...('notes' in body ? { notes: clean(body.notes).slice(0, 500) || null } : {}),
        ...(defaults ? { defaults } : {}),
      } });
      if (items) {
        await tx.commercial_CostBaseItem.deleteMany({ where: { costBaseId: id } });
        if (items.length) await tx.commercial_CostBaseItem.createMany({ data: items.map((item) => ({ ...item, endsAt: item.endsAt ? asDate(item.endsAt) : null, companyId, costBaseId: id })) });
      }
    });
    return this.getBase(companyId, id);
  }

  async setBaseActive(companyId: number, id: number, active: boolean) {
    const existing = await this.baseById(companyId, id);
    if (!active) {
      const others = await this.prisma.commercial_CostBase.count({ where: { companyId, inactiveAt: null, NOT: { id } } });
      if (!others) throw new ConflictException('Esta é a única versão ativa da base de cálculo');
    } else {
      await this.assertUniqueDate(companyId, iso(existing.effectiveFrom)!, id);
    }
    await this.prisma.commercial_CostBase.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } });
    return { id, active };
  }

  // ------------------------------------------------------------------ perfis tributários

  private presentTax(row: TaxRow, currentId?: number) {
    const input = taxInputOf(row);
    return {
      id: row.id, name: row.name, regime: row.regime, effectiveFrom: iso(row.effectiveFrom), mode: row.mode, rbt12: input.rbt12,
      manualRate: input.manualRate, ibsCbsShare: input.ibsCbsShare, outsideRate: input.outsideRate, brackets: input.brackets,
      isDefault: row.isDefault, notes: row.notes, inactiveAt: row.inactiveAt, current: row.id === currentId,
      tax: rounded(guarded(() => resolveTax(input))),
    };
  }

  async listTaxProfiles(companyId: number, date = today()) {
    const current = await this.currentTax(companyId, date);
    const rows = await this.prisma.commercial_TaxProfile.findMany({ where: { companyId }, orderBy: [{ regime: 'asc' }, { effectiveFrom: 'desc' }, { id: 'desc' }] });
    return rows.map((row) => this.presentTax(row, current.id));
  }

  private parseTax(body: Body, existing?: TaxRow) {
    const pick = <T>(key: string, fallback: T) => (key in body ? body[key] : fallback);
    const name = clean(pick('name', existing?.name));
    if (name.length < 2) throw new BadRequestException('Informe o nome do perfil');
    const regime = pick('regime', existing?.regime ?? 'tradicional');
    if (regime !== 'tradicional' && regime !== 'hibrido') throw new BadRequestException('Regime inválido');
    const mode = pick('mode', existing?.mode ?? 'nominal');
    if (mode !== 'nominal' && mode !== 'efetiva' && mode !== 'manual') throw new BadRequestException('Modo da alíquota inválido');
    const rawBrackets = pick('brackets', existing?.brackets ?? []);
    if (!Array.isArray(rawBrackets) || rawBrackets.length > 20) throw new BadRequestException('Tabela de faixas inválida');
    const brackets = rawBrackets.map((entry: Body, index) => ({
      limit: number(entry.limit, `Faixa ${index + 1} — limite`, 0, 1e12),
      rate: number(entry.rate, `Faixa ${index + 1} — alíquota`, 0, 0.99),
      deduction: number(entry.deduction ?? 0, `Faixa ${index + 1} — parcela a deduzir`, 0, 1e12),
    })).sort((a, b) => a.limit - b.limit);
    const manualRaw = pick('manualRate', existing?.manualRate ?? null);
    const manualRate = blank(manualRaw) ? null : number(manualRaw, 'Alíquota manual', 0, 0.99);
    if (mode === 'manual' && manualRate === null) throw new BadRequestException('Informe a alíquota manual');
    if (mode !== 'manual' && !brackets.length) throw new BadRequestException('Cadastre ao menos uma faixa ou use a alíquota manual');
    const data = {
      name: name.slice(0, 120), regime: regime as 'tradicional' | 'hibrido', mode: mode as 'nominal' | 'efetiva' | 'manual',
      effectiveFrom: asDate(dateOf(pick('effectiveFrom', iso(existing?.effectiveFrom)), 'Vigência a partir de')),
      rbt12: number(pick('rbt12', existing?.rbt12 ?? 0), 'RBT12', 0, 1e12), manualRate,
      ibsCbsShare: number(pick('ibsCbsShare', existing?.ibsCbsShare ?? 0), 'Parte do DAS que é IBS/CBS', 0, 1),
      outsideRate: number(pick('outsideRate', existing?.outsideRate ?? 0), 'CBS + IBS por fora', 0, 0.99),
      brackets: brackets as unknown as Prisma.InputJsonValue,
      notes: clean(pick('notes', existing?.notes)).slice(0, 500) || null,
    };
    guarded(() => resolveTax({ ...data, rbt12: data.rbt12, brackets }));
    return data;
  }

  async createTaxProfile(companyId: number, body: Body) {
    await this.ensureSeed(companyId);
    const created = await this.prisma.commercial_TaxProfile.create({ data: { companyId, ...this.parseTax(body) } });
    return this.presentTax(created);
  }

  private async taxById(companyId: number, id: number) {
    const row = await this.prisma.commercial_TaxProfile.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException('Perfil tributário não encontrado');
    return row;
  }

  async updateTaxProfile(companyId: number, id: number, body: Body) {
    const existing = await this.taxById(companyId, id);
    const updated = await this.prisma.commercial_TaxProfile.update({ where: { id }, data: this.parseTax(body, existing) });
    return this.presentTax(updated);
  }

  /** A chave: o perfil marcado vira o padrão da empresa (e os outros deixam de ser). */
  async setDefaultTaxProfile(companyId: number, id: number) {
    const existing = await this.taxById(companyId, id);
    if (existing.inactiveAt) throw new ConflictException('Reative o perfil antes de torná-lo o padrão');
    await this.prisma.$transaction([
      this.prisma.commercial_TaxProfile.updateMany({ where: { companyId, isDefault: true, NOT: { id } }, data: { isDefault: false } }),
      this.prisma.commercial_TaxProfile.update({ where: { id }, data: { isDefault: true } }),
    ]);
    return this.listTaxProfiles(companyId);
  }

  async setTaxActive(companyId: number, id: number, active: boolean) {
    const existing = await this.taxById(companyId, id);
    if (!active) {
      if (existing.isDefault) throw new ConflictException('Este é o perfil padrão: escolha outro padrão antes de inativar');
      const others = await this.prisma.commercial_TaxProfile.count({ where: { companyId, inactiveAt: null, NOT: { id } } });
      if (!others) throw new ConflictException('Este é o único perfil tributário ativo');
    }
    await this.prisma.commercial_TaxProfile.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } });
    return { id, active };
  }

  // ------------------------------------------------------------------ preço

  /** Tudo que a tela precisa para montar um orçamento na data: base, imposto, profissionais e padrões. */
  async context(companyId: number, query: { date?: string; costBaseId?: string; taxProfileId?: string; regime?: string }) {
    const date = blank(query.date) ? today() : dateOf(query.date, 'Data');
    const base = blank(query.costBaseId) ? await this.currentBase(companyId, date) : await this.baseById(companyId, Number(query.costBaseId));
    const tax = blank(query.taxProfileId) ? await this.currentTax(companyId, date, query.regime) : await this.taxById(companyId, Number(query.taxProfileId));
    const view = this.present(base, date, await this.professionals(companyId));
    return { date, costBase: { id: view.id, name: view.name, effectiveFrom: view.effectiveFrom }, result: view.result, defaults: view.defaults,
      professionals: view.professionals, taxProfile: this.presentTax(tax, tax.id) };
  }

  /**
   * Calcula um orçamento sem gravar nada. `scenario` troca peças para simular
   * ("e se fôssemos 12 homens", "e se fosse o híbrido"); `compare: true`
   * devolve também os dois regimes lado a lado.
   */
  async preview(companyId: number, body: Body) {
    const date = blank(body.date) ? today() : dateOf(body.date, 'Data');
    const scenario = (body.scenario ?? {}) as Body;
    const input = (body.input ?? {}) as PriceInput;
    if (!Array.isArray(input.sections)) throw new BadRequestException('Informe as seções do orçamento');
    if (input.sections.reduce((sum, section) => sum + (section.items?.length ?? 0), 0) > 1000) throw new BadRequestException('Itens demais no orçamento');

    const baseRow = blank(scenario.costBaseId) ? await this.currentBase(companyId, date) : await this.baseById(companyId, Number(scenario.costBaseId));
    const params = paramsOf(baseRow);
    if (!blank(scenario.headcount)) params.headcount = number(scenario.headcount, 'Efetivo médio', 0.01, 100000);
    const items = baseRow.items.map(itemOf);

    // Item de mão de obra pode vir só com o profissional: o salário sai do cadastro.
    const ids = [...new Set(input.sections.flatMap((s) => s.items ?? []).map((i: any) => Number(i.professionalId)).filter((id) => id > 0))];
    const pros = ids.length ? await this.prisma.commercial_Professional.findMany({ where: { companyId, id: { in: ids } } }) : [];
    const salaryOf = new Map(pros.map((p) => [p.id, Number(p.salary)]));
    const resolved: PriceInput = { ...input, sections: input.sections.map((section) => ({ ...section, items: (section.items ?? []).map((item: any) => {
      if (item.type !== 'mao_de_obra' || !blank(item.salary)) return item;
      const salary = salaryOf.get(Number(item.professionalId));
      if (salary === undefined) throw new BadRequestException('Profissional não encontrado');
      return { ...item, salary };
    }) })) };

    const run = async (regime?: string) => {
      const taxRow = !regime && !blank(scenario.taxProfileId) ? await this.taxById(companyId, Number(scenario.taxProfileId))
        : await this.currentTax(companyId, date, regime ?? (scenario.regime as string | undefined));
      return guarded(() => {
        const base = computeBase(params, items, date);
        const tax = resolveTax(taxInputOf(taxRow));
        return rounded({ taxProfile: { id: taxRow.id, name: taxRow.name, regime: taxRow.regime }, tax, ...price(resolved, { params, base, tax }) });
      });
    };

    const main = await run();
    const result: Record<string, unknown> = { date, costBase: { id: baseRow.id, name: baseRow.name, headcount: params.headcount }, ...main };
    if (bool(body.compare)) result.compare = { tradicional: await run('tradicional'), hibrido: await run('hibrido') };
    return result;
  }
}
