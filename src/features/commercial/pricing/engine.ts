/**
 * Motor de formação de preços do Comercial.
 *
 * Função pura: recebe números, devolve números. Não conhece banco, HTTP nem
 * Nest — é o único lugar onde as fórmulas da planilha FORM-COM-001 existem,
 * e a tela nunca refaz a conta (pede ao endpoint `preview`).
 *
 * Tudo é mantido em precisão cheia; arredondar é assunto de quem exibe
 * (`round2`). Os totais somam valores não arredondados, como a planilha.
 */

export class PricingError extends Error {
  constructor(message: string, readonly field?: string) { super(message); }
}

export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export const round4 = (value: number) => Math.round((value + Number.EPSILON) * 10000) / 10000;

// ---------------------------------------------------------------- base de custos

export interface CostBaseParams {
  daysInYear: number; restDays: number; vacationDays: number; holidays: number;
  hoursPerDay: number; idleRate: number; monthsDivisor: number;
  additionalDivisor: number; nightRate: number; travelRate: number; weekendRate: number;
  weekendPerWorker: boolean;
  mealPerDay: number; transportFare: number; transportTrips: number; transportDiscount: number;
  fareDiscountRate: number;
  headcount: number;
}

export type CostItemGroup = 'encargo' | 'pessoal_indireto' | 'outro_custo';

export interface CostItem {
  group: CostItemGroup;
  name?: string;
  rate?: number | null;
  amount?: number | null;
  quantity?: number | null;
  withCharges?: boolean;
  kind?: 'fixo' | 'por_pessoa';
  isDebt?: boolean;
  /** AAAA-MM-DD; depois dessa data o item sai do cálculo. */
  endsAt?: string | null;
}

export interface BaseResult {
  availableDays: number; hoursYear: number; idleHours: number; workedHoursYear: number;
  /** A — horas úteis por mês */
  A: number;
  /** B — encargos sobre o salário (fração) */
  B: number;
  /** C — benefícios por hora */
  C: number; mealPerHour: number; transportPerHour: number;
  /** D — pessoal indireto por hora */
  D: number; indirectMonthly: number; indirectPerWorker: number;
  /** E — outros custos por hora (inclui a parcela de dívida) */
  E: number; otherMonthly: number; otherPerWorker: number;
  /** Parcela de E que é dívida (empréstimos, impostos em atraso) */
  debtPerHour: number; debtMonthly: number;
  /** C + D + E */
  overheadPerHour: number;
}

const num = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const itemActive = (item: CostItem, refDate?: string) =>
  !item.endsAt || !refDate || item.endsAt.slice(0, 10) >= refDate.slice(0, 10);

export function computeBase(params: CostBaseParams, items: CostItem[], refDate?: string): BaseResult {
  if (!(params.hoursPerDay > 0)) throw new PricingError('Horas por dia deve ser maior que zero', 'hoursPerDay');
  if (!(params.monthsDivisor > 0)) throw new PricingError('Divisor de meses deve ser maior que zero', 'monthsDivisor');
  if (!(params.headcount > 0)) throw new PricingError('Efetivo médio deve ser maior que zero', 'headcount');
  if (params.idleRate < 0 || params.idleRate >= 1) throw new PricingError('Índice de ociosidade deve ficar entre 0% e 99%', 'idleRate');

  const availableDays = params.daysInYear - params.restDays - params.vacationDays - params.holidays;
  if (!(availableDays > 0)) throw new PricingError('Não sobram dias disponíveis no ano', 'daysInYear');
  const hoursYear = availableDays * params.hoursPerDay;
  const idleHours = hoursYear * params.idleRate;
  const workedHoursYear = hoursYear - idleHours;
  const A = workedHoursYear / params.monthsDivisor;

  const live = items.filter((item) => itemActive(item, refDate));
  const B = live.filter((i) => i.group === 'encargo').reduce((sum, i) => sum + num(i.rate), 0);

  const mealPerHour = params.mealPerDay / params.hoursPerDay;
  const transportPerHour = (params.transportFare * params.transportTrips * (1 - params.transportDiscount)) / params.hoursPerDay;
  const C = mealPerHour + transportPerHour;

  const indirectMonthly = live.filter((i) => i.group === 'pessoal_indireto')
    .reduce((sum, i) => sum + num(i.amount) * (i.withCharges === false ? 1 : 1 + B) * num(i.quantity, 1), 0);
  const indirectPerWorker = indirectMonthly / params.headcount;
  const D = indirectPerWorker / A;

  // Fixo é rateado pelo efetivo; "por pessoa" já é R$/homem e não muda com ele.
  const others = live.filter((i) => i.group === 'outro_custo');
  const perWorker = (list: CostItem[]) => list.reduce((sum, i) => {
    const value = num(i.amount) * num(i.quantity, 1);
    return sum + (i.kind === 'por_pessoa' ? value : value / params.headcount);
  }, 0);
  const monthly = (list: CostItem[]) => list.reduce((sum, i) => {
    const value = num(i.amount) * num(i.quantity, 1);
    return sum + (i.kind === 'por_pessoa' ? value * params.headcount : value);
  }, 0);
  const otherPerWorker = perWorker(others);
  const E = otherPerWorker / A;
  const debts = others.filter((i) => i.isDebt);
  const debtPerHour = perWorker(debts) / A;

  return {
    availableDays, hoursYear, idleHours, workedHoursYear, A, B,
    C, mealPerHour, transportPerHour,
    D, indirectMonthly, indirectPerWorker,
    E, otherMonthly: monthly(others), otherPerWorker,
    debtPerHour, debtMonthly: monthly(debts),
    overheadPerHour: C + D + E,
  };
}

