/**
 * Base de cálculo da locação de equipamento próprio ao cliente
 * (comercial-planejamento/09-base-calculo-locacao.md).
 *
 * Função pura, como o motor de serviço: recebe números, devolve números.
 *
 *   custo de ter (R$/mês) = depreciação + capital + seguro + manutenção + inspeção + calibração
 *   custo do mês alugado  = custo de ter ÷ ocupação + perdas não recuperadas
 *   preço do mês          = custo do mês alugado ÷ (1 − margem − imposto − comissão)
 *
 * Dia e semana saem do mês por fator, com teto (nunca passa do mês cheio);
 * período fechado em meses ganha o desconto do prazo. A preparação (inspeção
 * de devolução, higienização, bump test) é cobrada uma vez por peça.
 */

export interface RentalDiscount { fromMonths: number; rate: number }

/** Parâmetros comuns, guardados em `Commercial_CostBase.defaults.rental`. */
export interface RentalDefaults {
  /** custo de capital ao mês */
  capitalRate: number;
  /** seguro ao ano, % do valor */
  insuranceRate: number;
  residualRate: number;
  /** manutenção ao ano, % do valor */
  maintenanceRate: number;
  occupancy: number;
  /** perdas não recuperadas, % do valor por mês alugado */
  lossRate: number;
  /** preparação por peça e por locação (R$) */
  handlingCost: number;
  /** intervalo padrão de inspeção e de calibração, em meses, quando o item não tem */
  inspectionMonths: number;
  calibrationMonths: number;
  weekFactor: number;
  dayFactor: number;
  longDiscounts: RentalDiscount[];
  /** faixa da checagem de mercado: preço do mês ÷ valor do bem */
  marketBand: { min: number; max: number };
  /** caução sugerida, % do valor de reposição */
  depositRate: number;
}

export const RENTAL_DEFAULTS: RentalDefaults = {
  capitalRate: 0.01, insuranceRate: 0.03, residualRate: 0.1, maintenanceRate: 0.05, occupancy: 0.45, lossRate: 0.005,
  handlingCost: 50, inspectionMonths: 6, calibrationMonths: 6, weekFactor: 0.45, dayFactor: 0.15,
  longDiscounts: [{ fromMonths: 3, rate: 0.05 }, { fromMonths: 6, rate: 0.1 }, { fromMonths: 12, rate: 0.15 }],
  marketBand: { min: 0.08, max: 0.2 }, depositRate: 0,
};

/** O que cada item (ou categoria) pode trocar em relação à base. Nulo = vale o de cima. */
export interface RentalOverrides {
  /** valor de reposição (R$) */
  value?: number | null;
  lifeMonths?: number | null;
  residualRate?: number | null;
  maintenanceRate?: number | null;
  inspectionCost?: number | null;
  inspectionMonths?: number | null;
  calibrationCost?: number | null;
  calibrationMonths?: number | null;
  occupancy?: number | null;
  lossRate?: number | null;
  handlingCost?: number | null;
}

/** Item pronto para a conta: o próprio, ou um kit com componentes. */
export interface RentalItemInput extends RentalOverrides {
  name?: string;
  components?: Array<{ quantity: number; item: RentalItemInput }>;
}

export interface RentalCost {
  value: number;
  lifeMonths: number | null;
  occupancy: number;
  depreciation: number; capital: number; insurance: number; maintenance: number; inspection: number; calibration: number;
  /** custo de ter, por mês, alugado ou não */
  ownMonthly: number;
  /** perdas não recuperadas por mês alugado */
  loss: number;
  /** custo de cada mês alugado */
  perRentedMonth: number;
  /** preparação por peça, por locação */
  handling: number;
  /** custo do mês com ocupação de 100% (piso de contrato longo) */
  floorMonth: number;
}

export class RentalError extends Error {}

