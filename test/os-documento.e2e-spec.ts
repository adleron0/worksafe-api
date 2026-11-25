import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * A OS como documento.
 *
 * O que não pode quebrar: a folha sai sem valores por padrão e só traz o valor
 * de venda com `view_valores_os`; replanejar guarda o cronograma da proposta
 * como linha de base e não deixa sumir etapa com avanço; o link do cliente só
 * abre ligado, nunca mostra valores, rascunho nem nome completo da equipe, e
 * para de abrir quando desligado ou com a chave trocada; a linha do tempo
 * mostra os dias sem RDO; a lista traz o avanço e o RDO de hoje.
 */
describe('OS como documento (e2e)', () => {
  const ORDERS = ['list_ordens_de_servico', 'update_ordens_de_servico', 'all_ordens_de_servico', 'update_rdo'];
  const ALL = ['list_comercial', 'create_comercial', 'update_comercial', 'all_propostas', ...ORDERS, 'view_custos_comercial', 'view_valores_os'];
  const TODAY = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const day = (offset: number) => new Date(new Date(`${TODAY}T12:00:00Z`).getTime() + offset * 86400000).toISOString().slice(0, 10);
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => { blockRealNetwork(); jwt = (await bootTestApp()).get(JwtService); });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());

  async function obra() {
    const company = await makeCompany();
    await testDb().company.update({ where: { id: company.id }, data: { system_domain: 'sistema.exemplo.com.br' } });
    userId = (await makeSeller(company.id)).id;
    const db = testDb();
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    const customer = await db.customer.create({ data: { name: 'Indústria Alfa', corporateName: 'Indústria Alfa SA', cnpj: '11222333000199', companyId: company.id, rankId: rank.id, phone: '81', email: 'a@a.local', stateId: state.id, cityId: city.id } });
    const h = auth(company.id);
    const options = (await api().get('/commercial/proposals/options').set(h).expect(200)).body;
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id;
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId: customer.id, title: 'Linha de vida', contactName: 'Maria', workDays: 10,
      sections: [
        { title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 2 }] },
        { title: 'Materiais', kind: 'material', margin: 0.1, items: [{ type: 'material', description: 'Cabo de aço', quantity: 4, unitCost: 100 }] },
      ],
      installments: [{ percent: 1, dueRule: 'dias_apos_aceite', dueDays: 5, description: 'Única' }],
      schedule: { unit: 'dia', steps: [{ title: 'Mobilização', start: 1, duration: 2 }, { title: 'Ancoragens', start: 3, duration: 4 }, { title: 'Cabos', start: 7, duration: 4 }] },
    }).expect(201)).body;
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200);
    const accepted = (await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'aceita', customerOrderNumber: '4500' }).expect(200)).body;
    const id = accepted.contract.serviceOrder.id as number;
    await api().put(`/service-orders/${id}`).set(h).send({ team: [{ name: 'João da Silva', role: 'Alpinista N1' }, { name: 'Pedro Souza', role: 'Alpinista N1' }], safety: 'Trabalho em altura: cinto paraquedista e talabarte duplo' }).expect(200);
    return { company, h, id, proposal: accepted };
  }
  const iniciar = async (h: Record<string, string>, id: number, start: string) => {
    await api().patch(`/service-orders/${id}/status`).set(h).send({ status: 'agendada', plannedStart: start }).expect(200);
    await api().patch(`/service-orders/${id}/status`).set(h).send({ status: 'em_execucao', date: start }).expect(200);
  };

  it('folha sem valores por padrão; com valores só com a permissão', async () => {
    const { company, h, id } = await obra();
    const sheet = (await api().get(`/service-orders/${id}/document`).set(h).expect(200)).body;
    expect(sheet).toMatchObject({ withValues: false, values: null, canSeeValues: true, customerOrder: { number: '4500' }, order: { safety: expect.stringContaining('altura') } });
    expect(sheet.team.map((m: any) => m.name)).toEqual(['João da Silva', 'Pedro Souza']);
    expect(sheet.schedule.steps.map((s: any) => s.title)).toEqual(['Mobilização', 'Ancoragens', 'Cabos']);
    expect(sheet.systemUrl).toBe(`https://sistema.exemplo.com.br/servicos/ordens-de-servico/${id}`);
    expect(JSON.stringify(sheet)).not.toMatch(/"value"|unitValue|"cost"/);

    const priced = (await api().get(`/service-orders/${id}/document`).query({ values: 1 }).set(h).expect(200)).body;
    expect(priced.values.sections.map((s: any) => [s.title, s.items.length])).toEqual([['Mão de obra', 1], ['Materiais', 1]]);
    expect(priced.values.total).toBeGreaterThan(0);
    expect(priced.values.subtotal).toBeCloseTo(priced.values.sections.reduce((sum: number, s: any) => sum + s.total, 0), 2);

    const field = auth(company.id, ORDERS);
    expect((await api().get(`/service-orders/${id}/document`).set(field).expect(200)).body.canSeeValues).toBe(false);
    await api().get(`/service-orders/${id}/document`).query({ values: 1 }).set(field).expect(403);
  });

  it('replanejar guarda a linha de base e não tira etapa com avanço', async () => {
    const { h, id } = await obra();
    await iniciar(h, id, day(-3));
    await api().post(`/service-orders/${id}/reports`).set(h).send({ date: day(-1), progress: [{ step: 0, percent: 100 }, { step: 1, percent: 30 }] }).expect(201);
    const novo = { unit: 'dia', steps: [{ title: 'Mobilização', start: 1, duration: 2 }, { title: 'Ancoragens', start: 3, duration: 6, details: 'Chuva atrasou' }, { title: 'Cabos', start: 9, duration: 4 }] };
    const saved = (await api().put(`/service-orders/${id}`).set(h).send({ schedule: novo }).expect(200)).body;
    expect(saved.schedule.steps[1]).toMatchObject({ duration: 6, details: 'Chuva atrasou' });
    expect(saved.baseline.steps[1].duration).toBe(4);
    // replanejar de novo não troca a linha de base
    await api().put(`/service-orders/${id}`).set(h).send({ schedule: { ...novo, steps: novo.steps.map((s) => ({ ...s, duration: s.duration + 1 })) } }).expect(200);
    expect((await api().get(`/service-orders/${id}`).set(h).expect(200)).body.baseline.steps[1].duration).toBe(4);
    // a etapa 2 (Ancoragens) tem avanço: não pode sair
    await api().put(`/service-orders/${id}`).set(h).send({ schedule: { unit: 'dia', steps: [novo.steps[0]] } }).expect(400);
    await api().put(`/service-orders/${id}`).set(h).send({ schedule: { unit: 'dia', steps: [{ title: '', start: 1, duration: 1 }] } }).expect(400);
  });

  it('linha do tempo mostra os dias sem RDO, a curva e a projeção; a lista traz o avanço e o RDO de hoje', async () => {
    const { h, id } = await obra();
    await iniciar(h, id, day(-3));
    const r1 = (await api().post(`/service-orders/${id}/reports`).set(h).send({ date: day(-3), activities: 'Montagem', progress: [{ step: 0, percent: 50 }] }).expect(201)).body;
    await api().patch(`/service-reports/${r1.id}/close`).set(h).expect(200);
    await api().post(`/service-orders/${id}/reports`).set(h).send({ date: day(-1), progress: [{ step: 0, percent: 100 }, { step: 1, percent: 25 }], occurrences: [{ type: 'paralisacao', description: 'Chuva', hoursLost: 2 }] }).expect(201);

    const line = (await api().get(`/service-orders/${id}/timeline`).set(h).expect(200)).body;
    expect(line.start).toBe(day(-3));
    const state = Object.fromEntries(line.days.map((d: any) => [d.date, d.state]));
    expect([state[day(-3)], state[day(-2)], state[day(-1)], state[day(0)], state[day(1)]]).toEqual(['fechado', 'sem_rdo', 'parado', 'sem_rdo', 'futuro']);
    expect(line.steps.map((s: any) => s.percent)).toEqual([100, 25, 0]);
    expect(line.curve.find((c: any) => c.date === day(-1)).done).toBe(30);
    expect(line.projection.date).not.toBeNull();
    expect(line.replanned).toBe(false);

    const list = (await api().get('/service-orders').set(h).expect(200)).body;
    expect(list.rows[0].progress).toMatchObject({ done: 30, todayReport: 'nenhum', lastReport: day(-1) });
    expect((await api().get('/service-orders').query({ noReportToday: 1 }).set(h).expect(200)).body.total).toBe(1);
    await api().post(`/service-orders/${id}/reports`).set(h).send({ date: TODAY }).expect(201);
    expect((await api().get('/service-orders').query({ noReportToday: 1 }).set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/service-orders').set(h).expect(200)).body.rows[0].progress.todayReport).toBe('rascunho');
  });

  it('link do cliente: só ligado, sem valores, sem rascunho e sem nome completo; desligar e trocar a chave fecham o link', async () => {
    const { h, id, company } = await obra();
    await iniciar(h, id, day(-2));
    const closed = (await api().post(`/service-orders/${id}/reports`).set(h).send({ date: day(-2), activities: 'Montagem', progress: [{ step: 0, percent: 100 }], photos: [{ url: 'https://exemplo.local/f.jpg', caption: 'Área' }], occurrences: [{ type: 'quase_acidente', description: 'Ferramenta caiu', hoursLost: 0 }] }).expect(201)).body;
    await api().patch(`/service-reports/${closed.id}/close`).set(h).expect(200);
    await api().post(`/service-orders/${id}/reports`).set(h).send({ date: day(-1), activities: 'Rascunho interno' }).expect(201);

    // quem só vê a OS não liga o link
    await api().put(`/service-orders/${id}/public`).set(auth(company.id, ['list_ordens_de_servico', 'all_ordens_de_servico'])).send({ enabled: true }).expect(403);
    expect((await api().get(`/service-orders/${id}/public`).set(h).expect(200)).body).toMatchObject({ enabled: false, key: null });
    const on = (await api().put(`/service-orders/${id}/public`).set(h).send({ enabled: true }).expect(200)).body;
    expect(on).toMatchObject({ enabled: true, url: `https://sistema.exemplo.com.br/acompanhar/${on.key}`, options: { reports: true, photos: true, occurrences: false, teamNames: false } });

    const page = (await api().get(`/public/service-orders/${on.key}`).expect(200)).body;
    expect(page.order).toMatchObject({ number: expect.stringMatching(/^OS-/), notes: null });
    expect(page.team.map((m: any) => [m.name, m.role])).toEqual([[null, 'Alpinista N1'], [null, 'Alpinista N1']]);
    expect(page.reports.map((r: any) => r.activities)).toEqual(['Montagem']);
    expect(page.reports[0].photos).toHaveLength(1);
    expect(page.reports[0].occurrences).toEqual([]);
    expect(page.responsible).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/"value"|unitValue|budget|Rascunho interno/);

    await api().put(`/service-orders/${id}/public`).set(h).send({ options: { teamNames: true, occurrences: true } }).expect(200);
    const named = (await api().get(`/public/service-orders/${on.key}`).expect(200)).body;
    expect(named.team.map((m: any) => m.name)).toEqual(['João', 'Pedro']);
    expect(named.reports[0].occurrences).toHaveLength(1);

    const renewed = (await api().post(`/service-orders/${id}/public/renew`).set(h).expect(200)).body;
    expect(renewed.key).not.toBe(on.key);
    await api().get(`/public/service-orders/${on.key}`).expect(404);
    await api().get(`/public/service-orders/${renewed.key}`).expect(200);
    await api().put(`/service-orders/${id}/public`).set(h).send({ enabled: false }).expect(200);
    await api().get(`/public/service-orders/${renewed.key}`).expect(404);
    await api().get('/public/service-orders/nao-e-chave').expect(404);
  });
});
