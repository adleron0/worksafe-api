import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * RDO — entrada, saída e estatísticas.
 *
 * O que não pode quebrar: o RDO guarda a hora de entrada e de saída com o clima
 * e a condição de cada momento; quem sai antes fica registrado com o motivo; um
 * dia trabalhado só fecha com as duas horas; e tudo isso vira estatística.
 */
describe('Operação — RDO: entrada, saída e estatísticas (e2e)', () => {
  const COMMERCIAL = ['list_comercial', 'create_comercial', 'update_comercial', 'all_propostas', 'update_acompanhamento'];
  const ORDERS = ['list_ordens_de_servico', 'update_ordens_de_servico', 'all_ordens_de_servico', 'update_rdo'];
  const ALL = [...COMMERCIAL, ...ORDERS, 'view_custos_comercial', 'list_financeiro', 'create_financeiro'];
  const YEAR = new Date().getFullYear();
  const TODAY = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const day = (offset: number) => new Date(new Date(`${TODAY}T12:00:00Z`).getTime() + offset * 86400000).toISOString().slice(0, 10);
  let jwt: JwtService;
  let userId = 0;
  let cnpj = 0;

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

  async function makeCustomer(companyId: number, name = 'Indústria Alfa') {
    const db = testDb();
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    return db.customer.create({ data: {
      name, corporateName: `${name} SA`, cnpj: String(11222333000100 + ++cnpj), companyId,
      rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id,
    } });
  }

  /** Proposta de serviço enviada, com uma parcela para o fim da obra. */
  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const customer = await makeCustomer(company.id);
    const h = auth(company.id);
    const options = (await api().get('/commercial/proposals/options').set(h).expect(200)).body;
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id;
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId: customer.id, title: 'Jateamento de estrutura', description: 'Jato e pintura do tanque 3', contactName: 'Maria Souza', workDays: 22, contingencyRate: 0.05,
      sections: [
        { title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 2 }] },
        { title: 'Locações', kind: 'locacao', margin: 0.05, items: [{ type: 'locacao', description: 'Andaime tubular', quantity: 1, unitCost: 1500 }] },
      ],
      installments: [
        { percent: 0.5, dueRule: 'dias_apos_aceite', dueDays: 5, description: 'Entrada' },
        { percent: 0.5, dueRule: 'dias_apos_conclusao', dueDays: 10, description: 'Fim da obra' },
      ],
      schedule: { unit: 'dia', steps: [{ title: 'Mobilização', start: 1, duration: 2 }, { title: 'Execução', start: 3, duration: 20 }] },
    }).expect(201)).body;
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200);
    return { company, customer, h, proposal };
  }
  const aceitar = async (h: Record<string, string>, proposalId: number, extra: Record<string, unknown> = {}) =>
    (await api().patch(`/commercial/proposals/status/${proposalId}`).set(h).send({ status: 'aceita', ...extra }).expect(200)).body;
  const listar = async (h: Record<string, string>, query: Record<string, unknown> = {}) => (await api().get('/service-orders').query(query).set(h).expect(200)).body;
  const mover = (h: Record<string, string>, id: number, body: Record<string, unknown>) => api().patch(`/service-orders/${id}/status`).set(h).send(body);

  const rdo = (h: Record<string, string>, orderId: number, body: Record<string, unknown>) => api().post(`/service-orders/${orderId}/reports`).set(h).send(body);
  const fechar = (h: Record<string, string>, id: number) => api().patch(`/service-reports/${id}/close`).set(h);
  async function emExecucao() {
    const { h, proposal, company } = await cenario();
    const id = (await aceitar(h, proposal.id, { customerOrderNumber: '1' })).contract.serviceOrder.id as number;
    await mover(h, id, { status: 'agendada', plannedStart: day(-3) }).expect(200);
    await mover(h, id, { status: 'em_execucao', date: day(-3) }).expect(200);
    return { h, id, company };
  }
  const joao = { name: 'João', role: 'Alpinista N1', hours: 8, overtime: 0 };
  const pedro = { name: 'Pedro', role: 'Alpinista N1', hours: 8, overtime: 0 };

  it('guarda a entrada e a saída com clima e condição; quem sai antes fica registrado; só fecha com as duas horas', async () => {
    const { h, id } = await emExecucao();
    // de manhã: só a entrada
    const morning = (await rdo(h, id, {
      date: day(-2), startTime: '7:30', startCondition: 'restricao', startNote: 'Piso molhado na área do tanque', weather: 'nublado', crew: [joao, pedro],
    }).expect(201)).body;
    expect(morning).toMatchObject({ startTime: '07:30', endTime: null, breakMinutes: 60, weather: 'nublado', weatherEnd: null, startCondition: 'restricao', startNote: 'Piso molhado na área do tanque', hoursPerDay: 8 });
    // dia trabalhado não fecha sem a hora de saída
    expect((await fechar(h, morning.id).expect(400)).body.message).toMatch(/hora de entrada e a hora de saída/);

    // validações de horário
    const put = (body: Record<string, unknown>) => api().put(`/service-reports/${morning.id}`).set(h).send({ startTime: '07:30', crew: [joao, pedro], ...body });
    await put({ endTime: '25:00' }).expect(400);
    await put({ endTime: '07:00' }).expect(400); // saída antes da entrada
    await put({ startTime: '', endTime: '17:00' }).expect(400); // saída sem entrada
    await put({ endTime: '17:00', breakMinutes: 500 }).expect(400);
    await put({ endTime: '17:00', weatherEnd: 'neve' }).expect(400);
    await put({ endTime: '17:00', endCondition: 'xpto' }).expect(400);
    await put({ endTime: '17:00', crew: [{ ...joao, out: '06:00' }] }).expect(400); // saiu antes de entrar

    // no fim do dia: a saída, o clima e a condição; o Pedro saiu antes
    const evening = (await put({
      endTime: '17:00', weatherEnd: 'chuva', endCondition: 'normal', endNote: 'Área limpa e isolada',
      crew: [{ ...joao, in: '07:30', out: '17:00' }, { ...pedro, hours: 5, out: '13:30' }],
    }).expect(200)).body;
    expect(evening).toMatchObject({ startTime: '07:30', endTime: '17:00', weatherEnd: 'chuva', endCondition: 'normal', endNote: 'Área limpa e isolada' });
    // hora igual à do dia não fica repetida na pessoa
    expect(evening.crew).toEqual([
      { ...joao, in: null, out: null, leaveReason: null },
      { ...pedro, hours: 5, in: null, out: '13:30', leaveReason: null },
    ]);
    // saída antecipada pede o motivo para fechar
    expect((await fechar(h, morning.id).expect(400)).body.message).toMatch(/por que Pedro saiu antes/);
    await put({ endTime: '17:00', weatherEnd: 'chuva', endCondition: 'normal', crew: [joao, { ...pedro, hours: 5, out: '13:30', leaveReason: 'Consulta médica' }] }).expect(200);
    await fechar(h, morning.id).expect(200);

    // a lista do diário mostra as horas e quantos saíram antes
    const diary = (await api().get(`/service-orders/${id}/reports`).set(h).expect(200)).body;
    expect(diary.rows[0]).toMatchObject({ startTime: '07:30', endTime: '17:00', earlyLeaves: 1, people: 2, hours: 13 });

    // o modelo do dia seguinte repete a hora de entrada e o intervalo, sem a saída nem as horas próprias de ontem
    const next = (await api().get(`/service-orders/${id}/reports/template`).query({ date: day(-1) }).set(h).expect(200)).body;
    expect(next).toMatchObject({ startTime: '07:30', endTime: null, breakMinutes: 60, weatherEnd: null, startCondition: null });
    expect(next.crew).toEqual([{ ...joao, in: null, out: null, leaveReason: null }, { ...pedro, hours: 5, in: null, out: null, leaveReason: null }]);

    // turno da noite vira o dia: saída "antes" da entrada vale
    const night = (await rdo(h, id, { date: day(-1), shift: 'noite', startTime: '22:00', endTime: '05:00', crew: [{ ...joao, hours: 6 }] }).expect(201)).body;
    expect(night).toMatchObject({ startTime: '22:00', endTime: '05:00' });
    await fechar(h, night.id).expect(200);
    // dia parado continua fechando sem horário
    const stopped = (await rdo(h, id, { date: TODAY, weather: 'impraticavel', startCondition: 'impedido', notes: 'Chuva forte' }).expect(201)).body;
    await fechar(h, stopped.id).expect(200);
  });

  it('estatísticas: jornada, presenças, horas, saídas antecipadas, clima, condição e ocorrências do período', async () => {
    const { h, id, company } = await emExecucao();
    await rdo(h, id, {
      date: day(-3), startTime: '07:00', endTime: '17:00', weather: 'bom', weatherEnd: 'bom', startCondition: 'normal', endCondition: 'normal',
      crew: [joao, { ...pedro, overtime: 1 }],
    }).expect(201);
    await rdo(h, id, {
      date: day(-2), startTime: '08:00', endTime: '16:00', weather: 'nublado', weatherEnd: 'chuva', startCondition: 'restricao', endCondition: 'normal',
      crew: [joao, { ...pedro, hours: 4, out: '12:00', leaveReason: 'Consulta médica' }, { name: 'Zé', role: 'Ajudante', hours: 6, overtime: 0, out: '14:30', leaveReason: 'consulta medica' }],
      occurrences: [{ type: 'paralisacao', description: 'Chuva à tarde', hoursLost: 2 }, { type: 'pendencia_cliente', description: 'PT atrasou', hoursLost: 1 }],
    }).expect(201);
    await rdo(h, id, { date: day(-1), weather: 'impraticavel', startCondition: 'impedido' }).expect(201);
    // fora do período pedido
    await rdo(h, id, { date: TODAY, startTime: '10:00', endTime: '12:00', crew: [joao] }).expect(201);

    const stats = (await api().get('/service-reports/stats').query({ from: day(-3), to: day(-1) }).set(h).expect(200)).body;
    expect(stats).toMatchObject({ period: { from: day(-3), to: day(-1) }, orderId: null, reports: 3, drafts: 3, days: 3, orders: 1, stoppedDays: 2 });
    expect(stats.people).toEqual({ presences: 5, distinct: 3, averagePerDay: 1.67 });
    expect(stats.hours).toEqual({ normal: 34, overtime: 1, lost: 3, perPresence: 7 });
    // entrada média entre 07:00 e 08:00; saída média entre 17:00 e 16:00; jornada média de 9 h
    expect(stats.times).toEqual({ reports: 2, averageStart: '07:30', averageEnd: '16:30', averageSpan: 9, earliestStart: '07:00', latestEnd: '17:00' });
    // dois saíram antes, pelo mesmo motivo escrito de dois jeitos
    expect(stats.earlyLeaves).toEqual({ count: 2, rate: 40, reasons: [{ reason: 'Consulta médica', count: 2 }] });
    expect(stats.weather.start).toMatchObject({ bom: 1, nublado: 1, impraticavel: 1, chuva: 0 });
    expect(stats.weather.end).toMatchObject({ bom: 1, chuva: 1, sem_registro: 1 });
    expect(stats.weather.changed).toBe(1);
    expect(stats.conditions.start).toMatchObject({ normal: 1, restricao: 1, impedido: 1, sem_registro: 0 });
    expect(stats.conditions.end).toMatchObject({ normal: 2, sem_registro: 1 });
    expect(stats.occurrences).toEqual([{ type: 'paralisacao', count: 1, hoursLost: 2 }, { type: 'pendencia_cliente', count: 1, hoursLost: 1 }]);
    expect(stats.byPerson).toEqual([
      { name: 'João', role: 'Alpinista N1', days: 2, hours: 16, overtime: 0, earlyLeaves: 0 },
      { name: 'Pedro', role: 'Alpinista N1', days: 2, hours: 12, overtime: 1, earlyLeaves: 1 },
      { name: 'Zé', role: 'Ajudante', days: 1, hours: 6, overtime: 0, earlyLeaves: 1 },
    ]);
    expect(stats.byRole).toEqual([{ role: 'Alpinista N1', presences: 4, hours: 28, overtime: 1 }, { role: 'Ajudante', presences: 1, hours: 6, overtime: 0 }]);
    expect(stats.byOrder).toHaveLength(1);
    expect(stats.byOrder[0]).toMatchObject({ id, days: 3, presences: 5, hours: 34, overtime: 1, hoursLost: 3, earlyLeaves: 2 });
    expect(stats.byDay).toEqual([
      { date: day(-3), people: 2, hours: 16, overtime: 1, hoursLost: 0 },
      { date: day(-2), people: 3, hours: 18, overtime: 0, hoursLost: 3 },
      { date: day(-1), people: 0, hours: 0, overtime: 0, hoursLost: 0 },
    ]);

    // sem período: os últimos 30 dias, até hoje (entra o RDO de hoje); por obra
    const recent = (await api().get('/service-reports/stats').query({ orderId: id }).set(h).expect(200)).body;
    expect(recent).toMatchObject({ period: { to: TODAY }, orderId: id, reports: 4 });
    expect((await api().get('/service-reports/stats').query({ orderId: 999999 }).set(h).expect(200)).body.reports).toBe(0);
    await api().get('/service-reports/stats').query({ from: day(1), to: day(-1) }).set(h).expect(400);
    await api().get('/service-reports/stats').query({ from: 'ontem' }).set(h).expect(400);

    // permissão, "só as minhas" e isolamento
    await api().get('/service-reports/stats').set(auth(company.id, ['list_comercial'])).expect(403);
    const field = await makeSeller(company.id);
    const f = { Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: field.id, companyId: company.id, permissions: ['list_ordens_de_servico'], profile: 'user' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
    expect((await api().get('/service-reports/stats').set(f).expect(200)).body.reports).toBe(0);
    const other = await makeCompany();
    expect((await api().get('/service-reports/stats').set(auth(other.id)).expect(200)).body.reports).toBe(0);
  });
});
