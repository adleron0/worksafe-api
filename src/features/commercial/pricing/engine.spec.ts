import { computeBase, price, PricingError, professionalCost, resolveTax, round2, TaxProfileInput } from './engine';
import { SHEET_BRACKETS, SHEET_ITEMS, SHEET_MDO, SHEET_PARAMS, SHEET_PROFESSIONALS, SHEET_RBT12 } from './spreadsheet-seed';

/**
 * Teste de ouro: o motor tem de devolver, ao centavo, o que a planilha
 * FORM-COM-001 mostra. Se algum número daqui mudar, ou a fórmula foi alterada
 * de propósito (e este teste muda junto), ou é regressão.
 */
describe('Motor de preços — planilha FORM-COM-001', () => {
  const base = computeBase(SHEET_PARAMS, SHEET_ITEMS);
  const simples: TaxProfileInput = { regime: 'tradicional', mode: 'nominal', rbt12: SHEET_RBT12, ibsCbsShare: 0.166, outsideRate: 0.091, brackets: SHEET_BRACKETS };
  const salary = (name: string) => SHEET_PROFESSIONALS.find((p) => p.name === name)!.salary;
  const example = (extra: Record<string, unknown> = {}) => ({
    workDays: 22, contingencyRate: 0.05, commission: { rate: 0.02, base: 'faturado' as const },
    sections: [{ key: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra' as const, salary: salary('Alpinista N1'), quantity: 1, ...extra }] }],
  });

  it('aba CALC: resultados A a E', () => {
    expect(base.availableDays).toBe(232);
    expect(base.hoursYear).toBe(1856);
    expect(round2(base.workedHoursYear)).toBe(1670.4);
    expect(round2(base.A)).toBe(151.85);
    expect(round2(base.B * 100)).toBe(46.16);
    expect(round2(base.mealPerHour)).toBe(3.75);
    expect(round2(base.transportPerHour)).toBe(1.35);
    expect(round2(base.C)).toBe(5.1);
    expect(round2(base.indirectMonthly)).toBe(33337.92);
    expect(round2(base.indirectPerWorker)).toBe(1961.05);
    expect(round2(base.D)).toBe(12.91);
    expect(round2(base.otherMonthly)).toBe(48115.82);
    expect(round2(base.otherPerWorker)).toBe(2830.34);
    expect(round2(base.E)).toBe(18.64);
    expect(round2(base.debtPerHour)).toBe(9.68);
  });

  it('aba MDO: custo hora e adicionais dos 16 profissionais', () => {
    for (const [name, hour, night, travel, weekend] of SHEET_MDO) {
      const cost = professionalCost(salary(name), SHEET_PARAMS, base);
      expect([name, round2(cost.hourCost), round2(cost.nightPerHour), round2(cost.travelPerHour), round2(cost.weekendPerHour)])
        .toEqual([name, hour, night, travel, weekend]);
    }
  });

  it('Simples Anexo III: nominal 21%, efetiva 17,51%', () => {
    const tax = resolveTax(simples);
    expect(tax.nominal).toBe(0.21);
    expect(round2(tax.effective * 100)).toBe(17.51);
    expect(tax.inside).toBe(0.21);
    expect(tax.outside).toBe(0);
  });

  it('aba PCFP: 1 Alpinista N1 por 22 dias = R$ 20.589,11', () => {
    const { totals, sections } = price(example(), { params: SHEET_PARAMS, base, tax: resolveTax(simples) });
    expect(round2(sections[0].lines[0].cost)).toBe(10392.6);
    expect(round2(totals.suggested)).toBe(19608.68);
    expect(round2(totals.total)).toBe(20589.11);
    expect(round2(totals.tax)).toBe(4323.71);
    expect(round2(totals.profit)).toBe(5872.8);
    expect(round2(totals.profitRate * 100)).toBe(28.52);
    expect(round2(totals.commission)).toBe(411.78);
  });

  it('painel de margem: a margem real do exemplo é 30,0% (25,3% usando a contingência)', () => {
    const { margin } = price(example(), { params: SHEET_PARAMS, base, tax: resolveTax(simples) });
    expect(round2(margin.unused)).toBe(6179.58);
    expect(round2(margin.unusedRate * 100)).toBe(30.01);
    expect(round2(margin.used)).toBe(5199.14);
    expect(round2(margin.usedRate * 100)).toBe(25.25);
    expect(round2(margin.minTotal)).toBe(12911.66);
    expect(round2(margin.maxDiscountRate * 100)).toBe(37.29);
    expect(margin.minTotalOperational).toBeLessThan(margin.minTotal);
  });

  it('adicionais: noturno e viagem por hora; FDS igual à planilha não multiplica pela quantidade', () => {
    const ctx = { params: SHEET_PARAMS, base, tax: resolveTax(simples) };
    const pro = professionalCost(salary('Alpinista N1'), SHEET_PARAMS, base);
    const plain = price(example({ quantity: 3 }), ctx).totals.cost;
    const night = price(example({ quantity: 3, night: true, travel: true }), ctx).totals.cost;
    expect(round2(night - plain)).toBe(round2((pro.nightPerHour + pro.travelPerHour) * 3 * 176));
    const weekend = price({ ...example({ quantity: 3, weekend: true }), weekendDays: 2 }, ctx).totals.cost;
    expect(round2(weekend - plain)).toBe(round2(pro.weekendPerHour * 16));
    const fixed = price({ ...example({ quantity: 3, weekend: true }), weekendDays: 2 }, { ...ctx, params: { ...SHEET_PARAMS, weekendPerWorker: true } }).totals.cost;
    expect(round2(fixed - plain)).toBe(round2(pro.weekendPerHour * 16 * 3));
  });

  it('hora extra só na linha de quem fez: hora de salário × 1,5 com encargos, vezes a quantidade', () => {
    const ctx = { params: SHEET_PARAMS, base, tax: resolveTax(simples) };
    const pro = professionalCost(salary('Resgatista'), SHEET_PARAMS, base);
    expect(round2(pro.overtimePerHour)).toBe(round2((1780.84 / 220) * 1.5 * 1.4616));
    const team = (overtimeHours: number) => price({ workDays: 5, sections: [{ margin: 0.26, items: [
      { type: 'mao_de_obra', salary: salary('Resgatista'), quantity: 1, overtimeHours },
      { type: 'mao_de_obra', salary: salary('Alpinista N1'), quantity: 3 },
    ] }] }, ctx);
    const plain = team(0), extra = team(6);
    expect(round2(extra.sections[0].lines[0].cost - plain.sections[0].lines[0].cost)).toBe(round2(pro.overtimePerHour * 6));
    expect(extra.sections[0].lines[1].cost).toBe(plain.sections[0].lines[1].cost);
    // fotografia antiga, sem o percentual: vale 50%
    const { overtimeRate: _old, ...legacy } = SHEET_PARAMS;
    expect(professionalCost(salary('Resgatista'), legacy, base).overtimePerHour).toBe(pro.overtimePerHour);
  });

  it('locação e material: custo = quantidade × unitário + taxas, com a margem da seção', () => {
    const { sections, totals } = price({
      contingencyRate: 0, sections: [
        { key: 'locacao', margin: 0.05, items: [{ type: 'locacao', quantity: 2, unitCost: 500, extraCost: 100 }] },
        { key: 'material', margin: 0, items: [{ type: 'material', quantity: 10, unitCost: 15, extraCost: 50 }] },
      ],
    }, { params: SHEET_PARAMS, base, tax: resolveTax(simples) });
    expect(sections[0].lines[0].cost).toBe(1100);
    expect(round2(sections[0].lines[0].suggested)).toBe(round2(1100 / 0.74));
    expect(round2(sections[1].lines[0].suggested)).toBe(round2(200 / 0.79));
    expect(round2(totals.total)).toBe(round2(1100 / 0.74 + 200 / 0.79));
  });

  it('valor final digitado substitui o sugerido e a margem mostrada é a real', () => {
    const { sections, totals } = price(
      { contingencyRate: 0, sections: [{ margin: 0.26, items: [{ type: 'avulso', quantity: 1, unitCost: 530, finalValue: 800 }] }] },
      { params: SHEET_PARAMS, base, tax: resolveTax(simples) },
    );
    expect(round2(sections[0].lines[0].suggested)).toBe(1000);
    expect(totals.total).toBe(800);
    expect(round2(sections[0].lines[0].margin! * 100)).toBe(12.75);
  });

  it('Simples híbrido: mesma margem, imposto destacado por fora (exemplo do planejamento)', () => {
    const input = { contingencyRate: 0, sections: [{ margin: 0.26, items: [{ type: 'avulso' as const, quantity: 1, unitCost: 10392.6 }] }] };
    const traditional = price(input, { params: SHEET_PARAMS, base, tax: resolveTax({ ...simples, mode: 'efetiva' }) });
    const hybrid = price(input, { params: SHEET_PARAMS, base, tax: resolveTax({ ...simples, mode: 'efetiva', regime: 'hibrido' }) });
    expect(round2(traditional.totals.total)).toBe(18397.24);
    expect(round2(traditional.totals.customerCredit)).toBe(534.75);
    expect(round2(traditional.totals.customerCost)).toBe(17862.49);
    expect(round2(hybrid.totals.net)).toBe(17496.94);
    expect(round2(hybrid.totals.total)).toBe(19089.17);
    expect(round2(hybrid.totals.customerCredit)).toBe(1592.22);
    expect(round2(hybrid.totals.customerCost)).toBe(17496.94);
    expect(round2(traditional.totals.profitRate * 100)).toBe(26);
    expect(round2(hybrid.totals.profitRate * 100)).toBe(26);
  });

  it('comissão dentro do preço (opção): a margem pedida passa a ser líquida de comissão', () => {
    const tax = resolveTax(simples);
    const { totals } = price(
      { contingencyRate: 0, commission: { rate: 0.02, base: 'faturado', inPrice: true }, sections: [{ margin: 0.26, items: [{ type: 'avulso', quantity: 1, unitCost: 510 }] }] },
      { params: SHEET_PARAMS, base, tax },
    );
    expect(round2(totals.total)).toBe(1000);
    expect(round2(totals.profit - totals.commission)).toBe(260);
  });

  it('efetivo menor encarece a hora; custo "por pessoa" não muda com o efetivo', () => {
    const twelve = computeBase({ ...SHEET_PARAMS, headcount: 12 }, SHEET_ITEMS);
    expect(round2(professionalCost(salary('Alpinista N1'), SHEET_PARAMS, twelve).hourCost)).toBe(72.2);
    const perPerson = SHEET_ITEMS.map((i) => (i.name === 'EPIs' ? { ...i, kind: 'por_pessoa' as const, amount: 5500 / 17 } : i));
    expect(round2(computeBase(SHEET_PARAMS, perPerson).E)).toBe(round2(base.E));
    const twelvePerPerson = computeBase({ ...SHEET_PARAMS, headcount: 12 }, perPerson);
    expect(twelvePerPerson.E).toBeLessThan(twelve.E);
  });

  it('dívida com data de término sai do cálculo depois da data', () => {
    const dated = SHEET_ITEMS.map((i) => (i.isDebt ? { ...i, endsAt: '2027-06-30' } : i));
    expect(round2(computeBase(SHEET_PARAMS, dated, '2027-06-30').debtPerHour)).toBe(9.68);
    const after = computeBase(SHEET_PARAMS, dated, '2027-07-01');
    expect(after.debtPerHour).toBe(0);
    expect(round2(base.E - after.E)).toBe(9.68);
  });

  it('jornada de 40 h (divisor 200): adicionais 10% mais caros, custo hora igual', () => {
    const forty = { ...SHEET_PARAMS, additionalDivisor: 200 };
    const now = professionalCost(2426.5, SHEET_PARAMS, base), then = professionalCost(2426.5, forty, base);
    expect(then.hourCost).toBe(now.hourCost);
    expect(round2(then.nightPerHour / now.nightPerHour)).toBe(1.1);
  });

  it('desconto em R$ sai do preço líquido e a margem real acompanha', () => {
    const ctx = { params: SHEET_PARAMS, base, tax: resolveTax(simples) };
    const full = price(example(), ctx), cut = price({ ...example(), discount: 1000 }, ctx);
    expect(round2(cut.totals.total)).toBe(round2(full.totals.total - 1000));
    expect(round2(cut.totals.tax)).toBe(round2(full.totals.tax - 210));
    expect(round2(cut.totals.profit)).toBe(round2(full.totals.profit - 790));
    expect(cut.margin.unusedRate).toBeLessThan(full.margin.unusedRate);
    // desconto maior que o preço não vira preço negativo
    expect(price({ ...example(), discount: 1e9 }, ctx).totals.total).toBe(0);
  });

  it('treinamento: preço de tabela é o sugerido; o custo (opcional) mostra a margem', () => {
    const ctx = { params: SHEET_PARAMS, base, tax: resolveTax(simples) };
    const { sections, totals } = price({ contingencyRate: 0, sections: [{ margin: 0, items: [
      { type: 'treinamento', quantity: 1, unitCost: 1200, listPrice: 4500 },
      { type: 'treinamento', quantity: 1, unitCost: 0, listPrice: 3000, finalValue: 2800 },
    ] }] }, ctx);
    expect(sections[0].lines[0].suggested).toBe(4500);
    expect(round2(sections[0].lines[0].margin! * 100)).toBe(52.33);
    expect(sections[0].lines[1].value).toBe(2800);
    expect(totals.total).toBe(7300);
    expect(totals.suggested).toBe(7500);
  });

  it('recusa conta impossível em vez de devolver preço negativo', () => {
    const ctx = { params: SHEET_PARAMS, base, tax: resolveTax(simples) };
    expect(() => price({ sections: [{ margin: 0.79, items: [{ type: 'avulso', unitCost: 10 }] }] }, ctx)).toThrow(PricingError);
    expect(() => computeBase({ ...SHEET_PARAMS, headcount: 0 }, SHEET_ITEMS)).toThrow(PricingError);
    expect(() => computeBase({ ...SHEET_PARAMS, restDays: 400 }, SHEET_ITEMS)).toThrow(PricingError);
  });
});
