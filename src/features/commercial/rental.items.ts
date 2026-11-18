import { Prisma, PrismaClient } from '@prisma/client';
import { resolveRentalTax, TaxBracket } from './pricing/engine';
import { RentalError, RentalItemInput, RentalOverrides, rentalCost, rentalDefaultsOf, rentalTable } from './pricing/rental';

type Db = PrismaClient | Prisma.TransactionClient;

/** O que a proposta guarda de cada item do estoque alugado (fica na fotografia). */
export interface RentalSnapshotItem {
  name: string;
  /** calculado | manual */
  priceMode: string;
  /** locacao | com_operador | ambos */
  rentMode: string;
  minRentPeriod: string | null;
  /** preços digitados no cadastro (modo manual) */
  rent: { dia: number | null; semana: number | null; mes: number | null };
  input: RentalItemInput;
}

const n = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));
const positive = (value: number | null) => (value !== null && value > 0 ? value : null);

/** Padrões de locação da categoria (`defaults.rental`), a própria ou a de cima. */
function categoryRental(categoryId: number | null, categories: Map<number, { parentId: number | null; defaults: unknown }>): RentalOverrides {
  const own = categoryId ? categories.get(categoryId) : undefined;
  const parent = own?.parentId ? categories.get(own.parentId) : undefined;
  const read = (row?: { defaults: unknown }) => ((row?.defaults as Record<string, any> | null)?.rental ?? {}) as Record<string, unknown>;
  const merged = { ...read(parent), ...read(own) };
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(merged)) {
    const number = Number(value);
    if (value !== null && value !== '' && Number.isFinite(number)) out[key] = number;
  }
  return out as RentalOverrides;
}

type ItemRow = Prisma.Stock_ItemGetPayload<{ include: { components: { include: { component: true } } } }>;

/** Item do estoque → parâmetros da conta: o do item, senão o da categoria (a base entra depois, no motor). */
function inputOf(item: Prisma.Stock_ItemGetPayload<object>, categories: Map<number, { parentId: number | null; defaults: unknown }>): RentalItemInput {
  const cat = categoryRental(item.categoryId, categories);
  const lives = [n(item.lifeMonths), n(item.economicLifeMonths)].filter((v): v is number => v !== null && v > 0);
  const pick = (own: number | null, fallback: number | null | undefined) => (own !== null ? own : fallback ?? null);
  return {
    name: item.name,
    value: positive(n(item.replacementValue)) ?? positive(n(item.averageCost)) ?? positive(n(item.lastCost)) ?? cat.value ?? null,
    lifeMonths: lives.length ? Math.min(...lives) : cat.lifeMonths ?? null,
    residualRate: pick(n(item.residualRate), cat.residualRate),
    maintenanceRate: pick(n(item.maintenanceRate), cat.maintenanceRate),
    inspectionCost: pick(n(item.inspectionCost), cat.inspectionCost),
    inspectionMonths: item.inspectionIntervalDays ? item.inspectionIntervalDays / 30 : cat.inspectionMonths ?? null,
    calibrationCost: pick(n(item.calibrationCost), cat.calibrationCost),
    calibrationMonths: item.calibrationIntervalMonths ?? cat.calibrationMonths ?? null,
    occupancy: pick(n(item.occupancy), cat.occupancy),
    lossRate: pick(n(item.lossRate), cat.lossRate),
    handlingCost: pick(n(item.handlingCost), cat.handlingCost),
  };
}

/** Lê os itens (com os componentes, se forem kit) e monta o que a conta da locação precisa. */
export async function loadRentalItems(db: Db, companyId: number, ids: number[]): Promise<Record<string, RentalSnapshotItem>> {
  if (!ids.length) return {};
  const [rows, categories] = await Promise.all([
    db.stock_Item.findMany({ where: { companyId, id: { in: ids } }, include: { components: { include: { component: true }, orderBy: [{ order: 'asc' }, { id: 'asc' }] } } }),
    db.stock_Category.findMany({ where: { companyId }, select: { id: true, parentId: true, defaults: true } }),
  ]);
  const catMap = new Map(categories.map((c) => [c.id, { parentId: c.parentId, defaults: c.defaults }]));
  const out: Record<string, RentalSnapshotItem> = {};
  for (const row of rows as ItemRow[]) {
    const input = inputOf(row, catMap);
    if (row.components.length) {
      // kit: a conta soma os componentes; do kit valem a ocupação, a preparação e a inspeção do conjunto
      input.components = row.components.map((c) => ({ quantity: Number(c.quantity), item: inputOf(c.component, catMap) }));
    }
    out[row.id] = {
      name: row.name, priceMode: row.rentPriceMode, rentMode: row.rentMode, minRentPeriod: row.minRentPeriod,
      rent: { dia: n(row.rentDaily), semana: n(row.rentWeekly), mes: n(row.rentMonthly) },
      input,
    };
  }
  return out;
}

