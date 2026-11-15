import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { brasiliaNow } from 'src/features/commercial/activity.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Comercial — acompanhamento (contatos com o cliente e retornos marcados).
 *
 * O que não pode quebrar: um contato registrado fica na história da proposta;
 * um retorno marcado aparece como pendente (e atrasado quando o dia passa);
 * concluir marca o próximo no mesmo passo; a lista de propostas mostra o
 * próximo retorno; e nada vaza de uma empresa para outra.
 */
describe('Comercial — acompanhamento (e2e)', () => {
  const ALL = ['list_comercial', 'create_comercial', 'update_comercial', 'all_propostas', 'update_acompanhamento'];
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
  const day = (offset: number) => new Date(new Date(`${brasiliaNow().date}T12:00:00Z`).getTime() + offset * 86400000).toISOString().slice(0, 10);

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

  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const customer = await makeCustomer(company.id);
    const h = auth(company.id);
    const options = (await api().get('/commercial/proposals/options').set(h).expect(200)).body;
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id as number;
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId: customer.id, title: 'Pintura de tanque', workDays: 22,
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 1 }] }],
      installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 28 }],
    }).expect(201)).body;
    return { company, customer, proposal, h };
  }
  const listar = async (h: Record<string, string>, query: Record<string, unknown> = {}) => (await api().get('/commercial/activities').query(query).set(h).expect(200)).body;

  it('registra um contato já feito e marca o retorno no mesmo passo', async () => {
    const { proposal, customer, h } = await cenario();
    const call = (await api().post('/commercial/activities').set(h).send({
      proposalId: proposal.id, type: 'ligacao', subject: 'Apresentei a proposta', notes: 'Falou com o comprador', contactName: 'Marta',
      done: true, result: 'Vai levar para a diretoria', next: { dueDate: day(3), dueTime: '14:30', type: 'whatsapp', subject: 'Cobrar retorno da diretoria' },
    }).expect(201)).body;
    expect(call).toMatchObject({ type: 'ligacao', typeLabel: 'Ligação', status: 'feita', overdue: false, result: 'Vai levar para a diretoria', contactName: 'Marta', userId });
    expect(call.customer).toMatchObject({ id: customer.id });
    expect(call.proposal).toMatchObject({ id: proposal.id, number: proposal.number });

    const list = await listar(h, { proposalId: proposal.id });
    expect(list.total).toBe(2);
    // o que está marcado vem antes do que já foi feito
    expect(list.rows.map((row: any) => [row.status, row.type, row.subject])).toEqual([
      ['pendente', 'whatsapp', 'Cobrar retorno da diretoria'], ['feita', 'ligacao', 'Apresentei a proposta'],
    ]);
    expect(list.rows[0]).toMatchObject({ dueDate: day(3), dueTime: '14:30', overdue: false, today: false, contactName: 'Marta', userId });
    expect(list.summary).toEqual({ overdue: 0, today: 0, upcoming: 1, done: 1 });
  });

  it('retorno marcado: atrasa quando o dia passa, conclui com o próximo passo e não conclui duas vezes', async () => {
    const { proposal, h } = await cenario();
    const marcar = async (dueDate: string, subject: string) =>
      (await api().post('/commercial/activities').set(h).send({ proposalId: proposal.id, type: 'ligacao', subject, dueDate }).expect(201)).body;
    const late = await marcar(day(-2), 'Ligar para o comprador');
    const now = await marcar(day(0), 'Mandar a planilha');
    await marcar(day(5), 'Visita técnica');
    expect(late).toMatchObject({ status: 'pendente', overdue: true, today: false });
    expect(now).toMatchObject({ status: 'pendente', today: true });

    expect((await listar(h)).summary).toEqual({ overdue: 1, today: 1, upcoming: 1, done: 0 });
    expect((await listar(h, { status: 'atrasadas' })).rows.map((row: any) => row.subject)).toEqual(['Ligar para o comprador']);
    expect((await listar(h, { status: 'hoje' })).rows.map((row: any) => row.subject)).toEqual(['Mandar a planilha']);
    expect((await listar(h, { status: 'proximas' })).rows.map((row: any) => row.subject)).toEqual(['Visita técnica']);
    // da mais antiga para a mais distante
    expect((await listar(h, { status: 'pendentes' })).rows.map((row: any) => row.subject)).toEqual(['Ligar para o comprador', 'Mandar a planilha', 'Visita técnica']);

    const done = (await api().patch(`/commercial/activities/${late.id}/done`).set(h)
      .send({ result: 'Pediu desconto', next: { dueDate: day(1), subject: 'Responder sobre o desconto' } }).expect(200)).body;
    expect(done).toMatchObject({ status: 'feita', overdue: false, result: 'Pediu desconto' });
    await api().patch(`/commercial/activities/${late.id}/done`).set(h).send({ next: { dueDate: day(1) } }).expect(409);
    const after = await listar(h);
    expect(after.summary).toEqual({ overdue: 0, today: 1, upcoming: 2, done: 1 });
    expect(after.rows.filter((row: any) => row.subject === 'Responder sobre o desconto')).toHaveLength(1);

    // reabrir o que foi concluído por engano; cancelar o que não vai acontecer
    expect((await api().patch(`/commercial/activities/${late.id}/reopen`).set(h).expect(200)).body).toMatchObject({ status: 'pendente', overdue: true, result: null });
    await api().delete(`/commercial/activities/${now.id}`).set(h).expect(200);
    expect((await listar(h)).summary).toEqual({ overdue: 1, today: 0, upcoming: 2, done: 0 });
    // editar muda a data do que está marcado
    expect((await api().put(`/commercial/activities/${late.id}`).set(h).send({ dueDate: day(2), dueTime: '09:00', subject: 'Ligar de novo' }).expect(200)).body)
      .toMatchObject({ dueDate: day(2), dueTime: '09:00', subject: 'Ligar de novo', overdue: false });
  });

  it('a lista de propostas mostra o próximo retorno, e a revisão continua a mesma conversa', async () => {
    const { proposal, h } = await cenario();
    await api().post('/commercial/activities').set(h).send({ proposalId: proposal.id, type: 'reuniao', subject: 'Reunião de alinhamento', dueDate: day(4) }).expect(201);
    await api().post('/commercial/activities').set(h).send({ proposalId: proposal.id, type: 'ligacao', subject: 'Ligar antes', dueDate: day(-1) }).expect(201);
    await api().post('/commercial/activities').set(h).send({ proposalId: proposal.id, type: 'email', subject: 'Mandei o orçamento', done: true }).expect(201);

    const rows = (await api().get('/commercial/proposals').set(h).expect(200)).body.rows;
    expect(rows[0].followUp).toMatchObject({ pending: 2, next: { subject: 'Ligar antes', dueDate: day(-1), overdue: true, today: false } });
    expect(rows[0].followUp.lastAt).toBeTruthy();

    // a revisão herda o acompanhamento da versão anterior
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200);
    const revision = (await api().post(`/commercial/proposals/${proposal.id}/revise`).set(h).expect(201)).body;
    expect((await listar(h, { proposalId: revision.id })).total).toBe(3);
    const revised = (await api().get('/commercial/proposals').set(h).expect(200)).body.rows.find((row: any) => row.id === revision.id);
    expect(revised.followUp).toMatchObject({ pending: 2, next: { subject: 'Ligar antes' } });

    // proposta sem acompanhamento vem vazia, não quebra
    const { proposal: other, h: h2 } = await cenario();
    const lone = (await api().get('/commercial/proposals').set(h2).expect(200)).body.rows.find((row: any) => row.id === other.id);
    expect(lone.followUp).toEqual({ next: null, pending: 0, lastAt: null });
  });

  it('contato só com o cliente, sem proposta; e o que é recusado', async () => {
    const { customer, proposal, h } = await cenario();
    const note = (await api().post('/commercial/activities').set(h).send({ customerId: customer.id, type: 'visita', dueDate: day(7) }).expect(201)).body;
    // sem assunto, vale o nome do tipo
    expect(note).toMatchObject({ subject: 'Visita', proposal: null, status: 'pendente' });
    expect((await listar(h, { customerId: customer.id })).total).toBe(1);
    expect((await listar(h, { proposalId: proposal.id })).total).toBe(0);

    const post = (body: Record<string, unknown>) => api().post('/commercial/activities').set(h).send(body);
    await post({ customerId: customer.id, type: 'telegrama', dueDate: day(1) }).expect(400);
    await post({ customerId: customer.id, type: 'ligacao' }).expect(400); // nem feito nem marcado
    await post({ customerId: customer.id, type: 'ligacao', dueDate: '2026-02-31x' }).expect(400);
    await post({ customerId: customer.id, type: 'ligacao', dueDate: day(1), dueTime: '25:00' }).expect(400);
    await post({ customerId: customer.id, type: 'ligacao', done: true, doneDate: day(2) }).expect(400); // contato no futuro
    await post({ customerId: 999999, type: 'ligacao', dueDate: day(1) }).expect(400);
    await post({ proposalId: 999999, type: 'ligacao', dueDate: day(1) }).expect(404);
    // contato de outro dia fica registrado naquele dia
    const old = (await post({ customerId: customer.id, type: 'ligacao', done: true, doneDate: day(-3) }).expect(201)).body;
    expect(brasiliaNow(new Date(old.doneAt)).date).toBe(day(-3));
  });

  it('não vaza entre empresas e respeita a permissão', async () => {
    const { company, proposal, customer, h } = await cenario();
    const mine = (await api().post('/commercial/activities').set(h).send({ proposalId: proposal.id, type: 'ligacao', dueDate: day(1) }).expect(201)).body;

    const other = await makeCompany();
    const otherUser = await makeSeller(other.id);
    const mineUser = userId;
    userId = otherUser.id;
    const ho = auth(other.id);
    expect((await listar(ho)).total).toBe(0);
    expect((await listar(ho, { proposalId: proposal.id })).total).toBe(0);
    await api().put(`/commercial/activities/${mine.id}`).set(ho).send({ subject: 'Invasão' }).expect(404);
    await api().patch(`/commercial/activities/${mine.id}/done`).set(ho).send({}).expect(404);
    await api().delete(`/commercial/activities/${mine.id}`).set(ho).expect(404);
    await api().post('/commercial/activities').set(ho).send({ proposalId: proposal.id, type: 'ligacao', dueDate: day(1) }).expect(404);
    await api().post('/commercial/activities').set(ho).send({ customerId: customer.id, type: 'ligacao', dueDate: day(1) }).expect(400);

    userId = mineUser;
    // responsável de outra empresa não entra
    await api().post('/commercial/activities').set(h).send({ proposalId: proposal.id, type: 'ligacao', dueDate: day(1), userId: otherUser.id }).expect(400);
    // quem só lista não escreve
    const reader = auth(company.id, ['list_comercial', 'all_propostas']);
    expect((await listar(reader)).total).toBe(1);
    await api().post('/commercial/activities').set(reader).send({ proposalId: proposal.id, type: 'ligacao', dueDate: day(1) }).expect(403);
    await api().delete(`/commercial/activities/${mine.id}`).set(reader).expect(403);
  });
});
