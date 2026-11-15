import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Locais da empresa (CTs, bases) e pontos no mapa: cadastro de locais, ponto do
 * cliente pelo endereço (serviço externo simulado) ou à mão, ponto da OS e o
 * local de uma atividade.
 */
describe('Locais e pontos no mapa (e2e)', () => {
  const VIEW = ['view_locais'];
  const WRITE = ['view_locais', 'update_locais'];
  const GEOCODER = 'https://geocoder.teste.local';
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });
  afterEach(() => { nock.cleanAll(); process.env.GEOCODER_DISABLED = 'true'; delete process.env.GEOCODER_URL; });

  const auth = (companyId: number, permissions: string[] = WRITE) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());
  /** Liga o conversor de endereço apontando para um serviço simulado. */
  const geocoder = () => { process.env.GEOCODER_DISABLED = 'false'; process.env.GEOCODER_URL = GEOCODER; return nock(GEOCODER); };

  let cnpj = 0;
  async function makeCustomer(companyId: number, name: string, extra: Record<string, any> = {}) {
    const db = testDb();
    const rank = (await db.dOM_Ranks.findFirst()) ?? (await db.dOM_Ranks.create({ data: { name: 'Bronze', companyId } }));
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Ipojuca', stateId: state.id } }));
    return db.customer.create({ data: {
      name, corporateName: `${name} SA`, cnpj: String(11222333000100 + ++cnpj), companyId, rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id,
      street: 'Rodovia PE-60', number: 1200, neighborhood: 'Suape', ...extra,
    } });
  }
  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    return { company, db: testDb() };
  }

  it('cadastra CT e base temporária, com ponto e período', async () => {
    const { company } = await cenario();
    const ct = (await api().post('/places').set(auth(company.id)).send({ name: 'CT Recife', kind: 'ct', street: 'Rua do CT', number: '100', city: 'Recife', state: 'pe', latitude: -8.05428, longitude: -34.8813 }).expect(201)).body;
    expect(ct).toMatchObject({ name: 'CT Recife', kindName: 'Centro de treinamento', state: 'PE', latitude: -8.05428, longitude: -34.8813, current: true, address: 'Rua do CT, 100 · Recife/PE' });
    const base = (await api().post('/places').set(auth(company.id)).send({ name: 'Base Salvador', kind: 'base', city: 'Salvador', state: 'BA', startDate: '2020-01-01', endDate: '2020-03-01' }).expect(201)).body;
    expect(base).toMatchObject({ kind: 'base', current: false, latitude: null }); // já encerrou
    await api().post('/places').set(auth(company.id)).send({ name: 'X' }).expect(400);
    await api().post('/places').set(auth(company.id)).send({ name: 'Local', kind: 'galpao' }).expect(400);
    await api().post('/places').set(auth(company.id)).send({ name: 'Local', latitude: 95, longitude: 10 }).expect(400);
    await api().post('/places').set(auth(company.id)).send({ name: 'Local', startDate: '2026-05-01', endDate: '2026-04-01' }).expect(400);
    await api().post('/places').set(auth(company.id)).send({ name: 'Local' }).set(auth(company.id, VIEW)).expect(403);
    // arrastar o ponto e encerrar a base
    const moved = (await api().put(`/places/${ct.id}`).set(auth(company.id)).send({ latitude: -8.06, longitude: -34.9 }).expect(200)).body;
    expect(moved).toMatchObject({ latitude: -8.06, longitude: -34.9, name: 'CT Recife' });
    await api().patch(`/places/${base.id}/inactive`).set(auth(company.id)).expect(200);
    const list = (await api().get('/places').set(auth(company.id, VIEW)).expect(200)).body;
    expect(list.rows.map((row: any) => row.name)).toEqual(['CT Recife']);
    expect(list.kinds.map((kind: any) => kind.id)).toEqual(['ct', 'base', 'sede', 'outro']);
    const other = await makeCompany();
    await api().put(`/places/${ct.id}`).set(auth(other.id)).send({ name: 'Invasor' }).expect(404);
  });

  it('ponto do cliente: pelo endereço (rua, ou só a cidade) e ajustado à mão', async () => {
    const { company, db } = await cenario();
    const alfa = await makeCustomer(company.id, 'Indústria Alfa');
    const beta = await makeCustomer(company.id, 'Indústria Beta', { street: 'Estrada sem nome' });
    const before = (await api().get('/places/customers').set(auth(company.id, VIEW)).expect(200)).body;
    expect(before).toMatchObject({ total: 2, missing: 2 });
    expect(before.rows[0]).toMatchObject({ name: 'Indústria Alfa', address: 'Rodovia PE-60, 1200 · Suape · Ipojuca/PE', source: null });

    // desligado (como na suíte): não acha nada e não grava
    expect((await api().post(`/places/customers/${alfa.id}/locate`).set(auth(company.id)).expect(200)).body.found).toBe(false);

    const service = geocoder();
    // só o endereço vai para o serviço: nada de nome do cliente
    service.get('/search').query((query) => query.street === '1200 Rodovia PE-60' && query.city === 'Ipojuca' && query.state === 'PE' && !JSON.stringify(query).includes('Alfa'))
      .reply(200, [{ lat: '-8.3936', lon: '-34.9742', display_name: 'Rodovia PE-60, Suape, Ipojuca' }]);
    const located = (await api().post(`/places/customers/${alfa.id}/locate`).set(auth(company.id)).expect(200)).body;
    expect(located).toMatchObject({ found: true, precise: true, customer: { latitude: -8.3936, longitude: -34.9742, source: 'endereco' } });

    // rua não encontrada: cai no centro da cidade, marcado como aproximado
    service.get('/search').query((query) => query.street === '1200 Estrada sem nome').reply(200, []);
    service.get('/search').query((query) => !query.street && query.city === 'Ipojuca').reply(200, [{ lat: '-8.4', lon: '-35.06', display_name: 'Ipojuca' }]);
    const batch = (await api().post('/places/customers/locate-missing').set(auth(company.id)).send({}).expect(200)).body;
    expect(batch).toMatchObject({ located: 1, failed: [], remaining: 0 });
    const approx = await db.customer.findUnique({ where: { id: beta.id } });
    expect([approx.latitude, approx.longitude]).toEqual([-8.4, -35.06]);

    // ajuste à mão: o ponto passa a ser manual
    const manual = (await api().put(`/places/customers/${beta.id}/point`).set(auth(company.id)).send({ latitude: -8.41, longitude: -35.01 }).expect(200)).body;
    expect(manual).toMatchObject({ latitude: -8.41, longitude: -35.01, source: 'manual' });
    await api().put(`/places/customers/${beta.id}/point`).set(auth(company.id)).send({ latitude: 'x', longitude: 1 }).expect(400);
    await api().put(`/places/customers/${beta.id}/point`).set(auth(company.id, VIEW)).send({ latitude: 1, longitude: 1 }).expect(403);
    expect((await api().get('/places/customers?missing=true').set(auth(company.id, VIEW)).expect(200)).body.rows).toEqual([]);

    // endereço → ponto sem gravar (para o cadastro de locais)
    service.get('/search').query((query) => query.city === 'Recife').reply(200, [{ lat: '-8.05', lon: '-34.88', display_name: 'Recife' }]);
    expect((await api().post('/places/geocode').set(auth(company.id)).send({ city: 'Recife', state: 'PE' }).expect(200)).body).toMatchObject({ found: true, precise: false, latitude: -8.05, longitude: -34.88 });
    await api().post('/places/geocode').set(auth(company.id)).send({ street: 'Rua sem cidade' }).expect(400);
  });

  it('ponto da OS: o do cliente por padrão, o do local da empresa ou um ponto próprio; e o local na atividade', async () => {
    const { company, db } = await cenario();
    const customer = await makeCustomer(company.id, 'Indústria Alfa', { latitude: -8.39, longitude: -34.97 });
    const place = (await api().post('/places').set(auth(company.id)).send({ name: 'Base Suape', kind: 'base', latitude: -8.36, longitude: -34.95 }).expect(201)).body;
    const order = await db.service_Order.create({ data: {
      companyId: company.id, number: 'OS-2026-0001', year: 2026, sequence: 1, contractId: 9001, proposalId: 9001, customerId: customer.id, title: 'Montagem', status: 'agendada', scope: [], checklist: [],
    } });
    const OS = ['list_ordens_de_servico', 'view_ordens_de_servico', 'update_ordens_de_servico', 'all_ordens_de_servico'];
    const get = async () => (await api().get(`/service-orders/${order.id}`).set(auth(company.id, OS)).expect(200)).body.point;
    const put = (body: Record<string, any>) => api().put(`/service-orders/${order.id}`).set(auth(company.id, OS)).send(body);
    expect(await get()).toMatchObject({ latitude: -8.39, longitude: -34.97, source: 'cliente', own: null, place: null });
    await put({ placeId: place.id }).expect(200);
    expect(await get()).toMatchObject({ latitude: -8.36, longitude: -34.95, source: 'local', place: { name: 'Base Suape' } });
    await put({ latitude: -8.1234567, longitude: -34.9 }).expect(200);
    expect(await get()).toMatchObject({ latitude: -8.123457, longitude: -34.9, source: 'obra' });
    await put({ latitude: 200, longitude: 0 }).expect(400);
    await put({ placeId: 999999 }).expect(400);
    await put({ latitude: null, longitude: null, placeId: null }).expect(200);
    expect((await get()).source).toBe('cliente');

    // atividade num local da empresa: sem texto digitado, o "onde" é o nome do local
    const employee = await db.hr_Employee.create({ data: { companyId: company.id, name: 'José da Silva' } });
    const types = (await api().get('/hr-activities/types').set(auth(company.id, ['view_alocacao'])).expect(200)).body.rows;
    const activity = (await api().post('/hr-activities').set(auth(company.id, ['view_alocacao', 'update_alocacao'])).send({ typeId: types[0].id, employeeIds: [employee.id], startDate: '2026-11-20', placeId: place.id }).expect(201)).body;
    expect(activity).toMatchObject({ placeId: place.id, location: 'Base Suape' });
    await api().post('/hr-activities').set(auth(company.id, ['view_alocacao', 'update_alocacao'])).send({ typeId: types[0].id, employeeIds: [employee.id], startDate: '2026-11-20', placeId: 999999 }).expect(400);
  });
});