/** Parâmetros comuns da locação e margem da seção na base vigente (para telas fora da proposta). */
export async function currentRentalBase(db: Db, companyId: number, date: string) {
  const at = new Date(`${date}T00:00:00.000Z`);
  const base = (await db.commercial_CostBase.findFirst({ where: { companyId, inactiveAt: null, effectiveFrom: { lte: at } }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }], select: { defaults: true } }))
    ?? (await db.commercial_CostBase.findFirst({ where: { companyId, inactiveAt: null }, orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }], select: { defaults: true } }));
  return (base?.defaults ?? {}) as Record<string, any>;
}

/**
 * Preço sugerido de locação de um item do estoque com a base vigente: margem
 * da seção de locação e imposto da locação do perfil padrão. É o que a ficha do
 * item mostra e o que vai para rentDaily/Weekly/Monthly no modo "calculado".
 */
export async function suggestedRentPrices(db: Db, companyId: number, itemId: number, date = new Date().toISOString().slice(0, 10)) {
  const items = await loadRentalItems(db, companyId, [itemId]);
  const item = items[itemId];
  if (!item) return null;
  const base = await currentRentalBase(db, companyId, date);
  const defaults = rentalDefaultsOf(base.rental);
  const margin = Number(base.margins?.locacao_cliente ?? 0.25);
  const at = new Date(`${date}T00:00:00.000Z`);
  const profiles = await db.commercial_TaxProfile.findMany({ where: { companyId, inactiveAt: null }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }] });
  const regime = (profiles.find((p) => p.isDefault) ?? profiles[0])?.regime;
  const pool = profiles.filter((p) => p.regime === regime);
  const tax = pool.find((p) => p.effectiveFrom.getTime() <= at.getTime()) ?? pool[pool.length - 1];
  try {
    const rentalTax = tax ? resolveRentalTax({
      regime: tax.regime, mode: tax.mode, rbt12: Number(tax.rbt12), manualRate: tax.manualRate === null ? null : Number(tax.manualRate),
      ibsCbsShare: Number(tax.ibsCbsShare), outsideRate: Number(tax.outsideRate), brackets: (tax.brackets as unknown as TaxBracket[]) ?? [],
      rentalRate: tax.rentalRate === null ? null : Number(tax.rentalRate), rentalOutsideRate: tax.rentalOutsideRate === null ? null : Number(tax.rentalOutsideRate),
    }) : null;
    const inside = rentalTax?.inside ?? 0;
    const cost = rentalCost(item.input, defaults);
    const table = rentalTable(cost, defaults, 1 - margin - inside);
    const r = (x: number) => Math.round(x * 100) / 100;
    return {
      month: r(table.month), week: r(table.week), day: r(table.day), handling: r(table.handling), floorMonth: r(table.floorMonth),
      valueShare: Math.round(table.valueShare * 1e4) / 1e4, market: table.market, margin, tax: { name: tax?.name ?? null, inside, rental: rentalTax?.rental ?? false },
      cost: {
        value: r(cost.value), occupancy: cost.occupancy, depreciation: r(cost.depreciation), capital: r(cost.capital), insurance: r(cost.insurance),
        maintenance: r(cost.maintenance), inspection: r(cost.inspection), calibration: r(cost.calibration), ownMonthly: r(cost.ownMonthly),
        loss: r(cost.loss), perRentedMonth: r(cost.perRentedMonth), handling: r(cost.handling),
      },
      error: null as string | null,
    };
  } catch (error) {
    if (error instanceof RentalError) return { error: error.message };
    throw error;
  }
}
