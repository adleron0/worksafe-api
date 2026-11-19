import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Base de cálculo da locação (comercial-planejamento/09): parâmetros na base,
 * alíquota da locação no perfil tributário, custo por item do estoque (e por
 * kit), preço sugerido na proposta de locação e a ordem de locação nascendo
 * com o valor de cada período.
 */
describe('Comercial — base de cálculo da locação (e2e)', () => {
  const ALL = [
    'list_comercial', 'create_comercial', 'update_comercial', 'view_custos_comercial', 'update_base_calculo',
    'list_itens_estoque', 'create_itens_estoque', 'update_itens_estoque', 'custos_estoque', 'list_locacoes', 'create_locacoes',
    'list_financeiro', 'create_financeiro', 'update_financeiro',
  ];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    blockRealNetwork();
    jwt = (await bootTestApp()).get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    const customer = await db.customer.create({ data: {
      name: 'Refinaria Beta', corporateName: 'Refinaria Beta SA', cnpj: '11222333000199', companyId: company.id,
      rankId: rank.id, phone: '8133334444', email: 'compras@beta.local', stateId: state.id, cityId: city.id,
    } });
    const h = auth(company.id);
    // a base nasce na primeira leitura; o perfil padrão (tradicional) recebe a alíquota da locação
    const profiles = (await api().get('/commercial/tax-profiles').set(h).expect(200)).body;
    const standard = profiles.find((p: any) => p.isDefault);
    return { db, company, customer, h, standard };
  }

  /** Tripé com os valores de pesquisa do plano 09 (seção 3.1). */
  const tripe = {
    name: 'Tripé com guincho 20 m', tracking: 'quantidade', returnable: true, rentable: true,
    replacementValue: 10050, lifeMonths: 60, residualRate: 0.1, maintenanceRate: 0.12, inspectionCost: 400, inspectionIntervalDays: 360,
    occupancy: 0.4, lossRate: 0.002, handlingCost: 60, minRentPeriod: 'semana', rentMode: 'locacao',
  };

  it('base e perfil: parâmetros da locação, margem da seção e tabela de pesquisa', async () => {
    const { h, standard } = await cenario();
    const base = (await api().get('/commercial/cost-bases/current').set(h).expect(200)).body;
    expect(base.defaults.margins.locacao_cliente).toBe(0.25);
    expect(base.defaults.rental).toMatchObject({ capitalRate: 0.01, insuranceRate: 0.03, weekFactor: 0.45, dayFactor: 0.15 });

    // sem alíquota da locação: vale a do serviço (nominal 21%), o lado conservador
    const before = (await api().post('/commercial/rental/preview').set(h).send({}).expect(201)).body;
    expect(before.tax.rental).toBe(false);
    const tripeRow = (body: any) => body.presets.find((p: any) => p.key === 'tripe');
    expect(tripeRow(before).month).toBe(1726.96); // 932,56 ÷ (1 − 25% − 21%)

    // o contador confirma 12,51%: a locação passa a usar essa alíquota
    const updated = (await api().put(`/commercial/tax-profiles/${standard.id}`).set(h).send({ rentalRate: 0.1251 }).expect(200)).body;
    expect(updated.rentalRate).toBe(0.1251);
    expect(updated.rentalTax.inside).toBe(0.1251);
    const after = (await api().post('/commercial/rental/preview').set(h).send({}).expect(201)).body;
    expect(after.tax.rental).toBe(true);
    expect(tripeRow(after)).toMatchObject({ month: 1492.33, week: 671.55, day: 223.85, handling: 96.02 });
    expect(tripeRow(after).sensitivity.map((s: any) => s.month)).toEqual([1979.05, 1492.33, 1005.61, 762.25]);

    // parâmetros da tela, sem gravar: ocupação de 60% derruba o preço
    const draft = (await api().post('/commercial/rental/preview').set(h).send({ rental: { ...base.defaults.rental, capitalRate: 0.02 } }).expect(201)).body;
    expect(tripeRow(draft).month).toBeGreaterThan(1492.33);

    // gravar a base preserva (e valida) os parâmetros da locação
    await api().put(`/commercial/cost-bases/${base.id}`).set(h).send({ defaults: { ...base.defaults, rental: { ...base.defaults.rental, occupancy: 2 } } }).expect(400);
    const saved = (await api().put(`/commercial/cost-bases/${base.id}`).set(h).send({ defaults: { ...base.defaults, rental: { ...base.defaults.rental, dayFactor: 0.2 } } }).expect(200)).body;
    expect(saved.defaults.rental.dayFactor).toBe(0.2);
    expect(saved.defaults.rental.weekFactor).toBe(0.45);
  });

  it('item do estoque: preço calculado gravado e conta à vista na ficha', async () => {
    const { h, standard } = await cenario();
    await api().put(`/commercial/tax-profiles/${standard.id}`).set(h).send({ rentalRate: 0.1251 }).expect(200);
    const item = (await api().post('/stock/items').set(h).send(tripe).expect(201)).body;
    expect(item.rentalPrice).toMatchObject({ month: 1492.33, week: 671.55, day: 223.85, market: 'dentro' });
    expect(item.rentalPrice.cost.ownMonthly).toBe(364.98);
    expect([item.rentMonthly, item.rentWeekly, item.rentDaily]).toEqual([1492.33, 671.55, 223.85]);

    // modo manual: o que foi digitado fica
    const manual = (await api().put(`/stock/items/${item.id}`).set(h).send({ rentPriceMode: 'manual', rentMonthly: 1800 }).expect(200)).body;
    expect(manual.rentMonthly).toBe(1800);

    // sem a permissão de custos, a ficha não mostra a conta
    const blind = (await api().get(`/stock/items/${item.id}`).set(auth((await testDb().company.findFirstOrThrow()).id, ['list_itens_estoque'])).expect(200)).body;
    expect(blind.rentalPrice).toBeNull();

    // a aba Locação da base lista os itens alugáveis do estoque (a pesquisa fica de referência)
    await api().post('/stock/items').set(h).send({ name: 'Furadeira', tracking: 'quantidade', returnable: true }).expect(201);
    await api().post('/stock/items').set(h).send({ name: 'Detector sem valor', tracking: 'quantidade', returnable: true, rentable: true }).expect(201);
    const preview = (await api().post('/commercial/rental/preview').set(h).send({}).expect(201)).body;
    expect(preview.presets).toHaveLength(7);
    expect(preview.items.map((i: any) => i.label)).toEqual(['Detector sem valor', 'Tripé com guincho 20 m']);
    const [incomplete, listed] = preview.items;
    expect(incomplete.itemId).toEqual(expect.any(Number));
    expect(incomplete.month).toBeUndefined();
    expect(incomplete.error).toMatch(/valor de reposição/);
    expect(listed).toMatchObject({ itemId: item.id, key: `item-${item.id}`, priceMode: 'manual', manual: { mes: 1800 }, month: 1492.33, error: null });
    expect(listed.cost.ownMonthly).toBe(364.98);

    const presets = (await api().get('/stock/items/rental-presets').set(h).expect(200)).body;
    expect(presets.map((p: any) => p.key)).toEqual(['cinto', 'trava_corda', 'trava_retratil', 'tripe', 'detector', 'exaustor', 'kit_resgate']);
  });

  it('proposta de locação: preço pela base, período fechado com desconto e ordem de locação com o valor do período', async () => {
    const { h, customer, standard, db } = await cenario();
    await api().put(`/commercial/tax-profiles/${standard.id}`).set(h).send({ rentalRate: 0.1251 }).expect(200);
    const item = (await api().post('/stock/items').set(h).send(tripe).expect(201)).body;
    const body = (extra: Record<string, unknown>) => ({
      kind: 'locacao', customerId: customer.id, title: 'Tripé para parada', contingencyRate: 0, installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 10 }],
      sections: [{ title: 'Equipamentos', kind: 'locacao_cliente', items: [{ type: 'locacao_cliente', stockItemId: item.id, quantity: 1, extra }] }],
    });

    const monthly = (await api().post('/commercial/proposals').set(h).send(body({ period: 'mes', periods: 1 })).expect(201)).body;
    const line = monthly.calc.sections[0].lines[0];
    // 1 mês: (932,56 + 60) ÷ 0,6249
    expect(line.suggested).toBe(1588.35);
    expect(line.margin).toBeCloseTo(0.25, 4);
    expect(line.rental).toMatchObject({ months: 1, discountRate: 0, perRentedMonth: 932.56, handling: 60, market: 'dentro' });
    expect(monthly.draft.sections[0].items[0].description).toBe('Tripé com guincho 20 m');
    expect(monthly.calc.tax.inside).toBe(0.1251);

    // 6 meses fechados: 10% de desconto → 932,56 × 6 × 0,9 + 60 = 5.095,82 → 8.154,61
    const closed = (await api().post('/commercial/proposals').set(h).send(body({ period: 'mes', periods: 6, closed: true })).expect(201)).body;
    expect(closed.calc.sections[0].lines[0].suggested).toBe(8154.61);
    expect(closed.calc.sections[0].lines[0].rental.discountRate).toBe(0.1);

    // 10 dias: teto (1 semana + 3 diárias = 2 semanas = 0,9 mês)
    const days = (await api().post('/commercial/proposals').set(h).send(body({ period: 'dia', periods: 10 })).expect(201)).body;
    expect(days.calc.sections[0].lines[0].rental.months).toBe(0.9);

    // valor do período digitado na proposta continua valendo (com custo real por trás)
    const typed = (await api().post('/commercial/proposals').set(h).send(body({ period: 'mes', periods: 2, rate: 2000 })).expect(201)).body;
    expect(typed.calc.sections[0].lines[0].suggested).toBe(4000);
    expect(typed.calc.sections[0].lines[0].cost).toBeGreaterThan(1800);

    // aceite: a ordem de locação nasce com o valor de cada período (o da proposta ÷ períodos)
    await api().patch(`/commercial/proposals/status/${closed.id}`).set(h).send({ status: 'enviada' }).expect(200);
    await api().patch(`/commercial/proposals/status/${closed.id}`).set(h).send({ status: 'aceita' }).expect(200);
    const rental = await db.stock_Rental.findFirstOrThrow({ where: { proposalId: closed.id }, include: { lines: true } });
    expect(Number(rental.lines[0].rate)).toBe(Math.round((8154.61 / 6) * 100) / 100);
  });

  it('kit: custo pela soma dos componentes e a locação entrega peça a peça', async () => {
    const { h, customer, db } = await cenario();
    const make = (name: string, value: number, life: number) => api().post('/stock/items').set(h).send({
      name, tracking: 'quantidade', returnable: true, rentable: true, replacementValue: value, lifeMonths: life, residualRate: 0,
    }).expect(201).then((r) => r.body);
    const cinto = await make('Cinto paraquedista', 400, 24);
    const trava = await make('Trava-quedas de corda', 350, 60);
    const kit = (await api().post('/stock/items').set(h).send({
      name: 'Kit NR-35', tracking: 'quantidade', returnable: true, rentable: true, occupancy: 0.4, handlingCost: 90,
      components: [{ itemId: cinto.id, quantity: 2 }, { itemId: trava.id, quantity: 1 }],
    }).expect(201)).body;
    expect(kit.components.map((c: any) => [c.name, c.quantity])).toEqual([['Cinto paraquedista', 2], ['Trava-quedas de corda', 1]]);
    expect(kit.rentalPrice.cost.value).toBe(1150);
    expect(kit.rentalPrice.cost.handling).toBe(90);

    // kit não entra em outro kit, nem um componente vira kit
    await api().put(`/stock/items/${cinto.id}`).set(h).send({ components: [{ itemId: trava.id }] }).expect(400);

    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'locacao', customerId: customer.id, title: 'Kits para obra', contingencyRate: 0, installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 10 }],
      sections: [{ title: 'Equipamentos', kind: 'locacao_cliente', items: [{ type: 'locacao_cliente', stockItemId: kit.id, quantity: 3, extra: { period: 'mes', periods: 2 } }] }],
    }).expect(201)).body;
    const value = proposal.calc.sections[0].lines[0].value;
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200);
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'aceita' }).expect(200);
    const rental = await db.stock_Rental.findFirstOrThrow({ where: { proposalId: proposal.id }, include: { lines: { orderBy: { id: 'asc' } } } });
    expect(rental.lines.map((l) => [l.itemId, Number(l.quantity)])).toEqual([[cinto.id, 6], [trava.id, 3]]);
    // o valor do período do kit é repartido entre os componentes, sem perder centavo
    const perPeriod = rental.lines.reduce((sum, l) => sum + Number(l.rate) * Number(l.quantity), 0);
    expect(perPeriod).toBeCloseTo(value / 2, 1);
  });

  it('item que só sai com operador não vai em proposta de locação; serviço e locação do mesmo cliente geram aviso', async () => {
    const { h, customer } = await cenario();
    const item = (await api().post('/stock/items').set(h).send({ ...tripe, rentMode: 'com_operador' }).expect(201)).body;
    const res = await api().post('/commercial/proposals').set(h).send({
      kind: 'locacao', customerId: customer.id, title: 'Tripé',
      sections: [{ title: 'Equipamentos', kind: 'locacao_cliente', items: [{ type: 'locacao_cliente', stockItemId: item.id, quantity: 1, extra: { period: 'mes', periods: 1 } }] }],
    }).expect(400);
    expect(res.body.message).toMatch(/só sai com operador/);

    const rent = (await api().post('/commercial/proposals').set(h).send({ kind: 'locacao', customerId: customer.id, title: 'Locação de detectores' }).expect(201)).body;
    expect(rent.overlap).toEqual([]);
    const service = (await api().post('/commercial/proposals').set(h).send({ kind: 'servico', customerId: customer.id, title: 'Vigia de espaço confinado' }).expect(201)).body;
    const again = (await api().get(`/commercial/proposals/${rent.id}`).set(h).expect(200)).body;
    expect(again.overlap.map((o: any) => o.id)).toEqual([service.id]);
  });
});