// ---------------------------------------------------------------- profissional

export interface ProfessionalCost {
  salary: number; salaryWithCharges: number;
  /** Custo hora carregado (HHT) */
  hourCost: number;
  nightPerHour: number; travelPerHour: number; weekendPerHour: number;
  /** De onde vem o custo hora */
  parts: { labor: number; benefits: number; indirect: number; other: number; debt: number; fareDiscount: number };
}

export function professionalCost(salary: number, params: CostBaseParams, base: BaseResult): ProfessionalCost {
  const S = num(salary);
  const salaryWithCharges = S * (1 + base.B);
  const labor = salaryWithCharges / base.A;
  const fareDiscount = (S * params.fareDiscountRate) / base.A;
  const hourBase = params.additionalDivisor > 0 ? S / params.additionalDivisor : 0;
  const additional = (rate: number) => hourBase * rate * (1 + base.B);
  return {
    salary: S, salaryWithCharges,
    hourCost: labor + base.overheadPerHour - fareDiscount,
    nightPerHour: additional(params.nightRate),
    travelPerHour: additional(params.travelRate),
    weekendPerHour: additional(params.weekendRate),
    parts: { labor, benefits: base.C, indirect: base.D, other: base.E - base.debtPerHour, debt: base.debtPerHour, fareDiscount },
  };
}

// ---------------------------------------------------------------- imposto

export interface TaxBracket { limit: number; rate: number; deduction: number }

export interface TaxProfileInput {
  regime: 'tradicional' | 'hibrido';
  mode: 'nominal' | 'efetiva' | 'manual';
  rbt12: number;
  manualRate?: number | null;
  ibsCbsShare: number;
  outsideRate: number;
  brackets: TaxBracket[];
}

export interface TaxResult {
  regime: 'tradicional' | 'hibrido';
  nominal: number; effective: number;
  /** Alíquota do DAS em uso, conforme o modo */
  das: number;
  /** % do preço líquido, "por dentro" */
  inside: number;
  /** % sobre o preço líquido, "por fora" (só no híbrido) */
  outside: number;
  /** A mesma conta com a alíquota real (efetiva, ou a manual): base do painel de margem */
  realInside: number;
  /** Crédito que o cliente toma, como fração do preço líquido */
  creditOnNet: number;
}