/**
 * Valores de partida tirados da pesquisa de 18/11/2026 (seção 3 do plano 09).
 * A empresa troca na tela; aqui é só o ponto de partida.
 */
export const RENTAL_PRESETS: Record<string, RentalOverrides & { label: string; minRentPeriod: 'dia' | 'semana' | 'mes'; source: string }> = {
  cinto: { label: 'Cinto paraquedista', value: 400, lifeMonths: 24, residualRate: 0, maintenanceRate: 0, inspectionCost: 25, inspectionMonths: 6, occupancy: 0.5, lossRate: 0.01, handlingCost: 15, minRentPeriod: 'dia',
    source: 'Varejo R$ 68–372 (Magalu); inspeção periódica máxima de 6 meses (manual Safe Tec)' },
  trava_corda: { label: 'Trava-quedas de corda', value: 350, lifeMonths: 60, residualRate: 0, maintenanceRate: 0.02, inspectionCost: 20, inspectionMonths: 6, occupancy: 0.5, lossRate: 0.01, handlingCost: 15, minRentPeriod: 'dia',
    source: 'Varejo R$ 160–190 nos simples (Magalu); modelo de marca com talabarte' },
  trava_retratil: { label: 'Trava-quedas retrátil 15 m', value: 2000, lifeMonths: 60, residualRate: 0.1, maintenanceRate: 0.05, inspectionCost: 200, inspectionMonths: 12, occupancy: 0.5, lossRate: 0.003, handlingCost: 40, minRentPeriod: 'dia',
    source: 'Retrátil de 10 m R$ 1.190 (Loja do Mecânico); revisão anual estimada' },
  tripe: { label: 'Tripé com guincho', value: 10050, lifeMonths: 60, residualRate: 0.1, maintenanceRate: 0.12, inspectionCost: 400, inspectionMonths: 12, occupancy: 0.4, lossRate: 0.002, handlingCost: 60, minRentPeriod: 'semana',
    source: 'SICRO E9263 (07/2026) R$ 10.050,43; manutenção do SICRO ≈ 12% ao ano' },
  detector: { label: 'Detector de 4 gases', value: 6000, lifeMonths: 60, residualRate: 0.1, maintenanceRate: 0.12, calibrationCost: 450, calibrationMonths: 6, occupancy: 0.5, lossRate: 0.005, handlingCost: 50, minRentPeriod: 'semana',
    source: 'SICRO E9260 R$ 4.279 a MSA Altair 4XR R$ 13.230; calibração estimada' },
  exaustor: { label: 'Exaustor/insuflador com duto', value: 6700, lifeMonths: 60, residualRate: 0.1, maintenanceRate: 0.12, inspectionCost: 100, inspectionMonths: 6, occupancy: 0.4, lossRate: 0.002, handlingCost: 60, minRentPeriod: 'semana',
    source: 'SICRO E9267 R$ 5.883,89 + duto de 10 m (≈ R$ 800)' },
  kit_resgate: { label: 'Kit de resgate', value: 7300, lifeMonths: 36, residualRate: 0.1, maintenanceRate: 0.03, inspectionCost: 120, inspectionMonths: 6, occupancy: 0.4, lossRate: 0.01, handlingCost: 90, minRentPeriod: 'semana',
    source: 'Soma de corda, descensor, polias, mosquetões, fitas, maca, triângulo e mochila' },
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const pick = (...values: Array<number | null | undefined>) => values.find(finite) ?? null;

/** Junta os parâmetros comuns guardados (que podem ser de uma versão antiga, sem algum campo) com os padrões. */
export function rentalDefaultsOf(raw: unknown): RentalDefaults {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const out = { ...RENTAL_DEFAULTS } as Record<string, any>;
  for (const key of Object.keys(RENTAL_DEFAULTS) as Array<keyof RentalDefaults>) {
    if (key === 'longDiscounts' || key === 'marketBand') continue;
    const value = Number(source[key]);
    if (source[key] !== undefined && source[key] !== null && source[key] !== '' && Number.isFinite(value)) out[key] = value;
  }
  if (Array.isArray(source.longDiscounts)) {
    out.longDiscounts = source.longDiscounts
      .map((d: any) => ({ fromMonths: Number(d?.fromMonths), rate: Number(d?.rate) }))
      .filter((d: RentalDiscount) => Number.isFinite(d.fromMonths) && Number.isFinite(d.rate))
      .sort((a: RentalDiscount, b: RentalDiscount) => a.fromMonths - b.fromMonths);
  }
  if (source.marketBand && typeof source.marketBand === 'object') {
    const min = Number(source.marketBand.min), max = Number(source.marketBand.max);
    out.marketBand = { min: Number.isFinite(min) ? min : RENTAL_DEFAULTS.marketBand.min, max: Number.isFinite(max) ? max : RENTAL_DEFAULTS.marketBand.max };
  }
  return out as RentalDefaults;
}

/** Custo de ter e custo do mês alugado de um item (ou de um kit, somando os componentes). */
export function rentalCost(item: RentalItemInput, defaults: RentalDefaults): RentalCost {
  const occupancy = pick(item.occupancy, defaults.occupancy)!;
  if (!(occupancy > 0 && occupancy <= 1)) throw new RentalError('Ocupação deve ficar entre 1% e 100%');
  const handling = Math.max(0, pick(item.handlingCost, defaults.handlingCost) ?? 0);

  if (item.components?.length) {
    const parts = item.components.map((c) => ({ quantity: Math.max(0, Number(c.quantity) || 0), cost: rentalCost(c.item, defaults) }));
    const sum = (key: keyof RentalCost) => parts.reduce((total, p) => total + p.quantity * Number(p.cost[key] ?? 0), 0);
    const ownMonthly = sum('ownMonthly'), loss = sum('loss');
    return {
      value: sum('value'), lifeMonths: null, occupancy,
      depreciation: sum('depreciation'), capital: sum('capital'), insurance: sum('insurance'), maintenance: sum('maintenance'),
      inspection: sum('inspection') + inspectionOf(item, defaults), calibration: sum('calibration'),
      ownMonthly: ownMonthly + inspectionOf(item, defaults), loss,
      perRentedMonth: (ownMonthly + inspectionOf(item, defaults)) / occupancy + loss,
      handling, floorMonth: ownMonthly + inspectionOf(item, defaults) + loss,
    };
  }

  const value = pick(item.value);
  if (value === null || !(value > 0)) throw new RentalError(`${item.name ? `${item.name}: ` : ''}informe o valor de reposição para calcular a locação`);
  const life = pick(item.lifeMonths);
  if (life === null || !(life >= 1)) throw new RentalError(`${item.name ? `${item.name}: ` : ''}informe a vida útil para calcular a locação`);
  const residual = Math.min(1, Math.max(0, pick(item.residualRate, defaults.residualRate)!));
  const depreciation = (value * (1 - residual)) / life;
  const capital = ((value * (1 + residual)) / 2) * defaults.capitalRate;
  const insurance = (value * defaults.insuranceRate) / 12;
  const maintenance = (value * Math.max(0, pick(item.maintenanceRate, defaults.maintenanceRate)!)) / 12;
  const inspection = inspectionOf(item, defaults);
  const calibrationCost = pick(item.calibrationCost) ?? 0;
  const calibration = calibrationCost > 0 ? calibrationCost / Math.max(1, pick(item.calibrationMonths, defaults.calibrationMonths)!) : 0;
  const ownMonthly = depreciation + capital + insurance + maintenance + inspection + calibration;
  const loss = value * Math.max(0, pick(item.lossRate, defaults.lossRate)!);
  return {
    value, lifeMonths: life, occupancy, depreciation, capital, insurance, maintenance, inspection, calibration,
    ownMonthly, loss, perRentedMonth: ownMonthly / occupancy + loss, handling, floorMonth: ownMonthly + loss,
  };
}

function inspectionOf(item: RentalOverrides, defaults: RentalDefaults) {
  const cost = pick(item.inspectionCost) ?? 0;
  return cost > 0 ? cost / Math.max(0.25, pick(item.inspectionMonths, defaults.inspectionMonths)!) : 0;
}

/**
 * Quantos "meses" cobrar por N dias, com teto: o menor entre diárias, semanas
 * (completando com diárias) e meses cheios. Ex.: 10 dias = 1 semana + 3 diárias,
 * mas nunca mais que 2 semanas nem mais que 1 mês.
 */
export function daysInMonths(days: number, defaults: Pick<RentalDefaults, 'dayFactor' | 'weekFactor'>): number {
  const n = Math.max(0, Math.ceil(days));
  if (n === 0) return 0;
  const { dayFactor, weekFactor } = defaults;
  const weeks = Math.floor(n / 7);
  const options = [
    n * dayFactor,
    Math.ceil(n / 7) * weekFactor,
    weeks * weekFactor + Math.min((n % 7) * dayFactor, weekFactor),
    Math.ceil(n / 30),
  ];
  if (n >= 30) options.push(Math.floor(n / 30) + daysInMonths(n % 30, defaults));
  return Math.min(...options);
}

export type RentPeriod = 'dia' | 'semana' | 'mes';

export interface RentalLineInput { quantity: number; period: RentPeriod; periods: number; closed?: boolean }

export interface RentalLine {
  /** meses equivalentes cobrados, já com o teto */
  months: number;
  /** desconto do prazo (período fechado) */
  discountRate: number;
  /** custo da linha: peças × (mês alugado × meses × (1 − desconto) + preparação) */
  cost: number;
  /** o mesmo com ocupação de 100%: abaixo disso, a margem começa a cair */
  floorCost: number;
  /** quanto custa um período (sem teto), para mostrar o preço unitário */
  periodMonths: number;
}

export function discountFor(months: number, discounts: RentalDiscount[]): number {
  return [...discounts].sort((a, b) => a.fromMonths - b.fromMonths).filter((d) => months >= d.fromMonths).pop()?.rate ?? 0;
}

export function rentalLine(cost: RentalCost, line: RentalLineInput, defaults: RentalDefaults): RentalLine {
  const quantity = Math.max(0, Number(line.quantity) || 0);
  const periods = Math.max(0, Number(line.periods) || 0);
  const months = line.period === 'mes' ? periods
    : daysInMonths(periods * (line.period === 'semana' ? 7 : 1), defaults);
  const periodMonths = line.period === 'mes' ? 1 : line.period === 'semana' ? defaults.weekFactor : defaults.dayFactor;
  const discountRate = line.closed && line.period === 'mes' ? discountFor(periods, defaults.longDiscounts) : 0;
  return {
    months, discountRate, periodMonths,
    cost: quantity * (cost.perRentedMonth * months * (1 - discountRate) + cost.handling),
    floorCost: quantity * (cost.floorMonth * months + cost.handling),
  };
}

/** Tabela de preços de um item: mês, semana, dia, preparação e % do bem, com o divisor da proposta. */
export function rentalTable(cost: RentalCost, defaults: RentalDefaults, divisor: number) {
  if (!(divisor > 0)) throw new RentalError('Margem, imposto e comissão somam 100% ou mais: não existe preço que feche');
  const month = cost.perRentedMonth / divisor;
  const share = cost.value > 0 ? month / cost.value : 0;
  return {
    month, week: month * defaults.weekFactor, day: month * defaults.dayFactor, handling: cost.handling / divisor,
    floorMonth: cost.floorMonth / divisor, valueShare: share,
    market: share < defaults.marketBand.min ? 'abaixo' : share > defaults.marketBand.max ? 'acima' : 'dentro',
  };
}
