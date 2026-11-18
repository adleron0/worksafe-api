import { round2 } from './engine';
import { daysInMonths, discountFor, RENTAL_DEFAULTS, RENTAL_PRESETS, rentalCost, rentalDefaultsOf, RentalError, rentalLine, rentalTable } from './rental';

/**
 * Teste de ouro da locação: a tabela 3.3 do plano 09 (margem 25%, imposto da
 * locação 12,51%, capital 1% a.m., seguro 3% a.a., semana 0,45 e dia 0,15).
 */
describe('Base de cálculo da locação — tabela 3.3 do plano 09', () => {
  const divisor = 1 - 0.25 - 0.1251;
  const table = (key: string) => rentalTable(rentalCost(RENTAL_PRESETS[key], RENTAL_DEFAULTS), RENTAL_DEFAULTS, divisor);

  it.each([
    ['cinto', 82.68, 37.21, 12.4, 24],
    ['trava_corda', 45.21, 20.34, 6.78, 24],
    ['trava_retratil', 236.84, 106.58, 35.53, 64.01],
    ['tripe', 1492.33, 671.55, 223.85, 96.02],
    ['detector', 921.75, 414.79, 138.26, 80.01],
    ['exaustor', 972.66, 437.7, 145.9, 96.02],
    ['kit_resgate', 1233.6, 555.12, 185.04, 144.02],
  ])('%s: mês %s, semana %s, dia %s, preparação %s', (key, month, week, day, handling) => {
    const t = table(key as string);
    expect([round2(t.month), round2(t.week), round2(t.day), round2(t.handling)]).toEqual([month, week, day, handling]);
  });

  it('tripé: conta aberta e piso com ocupação de 100%', () => {
    const cost = rentalCost(RENTAL_PRESETS.tripe, RENTAL_DEFAULTS);
    expect(round2(cost.depreciation)).toBe(150.75);
    expect(round2(cost.maintenance)).toBe(100.5);
    expect(round2(cost.ownMonthly)).toBe(364.98);
    expect(round2(cost.perRentedMonth)).toBe(932.56);
    expect(round2(rentalTable(cost, RENTAL_DEFAULTS, divisor).floorMonth)).toBe(616.23);
    expect(Math.round(rentalTable(cost, RENTAL_DEFAULTS, divisor).valueShare * 1000) / 10).toBe(14.8);
  });

  it('com o imposto do serviço (17,51%) o tripé sai a R$ 1.622,12', () => {
    const cost = rentalCost(RENTAL_PRESETS.tripe, RENTAL_DEFAULTS);
    expect(round2(rentalTable(cost, RENTAL_DEFAULTS, 1 - 0.25 - 0.1751).month)).toBe(1622.12);
  });

  it('período fechado de 6 meses: 10% de desconto', () => {
    const cost = rentalCost(RENTAL_PRESETS.tripe, RENTAL_DEFAULTS);
    const line = rentalLine(cost, { quantity: 1, period: 'mes', periods: 6, closed: true }, RENTAL_DEFAULTS);
    expect(line.discountRate).toBe(0.1);
    // 6 × 1.492,33 × 0,9 + preparação 96,02
    expect(round2(line.cost / divisor)).toBe(8154.61);
    expect(round2(rentalLine(cost, { quantity: 1, period: 'mes', periods: 6 }, RENTAL_DEFAULTS).discountRate)).toBe(0);
  });

  it('teto: diárias nunca passam da semana nem do mês', () => {
    expect(round2(daysInMonths(1, RENTAL_DEFAULTS))).toBe(0.15);
    expect(round2(daysInMonths(3, RENTAL_DEFAULTS))).toBe(0.45); // 3 diárias = 1 semana
    expect(round2(daysInMonths(10, RENTAL_DEFAULTS))).toBe(0.9); // 1 semana + 3 diárias = 2 semanas
    expect(daysInMonths(21, RENTAL_DEFAULTS)).toBe(1); // 3 semanas (1,35) > 1 mês
    expect(round2(daysInMonths(31, RENTAL_DEFAULTS))).toBe(1.15); // 1 mês + 1 diária
    expect(rentalLine(rentalCost(RENTAL_PRESETS.cinto, RENTAL_DEFAULTS), { quantity: 2, period: 'semana', periods: 3 }, RENTAL_DEFAULTS).months).toBe(1);
  });

  it('desconto pelo prazo', () => {
    expect(discountFor(2, RENTAL_DEFAULTS.longDiscounts)).toBe(0);
    expect(discountFor(3, RENTAL_DEFAULTS.longDiscounts)).toBe(0.05);
    expect(discountFor(11, RENTAL_DEFAULTS.longDiscounts)).toBe(0.1);
    expect(discountFor(24, RENTAL_DEFAULTS.longDiscounts)).toBe(0.15);
  });

  it('kit: soma os componentes e usa a ocupação e a preparação do kit', () => {
    const kit = rentalCost({ occupancy: 0.4, handlingCost: 90, components: [
      { quantity: 2, item: RENTAL_PRESETS.cinto }, { quantity: 1, item: RENTAL_PRESETS.trava_corda },
    ] }, RENTAL_DEFAULTS);
    const cinto = rentalCost(RENTAL_PRESETS.cinto, RENTAL_DEFAULTS);
    const trava = rentalCost(RENTAL_PRESETS.trava_corda, RENTAL_DEFAULTS);
    expect(kit.value).toBe(1150);
    expect(round2(kit.ownMonthly)).toBe(round2(2 * cinto.ownMonthly + trava.ownMonthly));
    expect(round2(kit.perRentedMonth)).toBe(round2(kit.ownMonthly / 0.4 + 2 * cinto.loss + trava.loss));
    expect(kit.handling).toBe(90);
  });

  it('sem valor ou vida útil não há conta', () => {
    expect(() => rentalCost({ lifeMonths: 60 }, RENTAL_DEFAULTS)).toThrow(RentalError);
    expect(() => rentalCost({ value: 100 }, RENTAL_DEFAULTS)).toThrow(RentalError);
    expect(() => rentalCost({ value: 100, lifeMonths: 10, occupancy: 0 }, RENTAL_DEFAULTS)).toThrow(RentalError);
  });

  it('parâmetros guardados incompletos caem nos padrões', () => {
    const d = rentalDefaultsOf({ capitalRate: '0.02', occupancy: null, longDiscounts: [{ fromMonths: 12, rate: 0.2 }] });
    expect(d.capitalRate).toBe(0.02);
    expect(d.occupancy).toBe(RENTAL_DEFAULTS.occupancy);
    expect(d.longDiscounts).toEqual([{ fromMonths: 12, rate: 0.2 }]);
    expect(d.marketBand).toEqual(RENTAL_DEFAULTS.marketBand);
  });
});