export function resolveTax(profile: TaxProfileInput): TaxResult {
  const brackets = [...(profile.brackets ?? [])].sort((a, b) => a.limit - b.limit);
  const rbt12 = num(profile.rbt12);
  const bracket = brackets.find((b) => rbt12 <= b.limit) ?? brackets[brackets.length - 1];
  const nominal = bracket ? num(bracket.rate) : 0;
  const effective = bracket && rbt12 > 0 ? Math.max(0, (rbt12 * nominal - num(bracket.deduction)) / rbt12) : nominal;
  const manual = num(profile.manualRate);
  const das = profile.mode === 'manual' ? manual : profile.mode === 'efetiva' ? effective : nominal;
  const real = profile.mode === 'manual' ? manual : effective;
  const share = Math.min(1, Math.max(0, num(profile.ibsCbsShare)));
  const hybrid = profile.regime === 'hibrido';
  const outside = hybrid ? Math.max(0, num(profile.outsideRate)) : 0;
  const inside = hybrid ? das * (1 - share) : das;
  const realInside = hybrid ? real * (1 - share) : real;
  if (das < 0 || das >= 1) throw new PricingError('Alíquota de imposto deve ficar entre 0% e 99%', 'manualRate');
  return {
    regime: profile.regime, nominal, effective, das, inside, outside, realInside,
    // tradicional: só a fatia de IBS/CBS que está no DAS; híbrido: o destacado por fora
    creditOnNet: hybrid ? outside : real * share,
  };
}

// ---------------------------------------------------------------- proposta

export type ItemType = 'mao_de_obra' | 'locacao' | 'material' | 'treinamento' | 'avulso';

export interface PriceItemInput {
  id?: string | number;
  type: ItemType;
  quantity?: number;
  /** mao_de_obra */
  salary?: number;
  night?: boolean; travel?: boolean; weekend?: boolean;
  workDays?: number; weekendDays?: number; hoursPerDay?: number;
  /** demais tipos: custo = quantity × unitCost + extraCost */
  unitCost?: number; extraCost?: number;
  /** Margem só deste item (senão vale a da seção) */
  margin?: number | null;
  /** Valor final digitado. Sem ele, vale o sugerido. */
  finalValue?: number | null;
}

export interface PriceSectionInput { key?: string; margin: number; items: PriceItemInput[] }

export interface PriceInput {
  workDays?: number; weekendDays?: number;
  contingencyRate?: number;
  commission?: { rate: number; base: 'faturado' | 'lucro'; inPrice?: boolean };
  sections: PriceSectionInput[];
}

export interface PriceLine {
  id?: string | number; type: ItemType;
  cost: number; debtCost: number;
  /** Preço líquido sugerido (antes da contingência e do imposto por fora) */
  suggested: number;
  /** Preço líquido em uso: o digitado, ou o sugerido */
  value: number;
  /** Margem que o valor em uso deixa, com o imposto do perfil */
  margin: number | null;
  hourCost?: number; hours?: number;
}

export interface PriceResult {
  sections: Array<{ key?: string; margin: number; cost: number; suggested: number; value: number; lines: PriceLine[] }>;
  totals: {
    cost: number;
    /** Soma dos preços líquidos sugeridos, sem contingência */
    suggested: number;
    /** Soma dos preços em uso, sem contingência */
    subtotal: number;
    contingency: number;
    /** Preço líquido (base do imposto por fora) */
    net: number;
    taxInside: number; taxOutside: number; tax: number;
    /** Preço na nota */
    total: number;
    profit: number; profitRate: number;
    commission: number;
    customerCredit: number;
    /** O que o serviço custa ao cliente que aproveita o crédito */
    customerCost: number;
  };
  /** Margem de verdade: imposto real e comissão descontados */
  margin: {
    realTax: number;
    unused: number; unusedRate: number;
    used: number; usedRate: number;
    /** Preço de nota com margem zero */
    minTotal: number;
    /** Idem, abrindo mão da parcela de dívida embutida no custo hora */
    minTotalOperational: number;
    maxDiscountRate: number;
  };
}

export interface PriceContext { params: CostBaseParams; base: BaseResult; tax: TaxResult }

