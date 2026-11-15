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
  it('visão em mapa: quem está em cada ponto no dia, quem está livre, indisponível e o que não tem ponto', async () => {
    const { company, db } = await cenario();
    const today = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const day = (offset: number) => new Date(Date.now() - 3 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);
    const date = (offset: number) => new Date(`${day(offset)}T00:00:00.000Z`);
    const alfa = await makeCustomer(company.id, 'Indústria Alfa', { latitude: -8.39, longitude: -34.97 });
    const beta = await makeCustomer(company.id, 'Indústria Beta', { latitude: -8.05, longitude: -34.9 }); // com ponto, sem ninguém hoje
    const semPonto = await makeCustomer(company.id, 'Indústria Sem Ponto');
    const ct = (await api().post('/places').set(auth(company.id)).send({ name: 'CT Recife', kind: 'ct', latitude: -8.06, longitude: -34.87 }).expect(201)).body;
    await api().post('/places').set(auth(company.id)).send({ name: 'Base antiga', kind: 'base', latitude: -12.7, longitude: -38.3, startDate: '2020-01-01', endDate: '2020-02-01' }).expect(201);
    const role = await db.commercial_Professional.create({ data: { companyId: company.id, name: 'Alpinista N2', salary: 4200 } });
    const person = async (name: string, extra: Record<string, any> = {}) => db.hr_Employee.create({ data: { companyId: company.id, name, roles: { create: [{ professionalId: role.id, isPrimary: true }] }, ...extra } });
    const [jose, ana, bruno, carla, diego, eva] = await Promise.all(['José', 'Ana', 'Bruno', 'Carla', 'Diego', 'Eva'].map((name) => person(name)));
    const os = (number: number, customerId: number, team: any[], extra: Record<string, any> = {}) => db.service_Order.create({ data: {
      companyId: company.id, number: `OS-2026-000${number}`, year: 2026, sequence: number, contractId: 9000 + number, proposalId: 9000 + number, customerId, title: `Obra ${number}`, status: 'em_execucao',
      scope: [], checklist: [], plannedStart: date(-2), startedAt: date(-2), plannedEnd: date(5), team, ...extra,
    } });
    // duas obras no mesmo cliente (mesmo ponto), uma com ponto próprio, uma sem ponto nenhum
    const a = await os(1, alfa.id, [{ name: 'José', role: 'Alpinista N2', employeeId: jose.id, shift: 'manha' }]);
    await os(2, alfa.id, [{ name: 'Ana', role: 'Alpinista N2', employeeId: ana.id }]);
    await os(3, alfa.id, [{ name: 'Bruno', role: 'Alpinista N2', employeeId: bruno.id }], { latitude: -7.5, longitude: -35.5 });
    await os(4, semPonto.id, [{ name: 'Carla', role: 'Alpinista N2', employeeId: carla.id }]);
    // o José, à tarde, numa atividade no CT; a Eva de férias; o Diego livre
    const WRITE_ALL = ['view_alocacao', 'update_alocacao'];
    const types = (await api().get('/hr-activities/types').set(auth(company.id, WRITE_ALL)).expect(200)).body.rows;
    await api().post('/hr-activities').set(auth(company.id, WRITE_ALL)).send({ typeId: types[0].id, employeeIds: [jose.id], startDate: today, shift: 'tarde', placeId: ct.id }).expect(201);
    await db.hr_EmployeeEvent.create({ data: { companyId: company.id, employeeId: eva.id, type: 'ferias', startDate: date(-1), endDate: date(3) } });

    const map = (await api().get('/employees/allocation/map').set(auth(company.id, ['view_alocacao'])).expect(200)).body;
    expect(map.date).toBe(today);
    const site = (name: string) => map.sites.find((item: any) => item.name === name);
    // as duas obras do mesmo cliente ficam num ponto só, cada uma no seu grupo
    expect(site('Indústria Alfa')).toMatchObject({ kind: 'obra', latitude: -8.39, longitude: -34.97, people: 2 });
    expect(site('Indústria Alfa').groups.map((group: any) => [group.label, group.people.map((item: any) => `${item.name} (${item.shiftName})`)]).sort()).toEqual([['OS-2026-0001', ['José (Manhã)']], ['OS-2026-0002', ['Ana (Dia inteiro)']]]);
    expect(site('Indústria Alfa').groups[0].link).toBe(`/servicos/ordens-de-servico/${a.id}`);
    // a obra com ponto próprio aparece no ponto dela
    expect(map.sites.find((item: any) => item.latitude === -7.5)).toMatchObject({ kind: 'obra', people: 1 });
    // o CT aparece com quem está lá; a base encerrada não aparece
    expect(site('CT Recife')).toMatchObject({ kind: 'local', placeKind: 'ct', people: 1 });
    expect(site('CT Recife').groups[0].people[0]).toMatchObject({ name: 'José', shiftName: 'Tarde' });
    expect(site('Base antiga')).toBeUndefined();
    // obra de cliente sem ponto fica à parte
    expect(map.noPoint.map((group: any) => [group.label, group.people.map((item: any) => item.name)])).toEqual([['OS-2026-0004', ['Carla']]]);
    expect(map.free.map((item: any) => item.name)).toEqual(['Diego']);
    expect(map.unavailable.map((item: any) => [item.name, item.label])).toEqual([['Eva', 'Férias']]);
    // clientes com ponto e sem ninguém hoje, para a tela mostrar discretos
    expect(map.customers.map((item: any) => item.name)).toEqual(['Indústria Beta']);
    expect(map.roles).toEqual([{ id: role.id, name: 'Alpinista N2' }]);
    // outro dia: ninguém nas obras (começaram há dois dias), todos livres menos a Eva... que já voltou
    const later = (await api().get(`/employees/allocation/map?date=${day(10)}`).set(auth(company.id, ['view_alocacao'])).expect(200)).body;
    expect(later.free).toHaveLength(6);
    expect(later.sites.map((item: any) => item.name)).toEqual(['CT Recife']);
    await api().get('/employees/allocation/map').set(auth(company.id, ['list_funcionarios'])).expect(403);
    await api().get('/employees/allocation/map?date=ontem').set(auth(company.id, ['view_alocacao'])).expect(400);
    expect(beta.id).toBeGreaterThan(0);
  });
});
