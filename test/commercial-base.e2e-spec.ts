import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Comercial — base de cálculo, perfis tributários e motor de preços.
 *
 * O contrato central: a API devolve, ao centavo, os números da planilha
 * FORM-COM-001, e trocar de regra (efetivo, jornada, regime tributário) é
 * dado com data de vigência — nunca código.
 */
describe('Comercial — base de cálculo e motor (e2e)', () => {
  const ALL = ['list_comercial', 'create_comercial', 'update_comercial', 'inactive_comercial', 'activate_comercial'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());

  async function empresa() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    return company;
  }
  const current = async (companyId: number, date?: string) =>
    (await api().get(`/commercial/cost-bases/current${date ? `?date=${date}` : ''}`).set(auth(companyId)).expect(200)).body;
  const pro = (base: any, name: string) => base.professionals.find((p: any) => p.name === name);
  const exemplo = (professionalId: number, extra: Record<string, unknown> = {}) => ({
    input: {
      workDays: 22, contingencyRate: 0.05, commission: { rate: 0.02, base: 'faturado' },
      sections: [{ key: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 1 }] }],
    },
    ...extra,
  });

  it('primeira abertura carrega a planilha: A–E, 16 profissionais e os dois perfis tributários', async () => {
    const company = await empresa();
    const base = await current(company.id);
    expect(base.result).toMatchObject({ A: 151.85, B: 0.4616, C: 5.1, D: 12.91, E: 18.64, debtPerHour: 9.68 });
    expect(base.professionals).toHaveLength(16);
    expect(pro(base, 'Alpinista N1')).toMatchObject({ hourCost: 59.05, nightPerHour: 3.22, travelPerHour: 4.03, weekendPerHour: 32.24 });
    expect(pro(base, 'Engenheiro').hourCost).toBe(91.79);
    expect(base.items.filter((i: any) => i.group === 'encargo')).toHaveLength(8);
    expect(base.sensitivity.map((s: any) => s.headcount)).toEqual([12, 17, 22]);

    const profiles = (await api().get('/commercial/tax-profiles').set(auth(company.id)).expect(200)).body;
    expect(profiles.map((p: any) => [p.regime, p.isDefault, p.current])).toEqual([['tradicional', true, true], ['hibrido', false, false]]);
    expect(profiles[0].tax).toMatchObject({ nominal: 0.21, effective: 0.1751, inside: 0.21, outside: 0 });

    // Abrir de novo (ou em duas abas) não duplica a carga.
    await Promise.all([current(company.id), current(company.id)]);
    expect(await testDb().commercial_CostBase.count()).toBe(1);
    expect(await testDb().commercial_Professional.count()).toBe(16);
  });

  it('preview: o exemplo da planilha dá R$ 20.589,11', async () => {
    const company = await empresa();
    const base = await current(company.id);
    const { body } = await api().post('/commercial/pricing/preview').set(auth(company.id))
      .send(exemplo(pro(base, 'Alpinista N1').id)).expect(201);
    expect(body.totals).toMatchObject({ cost: 10392.6, suggested: 19608.68, total: 20589.11, tax: 4323.71, profit: 5872.8, commission: 411.78 });
    expect(body.margin).toMatchObject({ unused: 6179.58, minTotal: 12911.66 });
    expect(body.taxProfile.regime).toBe('tradicional');
    // preview nunca grava
    expect(await testDb().commercial_CostBase.count()).toBe(1);
  });

  it('chave tradicional ⟷ híbrido: muda o padrão e o preço; a comparação mostra os dois', async () => {
    const company = await empresa();
    const base = await current(company.id);
    const id = pro(base, 'Alpinista N1').id;
    const compared = (await api().post('/commercial/pricing/preview').set(auth(company.id)).send(exemplo(id, { compare: true })).expect(201)).body;
    expect(compared.compare.tradicional.totals.total).toBe(20589.11);
    expect(compared.compare.hibrido.tax).toMatchObject({ regime: 'hibrido', outside: 0.091 });
    expect(compared.compare.hibrido.totals.taxOutside).toBeGreaterThan(0);

    const profiles = (await api().get('/commercial/tax-profiles').set(auth(company.id))).body;
    const hybrid = profiles.find((p: any) => p.regime === 'hibrido');
    const after = (await api().patch(`/commercial/tax-profiles/default/${hybrid.id}`).set(auth(company.id)).expect(200)).body;
    expect(after.filter((p: any) => p.isDefault).map((p: any) => p.regime)).toEqual(['hibrido']);

    const now = (await api().post('/commercial/pricing/preview').set(auth(company.id)).send(exemplo(id)).expect(201)).body;
    expect(now.taxProfile.regime).toBe('hibrido');
    expect(now.totals.total).toBe(compared.compare.hibrido.totals.total);
    // Sem trocar o padrão, dá para pedir o outro regime só neste cálculo.
    const forced = (await api().post('/commercial/pricing/preview').set(auth(company.id)).send(exemplo(id, { scenario: { regime: 'tradicional' } })).expect(201)).body;
    expect(forced.totals.total).toBe(20589.11);

    // O padrão não pode ser inativado, e nem o último perfil.
    await api().patch(`/commercial/tax-profiles/inactive/${hybrid.id}`).set(auth(company.id)).expect(409);
  });

  it('simulação "e se fôssemos 12 homens": só no cálculo, a base não muda', async () => {
    const company = await empresa();
    const base = await current(company.id);
    const id = pro(base, 'Alpinista N1').id;
    const sim = (await api().post('/commercial/pricing/preview').set(auth(company.id)).send(exemplo(id, { scenario: { headcount: 12 } })).expect(201)).body;
    expect(sim.sections[0].lines[0].hourCost).toBe(72.2);
    expect((await current(company.id)).params.headcount).toBe(17);
  });

  it('editar a base: efetivo, item novo e opção de FDS recalculam o custo hora', async () => {
    const company = await empresa();
    const base = await current(company.id);
    const items = [...base.items, { group: 'outro_custo', subgroup: 'Estrutura e ADM', name: 'Seguro patrimonial', amount: 1700 }];
    const { body } = await api().put(`/commercial/cost-bases/${base.id}`).set(auth(company.id))
      .send({ params: { ...base.params, headcount: 12, weekendPerWorker: true }, items }).expect(200);
    expect(body.params).toMatchObject({ headcount: 12, weekendPerWorker: true });
    expect(body.items).toHaveLength(base.items.length + 1);
    expect(pro(body, 'Alpinista N1').hourCost).toBeGreaterThan(72.2);
    expect(body.result.otherMonthly).toBe(49815.82);
  });

  it('conta ao vivo (compute) devolve o resultado do rascunho sem gravar', async () => {
    const company = await empresa();
    const base = await current(company.id);
    const { body } = await api().post('/commercial/cost-bases/compute').set(auth(company.id))
      .send({ params: { ...base.params, headcount: 12 }, items: base.items }).expect(201);
    expect(pro(body, 'Alpinista N1').hourCost).toBe(72.2);
    expect((await current(company.id)).params.headcount).toBe(17);
  });

  it('base que não fecha a conta é recusada e nada é gravado', async () => {
    const company = await empresa();
    const base = await current(company.id);
    const put = (params: Record<string, unknown>, items = base.items) =>
      api().put(`/commercial/cost-bases/${base.id}`).set(auth(company.id)).send({ params: { ...base.params, ...params }, items });
    await put({ headcount: 0 }).expect(400);
    await put({ restDays: 360 }).expect(400);
    await put({ hoursPerDay: 'abc' }).expect(400);
    await put({}, [{ group: 'encargo', name: '', rate: 0.1 }]).expect(400);
    await put({}, [{ group: 'invalido', name: 'X item', rate: 0.1 }]).expect(400);
    const after = await current(company.id);
    expect(after.params.headcount).toBe(17);
    expect(after.items).toHaveLength(base.items.length);
  });

  it('vigência: a jornada de 40 h entra como versão nova e vale a partir da data', async () => {
    const company = await empresa();
    const base = await current(company.id);
    const id = pro(base, 'Alpinista N1').id;
    const created = (await api().post('/commercial/cost-bases').set(auth(company.id))
      .send({ name: 'Jornada 40 h', effectiveFrom: '2027-12-15', params: { ...base.params, additionalDivisor: 200, weeklyHours: 40 } }).expect(201)).body;
    expect(created.items).toHaveLength(base.items.length);
    expect(pro(created, 'Alpinista N1')).toMatchObject({ hourCost: 59.05, nightPerHour: 3.55 });

    // mesma data duas vezes não
    await api().post('/commercial/cost-bases').set(auth(company.id)).send({ name: 'Outra', effectiveFrom: '2027-12-15' }).expect(409);

    expect((await current(company.id, '2027-12-14')).id).toBe(base.id);
    expect((await current(company.id, '2027-12-15')).id).toBe(created.id);
    const versions = (await api().get('/commercial/cost-bases?date=2027-12-20').set(auth(company.id)).expect(200)).body;
    expect(versions.map((v: any) => [v.name, v.current])).toEqual([['Jornada 40 h', true], ['Base da planilha FORM-COM-001', false]]);

    // O preview usa a versão da data pedida: noturno fica 10% mais caro.
    const night = (date: string) => api().post('/commercial/pricing/preview').set(auth(company.id)).send({
      date, input: { workDays: 1, sections: [{ margin: 0, items: [{ type: 'mao_de_obra', professionalId: id, quantity: 1, night: true }] }] },
    }).expect(201);
    const before = (await night('2027-12-01')).body, after = (await night('2027-12-20')).body;
    expect(before.costBase.id).toBe(base.id);
    expect(after.costBase.id).toBe(created.id);
    expect(after.totals.cost).toBeGreaterThan(before.totals.cost);

    // Inativar a versão nova devolve tudo para a anterior; a última ativa não sai.
    await api().patch(`/commercial/cost-bases/inactive/${created.id}`).set(auth(company.id)).expect(200);
    expect((await current(company.id, '2027-12-20')).id).toBe(base.id);
    await api().patch(`/commercial/cost-bases/inactive/${base.id}`).set(auth(company.id)).expect(409);
  });

  it('dívida com data de término sai do custo hora depois da data', async () => {
    const company = await empresa();
    const base = await current(company.id);
    const items = base.items.map((i: any) => (i.isDebt ? { ...i, endsAt: '2027-06-30' } : i));
    await api().put(`/commercial/cost-bases/${base.id}`).set(auth(company.id)).send({ params: base.params, items }).expect(200);
    expect((await current(company.id, '2027-06-30')).result.debtPerHour).toBe(9.68);
    const later = await current(company.id, '2027-07-01');
    expect(later.result.debtPerHour).toBe(0);
    expect(pro(later, 'Alpinista N1').hourCost).toBe(49.36);
  });

  it('perfil tributário: criar, editar e validar', async () => {
    const company = await empresa();
    const profiles = (await api().get('/commercial/tax-profiles').set(auth(company.id))).body;
    const simples = profiles[0];
    const updated = (await api().put(`/commercial/tax-profiles/${simples.id}`).set(auth(company.id)).send({ mode: 'efetiva' }).expect(200)).body;
    expect(updated.tax.inside).toBe(0.1751);
    const manual = (await api().post('/commercial/tax-profiles').set(auth(company.id))
      .send({ name: 'Lucro presumido', regime: 'tradicional', mode: 'manual', manualRate: 0.1633, effectiveFrom: '2028-01-01', brackets: [] }).expect(201)).body;
    expect(manual.tax).toMatchObject({ das: 0.1633, inside: 0.1633 });
    // Vigência: em 2028 o regime tradicional passa a usar o perfil novo.
    const in2028 = (await api().get('/commercial/tax-profiles?date=2028-02-01').set(auth(company.id))).body;
    expect(in2028.find((p: any) => p.current).id).toBe(manual.id);

    await api().post('/commercial/tax-profiles').set(auth(company.id)).send({ name: 'Sem alíquota', mode: 'manual', effectiveFrom: '2028-01-01' }).expect(400);
    await api().post('/commercial/tax-profiles').set(auth(company.id)).send({ name: 'Sem faixa', mode: 'nominal', effectiveFrom: '2028-01-01', brackets: [] }).expect(400);
    await api().put(`/commercial/tax-profiles/${simples.id}`).set(auth(company.id)).send({ regime: 'outro' }).expect(400);
  });

  it('margem + imposto ≥ 100% devolve erro claro, não preço negativo', async () => {
    const company = await empresa();
    const { body } = await api().post('/commercial/pricing/preview').set(auth(company.id))
      .send({ input: { sections: [{ margin: 0.8, items: [{ type: 'avulso', quantity: 1, unitCost: 100 }] }] } }).expect(400);
    expect(JSON.stringify(body)).toContain('100%');
    await api().post('/commercial/pricing/preview').set(auth(company.id)).send({ input: {} }).expect(400);
    await api().post('/commercial/pricing/preview').set(auth(company.id))
      .send({ input: { sections: [{ margin: 0, items: [{ type: 'mao_de_obra', professionalId: 999999 }] }] } }).expect(400);
  });

  it('profissionais: cadastro simples, nome único, salário obrigatório', async () => {
    const company = await empresa();
    await current(company.id);
    const created = (await api().post('/commercial-professionals').set(auth(company.id)).send({ name: 'Supervisor de Campo', salary: 4200 }).expect(201)).body;
    await api().post('/commercial-professionals').set(auth(company.id)).send({ name: 'supervisor de campo', salary: 4000 }).expect(409);
    await api().post('/commercial-professionals').set(auth(company.id)).send({ name: 'Sem salário' }).expect(400);
    await api().put(`/commercial-professionals/${created.id}`).set(auth(company.id)).send({ salary: 4500 }).expect(200);
    const base = await current(company.id);
    expect(base.professionals).toHaveLength(17);
    expect(pro(base, 'Supervisor de Campo').salary).toBe(4500);
    await api().patch(`/commercial-professionals/inactive/${created.id}`).set(auth(company.id)).expect(200);
    expect((await current(company.id)).professionals).toHaveLength(16);
  });

  it('permissões: sem comercial não entra; quem só lista não altera', async () => {
    const company = await empresa();
    await api().get('/commercial/cost-bases/current').set(auth(company.id, ['list_financeiro'])).expect(403);
    await api().get('/commercial/cost-bases/current').expect(401);
    const reader = auth(company.id, ['list_comercial']);
    const base = (await api().get('/commercial/cost-bases/current').set(reader).expect(200)).body;
    await api().put(`/commercial/cost-bases/${base.id}`).set(reader).send({ params: base.params }).expect(403);
    await api().post('/commercial/cost-bases').set(reader).send({ name: 'X', effectiveFrom: '2028-01-01' }).expect(403);
    await api().post('/commercial-professionals').set(reader).send({ name: 'Novo', salary: 1 }).expect(403);
    await api().post('/commercial/pricing/preview').set(reader).send({ input: { sections: [] } }).expect(201);
  });

  it('empresa não enxerga nem altera a base de outra', async () => {
    const a = await empresa();
    const b = await makeCompany();
    const baseA = await current(a.id);
    const baseB = await current(b.id);
    expect(baseB.id).not.toBe(baseA.id);
    await api().get(`/commercial/cost-bases/${baseA.id}`).set(auth(b.id)).expect(404);
    await api().put(`/commercial/cost-bases/${baseA.id}`).set(auth(b.id)).send({ params: { ...baseA.params, headcount: 1 } }).expect(404);
    const taxA = (await api().get('/commercial/tax-profiles').set(auth(a.id))).body[1];
    await api().patch(`/commercial/tax-profiles/default/${taxA.id}`).set(auth(b.id)).expect(404);
    const proA = pro(baseA, 'Alpinista N1').id;
    await api().post('/commercial/pricing/preview').set(auth(b.id))
      .send({ input: { sections: [{ margin: 0, items: [{ type: 'mao_de_obra', professionalId: proA }] }] } }).expect(400);
    await api().post('/commercial/pricing/preview').set(auth(b.id)).send({ scenario: { costBaseId: baseA.id }, input: { sections: [] } }).expect(404);
    expect((await current(a.id)).params.headcount).toBe(17);
  });
});