export function price(input: PriceInput, ctx: PriceContext): PriceResult {
  const { params, base, tax } = ctx;
  const contingencyRate = Math.max(0, num(input.contingencyRate));
  const commissionRate = Math.max(0, num(input.commission?.rate));
  const commissionBase = input.commission?.base ?? 'faturado';
  // Opção de melhoria: comissão sobre o faturado dentro do divisor.
  const commissionInPrice = input.commission?.inPrice && commissionBase === 'faturado' ? commissionRate : 0;

  let cost = 0, debtCost = 0, suggested = 0, subtotal = 0;
  const sections = (input.sections ?? []).map((section) => {
    const sectionMargin = num(section.margin);
    let sCost = 0, sSuggested = 0, sValue = 0;
    const lines = (section.items ?? []).map((item): PriceLine => {
      const quantity = num(item.quantity, 1);
      let lineCost = 0, lineDebt = 0, hourCost: number | undefined, hours: number | undefined;
      if (item.type === 'mao_de_obra') {
        const pro = professionalCost(num(item.salary), params, base);
        const hpd = num(item.hoursPerDay, params.hoursPerDay) || params.hoursPerDay;
        hours = num(item.workDays ?? input.workDays) * hpd;
        hourCost = pro.hourCost + (item.night ? pro.nightPerHour : 0) + (item.travel ? pro.travelPerHour : 0);
        lineCost = hourCost * quantity * hours;
        lineDebt = base.debtPerHour * quantity * hours;
        if (item.weekend) {
          const weekendHours = num(item.weekendDays ?? input.weekendDays) * hpd;
          lineCost += pro.weekendPerHour * weekendHours * (params.weekendPerWorker ? quantity : 1);
        }
      } else {
        lineCost = quantity * num(item.unitCost) + num(item.extraCost);
      }
      const margin = item.margin === null || item.margin === undefined ? sectionMargin : num(item.margin);
      const divisor = 1 - margin - tax.inside - commissionInPrice;
      if (!(divisor > 0)) throw new PricingError('Margem, imposto e comissão somam 100% ou mais: não existe preço que feche', 'margin');
      const lineSuggested = lineCost / divisor;
      const typed = item.finalValue === null || item.finalValue === undefined || (item.finalValue as unknown) === '' ? null : num(item.finalValue);
      const value = typed ?? lineSuggested;
      sCost += lineCost; sSuggested += lineSuggested; sValue += value; debtCost += lineDebt;
      return {
        id: item.id, type: item.type, cost: lineCost, debtCost: lineDebt, suggested: lineSuggested, value,
        margin: value > 0 ? 1 - tax.inside - commissionInPrice - lineCost / value : null,
        hourCost, hours,
      };
    });
    cost += sCost; suggested += sSuggested; subtotal += sValue;
    return { key: section.key, margin: sectionMargin, cost: sCost, suggested: sSuggested, value: sValue, lines };
  });

  const net = subtotal * (1 + contingencyRate);
  const contingency = net - subtotal;
  const taxInside = net * tax.inside;
  const taxOutside = net * tax.outside;
  const total = net + taxOutside;
  const profit = net - cost - taxInside;
  const commission = commissionRate * (commissionBase === 'faturado' ? total : profit);
  const customerCredit = net * tax.creditOnNet;

  // Painel de margem: imposto real (efetivo) e comissão dentro da conta.
  const realTax = net * tax.realInside;
  const unused = net - cost - realTax - commission;
  const used = unused - contingency;
  const commissionOnNet = commissionBase === 'faturado' ? commissionRate * (1 + tax.outside) : 0;
  const floorDivisor = 1 - tax.realInside - commissionOnNet;
  const floor = (value: number) => (floorDivisor > 0 ? (value / floorDivisor) * (1 + tax.outside) : 0);
  const minTotal = floor(cost);

  return {
    sections,
    totals: {
      cost, suggested, subtotal, contingency, net, taxInside, taxOutside, tax: taxInside + taxOutside, total,
      profit, profitRate: net > 0 ? profit / net : 0, commission, customerCredit, customerCost: total - customerCredit,
    },
    margin: {
      realTax, unused, unusedRate: net > 0 ? unused / net : 0, used, usedRate: net > 0 ? used / net : 0,
      minTotal, minTotalOperational: floor(cost - debtCost),
      maxDiscountRate: total > 0 ? Math.max(0, 1 - minTotal / total) : 0,
    },
  };
}

/** Arredonda (2 casas) todo número de um resultado, para sair na API. */
export function rounded<T>(value: T, rateKeys: RegExp = /^(.*Rate|rate|margin|B|nominal|effective|das|inside|outside|realInside|creditOnNet)$/): T {
  const walk = (node: any, key = ''): any => {
    if (typeof node === 'number') return rateKeys.test(key) ? Math.round(node * 1e6) / 1e6 : round2(node);
    if (Array.isArray(node)) return node.map((entry) => walk(entry, key));
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
    return node;
  };
  return walk(value);
}
