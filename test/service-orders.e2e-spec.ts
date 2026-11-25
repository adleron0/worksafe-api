import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Operação — ordem de serviço.
 *
 * O que não pode quebrar: a OS nasce sozinha do aceite de uma proposta de
 * serviço, com o escopo sem preço; espera o pedido do cliente; anda uma etapa
 * por vez, pedindo o que cada passagem exige; e concluir libera o faturamento
 * das parcelas "após a conclusão". Custos só para quem tem a permissão.
 */
describe('Operação — ordem de serviço (e2e)', () => {
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

  it('nasce do aceite com o escopo sem preço; espera o pedido do cliente e segue quando ele chega', async () => {
    const { h, proposal, company } = await cenario();
    const accepted = await aceitar(h, proposal.id);
    expect(accepted.contract.serviceOrder).toMatchObject({ number: `OS-${YEAR}-0001`, status: 'a_liberar' });

    const list = await listar(h);
    expect(list).toMatchObject({ total: 1, summary: { a_liberar: 1 } });
    expect(list.rows[0]).toMatchObject({ number: `OS-${YEAR}-0001`, status: 'a_liberar', title: 'Jateamento de estrutura', customer: { name: 'Indústria Alfa' }, customerOrderNumber: null, checklist: { done: 0, total: 5 }, late: false });
    expect(list.rows[0].proposal.number).toBe(proposal.number);

    const order = (await api().get(`/service-orders/${list.rows[0].id}`).set(h).expect(200)).body;
    expect(order).toMatchObject({ statusLabel: 'A liberar', nextStatuses: ['a_mobilizar', 'cancelada'], description: 'Jato e pintura do tanque 3', contactName: 'Maria Souza', canSeeCosts: true });
    // escopo: o que foi vendido, com quantidade e sem valor
    expect(order.scope.map((section: any) => [section.title, section.items.length])).toEqual([['Mão de obra', 1], ['Locações', 1]]);
    expect(order.scope[0].items[0]).toMatchObject({ type: 'mao_de_obra', description: 'Alpinista N1', quantity: 2, workDays: 22 });
    expect(JSON.stringify(order.scope)).not.toMatch(/cost|value|margin/i);
    expect(order.schedule.steps).toHaveLength(2);
    // custo orçado por grupo e a receita da proposta
    expect(order.budget.revenue).toBe(accepted.calc.totals.total);
    expect(order.budget.groups.map((group: any) => group.label)).toEqual(['Mão de obra', 'Locações']);
    expect(order.events.map((event: any) => [event.type, event.to])).toEqual([['criada', 'a_liberar']]);

    // sem a permissão de custos, nada de orçamento
    const field = (await api().get(`/service-orders/${order.id}`).set(auth(company.id, ORDERS)).expect(200)).body;
    expect(field).toMatchObject({ canSeeCosts: false, budget: null });

    // o pedido do cliente chega: a OS segue sozinha para a mobilização
    await api().put(`/commercial/contracts/${accepted.contract.id}/customer-order`).set(h).send({ number: 'PO-4500' }).expect(200);
    const released = (await api().get(`/service-orders/${order.id}`).set(h).expect(200)).body;
    expect(released).toMatchObject({ status: 'a_mobilizar', customerOrder: { number: 'PO-4500' } });
    expect(released.events[1]).toMatchObject({ type: 'liberada', from: 'a_liberar', to: 'a_mobilizar', note: 'Pedido do cliente PO-4500 informado' });
    // informar de novo não anda outra etapa
    await api().put(`/commercial/contracts/${accepted.contract.id}/customer-order`).set(h).send({ number: 'PO-4501' }).expect(200);
    expect((await api().get(`/service-orders/${order.id}`).set(h).expect(200)).body.events).toHaveLength(2);
  });

  it('aceite já com o pedido do cliente nasce em "A mobilizar"; abrir o quadro não duplica', async () => {
    const { h, proposal } = await cenario();
    const accepted = await aceitar(h, proposal.id, { customerOrderNumber: '4500123' });
    expect(accepted.contract.serviceOrder).toMatchObject({ status: 'a_mobilizar' });
    await listar(h);
    expect((await listar(h)).total).toBe(1);
    expect(await testDb().service_Order.count()).toBe(1);
  });

  it('anda uma etapa por vez, pedindo o que cada passagem exige; concluir libera o faturamento', async () => {
    const { h, proposal } = await cenario();
    const accepted = await aceitar(h, proposal.id, { customerOrderNumber: '4500123' });
    const id = accepted.contract.serviceOrder.id as number;
    const fila = async () => (await api().get('/commercial/contracts/billing').set(h).expect(200)).body.rows.map((row: any) => [row.description, row.stage]);
    expect(await fila()).toEqual([['Entrada', 'liberada'], ['Fim da obra', 'aguardando']]);

    // não pula etapa; agendar pede a data
    await mover(h, id, { status: 'em_execucao' }).expect(409);
    await mover(h, id, { status: 'agendada' }).expect(400);
    await mover(h, id, { status: 'agendada', plannedStart: day(5), plannedEnd: day(2) }).expect(400);
    expect((await mover(h, id, { status: 'agendada', plannedStart: day(-3), plannedEnd: day(20) }).expect(200)).body)
      .toMatchObject({ status: 'agendada', plannedStart: day(-3), plannedEnd: day(20), late: true });

    // iniciar e concluir registram a data real
    await mover(h, id, { status: 'em_execucao', date: day(2) }).expect(400); // futuro
    expect((await mover(h, id, { status: 'em_execucao', date: day(-2) }).expect(200)).body).toMatchObject({ status: 'em_execucao', startedAt: day(-2), late: false });
    await mover(h, id, { status: 'concluida', date: day(-5) }).expect(400); // antes do início
    const done = (await mover(h, id, { status: 'concluida', date: TODAY, conclusionNotes: 'Entregue sem pendências' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'concluida', finishedAt: TODAY, conclusionNotes: 'Entregue sem pendências', nextStatuses: ['encerrada', 'em_execucao'] });
    expect(done.events.map((event: any) => event.to)).toEqual(['a_mobilizar', 'agendada', 'em_execucao', 'concluida']);

    // a parcela do fim da obra está liberada e a venda guarda as datas reais
    expect(await fila()).toEqual([['Entrada', 'liberada'], ['Fim da obra', 'liberada']]);
    const contract = (await api().get(`/commercial/contracts/${accepted.contract.id}`).set(h).expect(200)).body;
    expect(contract).toMatchObject({ startDate: day(-2), endDate: TODAY, serviceOrder: { status: 'concluida' } });

    // reabrir segura o faturamento de novo; voltar a iniciar apaga a data de início
    expect((await mover(h, id, { status: 'em_execucao' }).expect(200)).body).toMatchObject({ status: 'em_execucao', finishedAt: null });
    expect(await fila()).toEqual([['Entrada', 'liberada'], ['Fim da obra', 'aguardando']]);
    expect((await mover(h, id, { status: 'agendada' }).expect(200)).body).toMatchObject({ status: 'agendada', startedAt: null });

    // cancelar pede o motivo; cancelada sai do quadro e pode voltar
    await mover(h, id, { status: 'cancelada' }).expect(400);
    await mover(h, id, { status: 'cancelada', note: 'Cliente adiou a obra' }).expect(200);
    expect(await listar(h)).toMatchObject({ total: 0, summary: { cancelada: 1 } });
    expect((await listar(h, { status: 'cancelada' })).total).toBe(1);
    await api().put(`/service-orders/${id}`).set(h).send({ notes: 'x' }).expect(409);
    expect((await mover(h, id, { status: 'a_mobilizar' }).expect(200)).body.status).toBe('a_mobilizar');
    await mover(h, id, { status: 'inexistente' }).expect(400);
  });

  it('mobilização: conferência com quem marcou, equipe, responsável e datas', async () => {
    const { h, proposal, company } = await cenario();
    const id = (await aceitar(h, proposal.id, { customerOrderNumber: '1' })).contract.serviceOrder.id as number;
    const order = (await api().get(`/service-orders/${id}`).set(h).expect(200)).body;
    const put = (body: Record<string, unknown>) => api().put(`/service-orders/${id}`).set(h).send(body);

    const checklist = [...order.checklist.map((item: any, index: number) => ({ ...item, done: index === 0 })), { title: 'Integração de segurança agendada', done: false }];
    const saved = (await put({ checklist, team: [{ name: 'João', role: 'Alpinista N1' }, { name: '', role: 'sem nome' }], responsibleUserId: userId, plannedStart: day(3), plannedEnd: day(25), location: 'Planta de Suape', notes: 'Levar EPI extra' }).expect(200)).body;
    expect(saved.checklist).toHaveLength(6);
    expect(saved.checklist[0]).toMatchObject({ done: true, doneBy: 'Vendedor Teste' });
    expect(saved.checklist[0].doneAt).toBeTruthy();
    expect(saved.checklist[5]).toMatchObject({ title: 'Integração de segurança agendada', done: false, doneAt: null });
    expect(saved).toMatchObject({ team: [{ name: 'João', role: 'Alpinista N1' }], responsible: { id: userId }, plannedStart: day(3), plannedEnd: day(25), location: 'Planta de Suape', notes: 'Levar EPI extra' });
    expect((await listar(h)).rows[0]).toMatchObject({ checklist: { done: 1, total: 6 }, responsible: 'Vendedor Teste', plannedStart: day(3) });

    // salvar de novo sem mudar o item não troca quem marcou
    const firstMark = saved.checklist[0].doneAt;
    expect((await put({ checklist: saved.checklist }).expect(200)).body.checklist[0].doneAt).toBe(firstMark);

    await put({ plannedStart: day(5), plannedEnd: day(1) }).expect(400);
    await put({ checklist: [{ title: '' }] }).expect(400);
    const stranger = await makeSeller((await makeCompany()).id);
    await put({ responsibleUserId: stranger.id }).expect(400);
    // busca por cliente, número ou título
    expect((await listar(h, { search: 'alfa' })).total).toBe(1);
    expect((await listar(h, { search: 'não existe' })).total).toBe(0);
    expect(company.id).toBeTruthy();
  });

  it('permissões e isolamento entre empresas', async () => {
    const { h, proposal, company } = await cenario();
    const id = (await aceitar(h, proposal.id)).contract.serviceOrder.id as number;

    // quem é só do comercial não abre o quadro; quem só lista não altera
    await api().get('/service-orders').set(auth(company.id, COMMERCIAL)).expect(403);
    const reader = auth(company.id, ['list_ordens_de_servico', 'all_ordens_de_servico']);
    expect((await listar(reader)).total).toBe(1);
    await api().put(`/service-orders/${id}`).set(reader).send({ notes: 'x' }).expect(403);
    await mover(reader, id, { status: 'a_mobilizar' }).expect(403);

    const other = await makeCompany();
    const ho = auth(other.id);
    expect((await listar(ho)).total).toBe(0);
    await api().get(`/service-orders/${id}`).set(ho).expect(404);
    await mover(ho, id, { status: 'a_mobilizar' }).expect(404);
    // liberar sem pedido, para o cliente que não exige
    expect((await mover(h, id, { status: 'a_mobilizar', note: 'Cliente não emite pedido' }).expect(200)).body.status).toBe('a_mobilizar');
  });
  // ------------------------------------------------------------------ RDO

  /** OS em execução desde anteontem, com a equipe escalada. */
  async function emExecucao() {
    const base = await cenario();
    const id = (await aceitar(base.h, base.proposal.id, { customerOrderNumber: '1' })).contract.serviceOrder.id as number;
    await api().put(`/service-orders/${id}`).set(base.h).send({ team: [{ name: 'João', role: 'Alpinista N1' }, { name: 'Pedro', role: 'Alpinista N1' }] }).expect(200);
    await mover(base.h, id, { status: 'agendada', plannedStart: day(-2) }).expect(200);
    await mover(base.h, id, { status: 'em_execucao', date: day(-2) }).expect(200);
    return { ...base, id };
  }
  const rdo = (h: Record<string, string>, orderId: number, body: Record<string, unknown>) => api().post(`/service-orders/${orderId}/reports`).set(h).send(body);

  it('RDO: só com a obra em andamento; o modelo do dia já vem com a equipe; horas, avanço e custo saem do diário', async () => {
    const { h, proposal, company } = await cenario();
    const id = (await aceitar(h, proposal.id, { customerOrderNumber: '1' })).contract.serviceOrder.id as number;
    await rdo(h, id, { date: TODAY }).expect(409); // a obra ainda não começou
    await api().put(`/service-orders/${id}`).set(h).send({ team: [{ name: 'João', role: 'Alpinista N1' }, { name: 'Pedro', role: 'Alpinista N1' }] }).expect(200);
    await mover(h, id, { status: 'agendada', plannedStart: day(-2) }).expect(200);
    await mover(h, id, { status: 'em_execucao', date: day(-2) }).expect(200);

    // o RDO em branco vem com a equipe escalada, as funções vendidas e as etapas do cronograma
    const blankReport = (await api().get(`/service-orders/${id}/reports/template`).set(h).expect(200)).body;
    expect(blankReport).toMatchObject({ date: TODAY, shift: 'integral', weather: 'bom', roles: ['Alpinista N1'], hoursPerDay: 8, order: { number: `OS-${YEAR}-0001` } });
    expect(blankReport.crew).toEqual(['João', 'Pedro'].map((name) => ({ name, role: 'Alpinista N1', hours: 8, overtime: 0, in: null, out: null, leaveReason: null })));
    // a obra começou anteontem: hoje é o 3º dia, que o cronograma reserva à execução
    expect(blankReport.progress).toEqual([{ step: 0, title: 'Mobilização', percent: 0, today: false }, { step: 1, title: 'Execução', percent: 0, today: true }]);

    const first = (await rdo(h, id, {
      date: day(-2), crew: blankReport.crew, activities: 'Montagem do andaime e isolamento da área',
      progress: [{ step: 0, percent: 100 }, { step: 1, percent: 0 }], equipment: 'Andaime tubular', photos: [{ url: 'https://exemplo.local/foto.jpg', caption: 'Área isolada' }],
    }).expect(201)).body;
    expect(first).toMatchObject({ date: day(-2), status: 'rascunho', editable: true, activities: 'Montagem do andaime e isolamento da área' });
    // mesmo dia e turno não repete; outro turno pode
    await rdo(h, id, { date: day(-2) }).expect(409);
    await rdo(h, id, { date: day(-2), shift: 'noite', crew: [{ name: 'João', role: 'Alpinista N1', hours: 2, overtime: 2 }] }).expect(201);
    // datas: nem futuro, nem antes do início da obra
    await rdo(h, id, { date: day(1) }).expect(400);
    await rdo(h, id, { date: day(-5) }).expect(400);
    // dia seguinte: avança a execução, com um ajudante que não estava no orçamento e uma parada
    await rdo(h, id, {
      date: day(-1), crew: [...blankReport.crew, { name: 'Zé', role: 'Ajudante', hours: 4, overtime: 0 }], activities: 'Jateamento do costado',
      progress: [{ step: 0, percent: 100 }, { step: 1, percent: 10 }], occurrences: [{ type: 'paralisacao', description: 'Chuva forte à tarde', hoursLost: 3 }],
    }).expect(201);
    // o modelo de hoje parte do último RDO: mesma equipe, avanço como estava
    const next = (await api().get(`/service-orders/${id}/reports/template`).set(h).expect(200)).body;
    expect(next.crew.map((member: any) => member.name)).toEqual(['João', 'Pedro', 'Zé']);
    expect(next.progress.map((item: any) => item.percent)).toEqual([100, 10]);

    const diary = (await api().get(`/service-orders/${id}/reports`).set(h).expect(200)).body;
    expect(diary).toMatchObject({ canWrite: true, order: { number: `OS-${YEAR}-0001`, status: 'em_execucao' } });
    expect(diary.rows.map((row: any) => [row.date, row.shift, row.people, row.hours, row.overtime])).toEqual([
      [day(-1), 'integral', 3, 20, 0], [day(-2), 'noite', 1, 2, 2], [day(-2), 'integral', 2, 16, 0],
    ]);
    const { summary } = diary;
    expect(summary).toMatchObject({ reports: 3, days: 2, drafts: 3, lastDate: day(-1), stoppedDays: 1, hoursLost: 3 });
    // 2 alpinistas × 22 dias × 8 h = 352 h orçadas; 34 h feitas pela função orçada, 4 h de quem não estava no orçamento
    expect(summary.hours).toMatchObject({ total: 38, overtime: 2, budget: 352 });
    expect(summary.hours.rows).toEqual([
      { role: 'Alpinista N1', hours: 34, overtime: 2, budgetHours: 352, budgetOvertime: 0, matched: true },
      { role: 'Ajudante', hours: 4, overtime: 0, budgetHours: 0, budgetOvertime: 0, matched: false },
    ]);
    // avanço pesado pela duração: (2 × 100% + 20 × 10%) ÷ 22
    expect(summary.progress.done).toBe(18.18);
    expect(summary.progress.planned).toBeGreaterThan(0);
    expect(summary.progress.steps.map((step: any) => step.percent)).toEqual([100, 10]);
    // custo: horas × custo hora da base da proposta; o ajudante fica sem custo e é avisado
    expect(summary.labor.withoutCost).toEqual(['Ajudante']);
    expect(summary.labor.cost).toBeGreaterThan(34 * 59);
    expect(summary.labor.cost).toBeLessThan(34 * 59.1 + 2 * 60);
    expect(summary.labor.budget).toBeGreaterThan(0);
    // pelo cadastro: a função casa pelo id do profissional mesmo com outro texto, e o custo sai
    const alpinista = await testDb().commercial_Professional.findFirstOrThrow({ where: { name: 'Alpinista N1' } });
    const carlos = await testDb().hr_Employee.create({ data: { companyId: alpinista.companyId, name: 'Carlos Lima' } });
    const extra = (await rdo(h, id, { date: day(-1), shift: 'noite', crew: [{ name: 'Carlos Lima', role: 'Escalador', hours: 2, overtime: 0, employeeId: carlos.id, professionalId: alpinista.id }] }).expect(201)).body;
    const linked = (await api().get(`/service-orders/${id}/reports`).set(h).expect(200)).body.summary;
    expect(linked.hours.rows[0]).toMatchObject({ role: 'Alpinista N1', hours: 36, matched: true });
    expect(linked.labor.withoutCost).toEqual(['Ajudante']);
    expect(linked.labor.cost).toBeGreaterThan(summary.labor.cost + 2 * 59);
    await testDb().service_DailyReport.delete({ where: { id: extra.id } }); // o resto do teste segue com os três RDOs de antes
    // sem a permissão de custos: horas sim, custo não
    const field = (await api().get(`/service-orders/${id}/reports`).set(auth(company.id, ORDERS)).expect(200)).body;
    expect(field.summary.labor).toBeNull();
    expect(field.summary.hours.total).toBe(38);
  });

  it('RDO: fechar trava a edição, reabrir pede o motivo, rascunho pode ser apagado', async () => {
    const { h, id } = await emExecucao();
    const empty = (await rdo(h, id, { date: day(-1) }).expect(201)).body;
    // nada lançado: não fecha; dia parado fecha só com o clima
    await api().patch(`/service-reports/${empty.id}/close`).set(h).expect(400);
    expect((await api().put(`/service-reports/${empty.id}`).set(h).send({ weather: 'impraticavel', notes: 'Chuva o dia todo' }).expect(200)).body).toMatchObject({ weather: 'impraticavel', notes: 'Chuva o dia todo' });
    expect((await api().patch(`/service-reports/${empty.id}/close`).set(h).expect(200)).body).toMatchObject({ status: 'fechado', editable: false, closedBy: 'Vendedor Teste' });

    // fechado: não edita, não fecha de novo, não apaga; reabrir pede o motivo
    await api().put(`/service-reports/${empty.id}`).set(h).send({ notes: 'x' }).expect(409);
    await api().patch(`/service-reports/${empty.id}/close`).set(h).expect(409);
    await api().delete(`/service-reports/${empty.id}`).set(h).expect(409);
    await api().patch(`/service-reports/${empty.id}/reopen`).set(h).send({}).expect(400);
    expect((await api().patch(`/service-reports/${empty.id}/reopen`).set(h).send({ note: 'Faltou a foto' }).expect(200)).body).toMatchObject({ status: 'rascunho', editable: true });
    expect(await testDb().flow_Event.count({ where: { entity: 'service_report', entityId: empty.id, type: 'reaberto' } })).toBe(1);

    // validações do que entra no RDO
    const put = (body: Record<string, unknown>) => api().put(`/service-reports/${empty.id}`).set(h).send(body);
    await put({ crew: [{ name: '', role: 'Alpinista N1', hours: 8 }] }).expect(400);
    await put({ crew: [{ name: 'João', hours: 30 }] }).expect(400);
    await put({ progress: [{ step: 1, percent: 140 }] }).expect(400);
    await put({ occurrences: [{ type: 'paralisacao', description: '' }] }).expect(400);
    await put({ photos: [{ url: 'javascript:alert(1)' }] }).expect(400);
    await put({ shift: 'madrugada' }).expect(400);
    await put({ weather: 'neve' }).expect(400);

    // rascunho pode ser apagado; depois de concluir a obra ainda dá para lançar o que faltou, até o dia do término
    await api().delete(`/service-reports/${empty.id}`).set(h).expect(200);
    await mover(h, id, { status: 'concluida', date: day(-1) }).expect(200);
    await rdo(h, id, { date: day(-1), activities: 'Desmobilização' }).expect(201);
    await rdo(h, id, { date: TODAY }).expect(400);
    await mover(h, id, { status: 'encerrada' }).expect(200);
    await rdo(h, id, { date: day(-2) }).expect(409);
  });

  it('RDO: a tela do encarregado lista as obras em andamento; permissões e isolamento', async () => {
    const { h, id, company } = await emExecucao();
    const created = (await rdo(h, id, { date: TODAY, crew: [{ name: 'João', role: 'Alpinista N1', hours: 8 }] }).expect(201)).body;
    const recent = (await api().get('/service-reports').set(h).expect(200)).body;
    expect(recent.today).toBe(TODAY);
    expect(recent.running).toHaveLength(1);
    expect(recent.running[0]).toMatchObject({ number: `OS-${YEAR}-0001`, customer: 'Indústria Alfa', todayReports: [{ id: created.id, status: 'rascunho', shift: 'integral' }] });
    expect(recent.rows[0]).toMatchObject({ id: created.id, date: TODAY, people: 1, hours: 8, order: { number: `OS-${YEAR}-0001` } });

    const reader = auth(company.id, ['list_ordens_de_servico', 'all_ordens_de_servico']);
    expect((await api().get(`/service-reports/${created.id}`).set(reader).expect(200)).body.id).toBe(created.id);
    await rdo(reader, id, { date: day(-1) }).expect(403);
    await api().put(`/service-reports/${created.id}`).set(reader).send({ notes: 'x' }).expect(403);
    await api().get('/service-reports').set(auth(company.id, COMMERCIAL)).expect(403);

    const ho = auth((await makeCompany()).id);
    expect((await api().get('/service-reports').set(ho).expect(200)).body).toMatchObject({ running: [], rows: [] });
    await api().get(`/service-reports/${created.id}`).set(ho).expect(404);
    await api().get(`/service-orders/${id}/reports`).set(ho).expect(404);
    await rdo(ho, id, { date: TODAY }).expect(404);
    await api().patch(`/service-reports/${created.id}/close`).set(ho).expect(404);
  });
});
