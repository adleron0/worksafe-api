import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Perfis e "Minha esteira".
 *
 * O que não pode quebrar: sem a permissão de ver tudo, cada um enxerga só o que
 * é seu (OS em que está escalado, é responsável ou vendeu; propostas em que é o
 * vendedor ou que criou); lançar RDO e registrar contato têm permissão própria;
 * e a tela inicial mostra a cada um só os blocos das áreas em que atua.
 */
describe('Perfis e Minha esteira (e2e)', () => {
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

  const auth = (companyId: number, permissions: string[] = ALL, sub = userId) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub, companyId, permissions, profile: 'admin' }) },
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
  const FIELD = ['list_ordens_de_servico', 'update_rdo'];

  it('ordens de serviço: sem a permissão de ver todas, só as em que a pessoa está escalada, é responsável ou vendeu', async () => {
    const { h, proposal, company } = await cenario();
    const id = (await aceitar(h, proposal.id, { customerOrderNumber: '1' })).contract.serviceOrder.id as number;
    const field = await makeSeller(company.id);
    const f = auth(company.id, FIELD, field.id);

    // o encarregado ainda não está na obra: não vê nada dela
    expect((await listar(f)).total).toBe(0);
    await api().get(`/service-orders/${id}`).set(f).expect(404);
    await api().get(`/service-orders/${id}/reports`).set(f).expect(404);
    await api().get(`/service-orders/${id}/reports/template`).set(f).expect(404);
    expect((await api().get('/service-reports').set(f).expect(200)).body.running).toHaveLength(0);

    // quem vendeu vê a OS da sua venda mesmo sem a permissão de ver todas
    expect((await listar(auth(company.id, ['list_ordens_de_servico']))).total).toBe(1);

    // escalado na equipe (ligado ao usuário), passa a ver
    await api().put(`/service-orders/${id}`).set(h).send({ team: [{ name: 'João', role: 'Alpinista N1', userId: 999999 }] }).expect(400);
    const saved = (await api().put(`/service-orders/${id}`).set(h).send({ team: [{ name: 'João', role: 'Alpinista N1', userId: field.id }, { name: 'Sem login', role: 'Ajudante' }] }).expect(200)).body;
    expect(saved.team).toEqual([{ name: 'João', role: 'Alpinista N1', userId: field.id }, { name: 'Sem login', role: 'Ajudante', userId: null }]);
    expect((await listar(f)).rows.map((row: any) => row.id)).toEqual([id]);
    await api().get(`/service-orders/${id}`).set(f).expect(200);

    // lança o RDO, mas não altera nem move a OS
    await mover(h, id, { status: 'agendada', plannedStart: day(-1) }).expect(200);
    await mover(h, id, { status: 'em_execucao', date: day(-1) }).expect(200);
    await api().put(`/service-orders/${id}`).set(f).send({ notes: 'x' }).expect(403);
    await mover(f, id, { status: 'concluida' }).expect(403);
    const report = (await rdo(f, id, { date: TODAY, startTime: '07:00', endTime: '16:00', crew: [{ name: 'João', role: 'Alpinista N1', hours: 8 }], activities: 'Jateamento' }).expect(201)).body;
    await api().patch(`/service-reports/${report.id}/close`).set(f).expect(200);
    expect((await api().get('/service-reports').set(f).expect(200)).body.running).toHaveLength(1);
    // editar a OS não basta para lançar RDO: a permissão é própria
    await rdo(auth(company.id, ['list_ordens_de_servico', 'update_ordens_de_servico', 'all_ordens_de_servico']), id, { date: day(-1) }).expect(403);

    // tirado da equipe, deixa de ver a OS e o RDO que lançou; como responsável, volta a ver
    await api().put(`/service-orders/${id}`).set(h).send({ team: [] }).expect(200);
    await api().get(`/service-orders/${id}`).set(f).expect(404);
    await api().get(`/service-reports/${report.id}`).set(f).expect(404);
    await api().patch(`/service-reports/${report.id}/reopen`).set(f).send({ note: 'corrigir' }).expect(404);
    await api().put(`/service-orders/${id}`).set(h).send({ responsibleUserId: field.id }).expect(200);
    await api().get(`/service-reports/${report.id}`).set(f).expect(200);
  });

  it('propostas, vendas e contatos: sem a permissão de ver todas, só os da pessoa', async () => {
    const { h, proposal, company, customer } = await cenario();
    const accepted = await aceitar(h, proposal.id, { customerOrderNumber: '1' });
    await api().post('/commercial/activities').set(h).send({ proposalId: proposal.id, type: 'ligacao', subject: 'Confirmar início', dueDate: TODAY }).expect(201);
    const other = await makeSeller(company.id);
    const OWN = ['list_comercial', 'create_comercial', 'update_comercial', 'update_acompanhamento'];
    const o = auth(company.id, OWN, other.id);

    // o outro vendedor não vê a proposta, a venda nem o contato de quem vendeu
    expect((await api().get('/commercial/proposals').set(o).expect(200)).body.total).toBe(0);
    await api().get(`/commercial/proposals/${proposal.id}`).set(o).expect(404);
    await api().put(`/commercial/proposals/${proposal.id}`).set(o).send({ title: 'x' }).expect(404);
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(o).send({ status: 'perdida' }).expect(404);
    expect((await api().get('/commercial/contracts').set(o).expect(200)).body.total).toBe(0);
    await api().get(`/commercial/contracts/${accepted.contract.id}`).set(o).expect(404);
    expect((await api().get('/commercial/activities').set(o).expect(200)).body.total).toBe(0);

    // a proposta que ele cria é dele: vê a sua e só a sua
    const options = (await api().get('/commercial/proposals/options').set(o).expect(200)).body;
    const mine = (await api().post('/commercial/proposals').set(o).send({
      kind: 'servico', customerId: customer.id, title: 'Linha de vida', workDays: 5,
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.2, items: [{ type: 'mao_de_obra', professionalId: options.professionals[0].id, quantity: 1 }] }],
    }).expect(201)).body;
    expect((await api().get('/commercial/proposals').set(o).expect(200)).body.rows.map((row: any) => row.id)).toEqual([mine.id]);
    await api().post('/commercial/activities').set(o).send({ proposalId: mine.id, type: 'ligacao', subject: 'Retornar', dueDate: TODAY }).expect(201);
    expect((await api().get('/commercial/activities').set(o).expect(200)).body.total).toBe(1);

    // quem vendeu vê as suas sem a permissão de ver todas; com ela, vê tudo
    expect((await api().get('/commercial/proposals').set(auth(company.id, OWN)).expect(200)).body.rows.map((row: any) => row.id)).toEqual([proposal.id]);
    expect((await api().get('/commercial/proposals').set(auth(company.id, [...OWN, 'all_propostas'], other.id)).expect(200)).body.total).toBe(2);
    expect((await api().get('/commercial/contracts').set(auth(company.id, [...OWN, 'all_propostas'], other.id)).expect(200)).body.total).toBe(1);
    expect((await api().get('/commercial/activities').set(auth(company.id, [...OWN, 'all_propostas'], other.id)).expect(200)).body.total).toBe(2);

    // registrar contato pede a permissão própria: editar proposta não basta, e ela sozinha basta
    await api().post('/commercial/activities').set(auth(company.id, ['list_comercial', 'update_comercial'])).send({ proposalId: proposal.id, type: 'ligacao', subject: 'x', dueDate: TODAY }).expect(403);
    await api().post('/commercial/activities').set(auth(company.id, ['list_comercial', 'update_acompanhamento'])).send({ proposalId: proposal.id, type: 'ligacao', subject: 'Só acompanhamento', dueDate: TODAY }).expect(201);
    // o Financeiro fatura a venda de qualquer vendedor
    const fin = auth(company.id, ['list_financeiro', 'create_financeiro'], other.id);
    expect((await api().get('/commercial/contracts/billing').set(fin).expect(200)).body.rows).toHaveLength(2);
  });

  it('Minha esteira: cada um recebe só os blocos das áreas em que atua, com o que espera por ele', async () => {
    const { h, proposal, company } = await cenario();
    const id = (await aceitar(h, proposal.id, { customerOrderNumber: '1' })).contract.serviceOrder.id as number;
    const db = testDb();
    const esteira = async (headers: Record<string, string>) => (await api().get('/my-pipeline').set(headers).expect(200)).body;
    const bloco = (data: any, key: string) => data.blocks.find((block: any) => block.key === key);

    await api().get('/my-pipeline').expect(401);
    expect((await esteira(auth(company.id, []))).blocks).toEqual([]);

    // retornos: só os da própria pessoa, de hoje ou atrasados
    await api().post('/commercial/activities').set(h).send({ proposalId: proposal.id, type: 'ligacao', subject: 'Ligar hoje', dueDate: TODAY }).expect(201);
    await api().post('/commercial/activities').set(h).send({ proposalId: proposal.id, type: 'ligacao', subject: 'Ligar ontem', dueDate: day(-1) }).expect(201);
    await api().post('/commercial/activities').set(h).send({ proposalId: proposal.id, type: 'ligacao', subject: 'Semana que vem', dueDate: day(7) }).expect(201);
    // compras e contas a pagar
    await api().post('/purchase-orders').set(auth(company.id, ['create_pedidos_de_compra'])).send({ title: 'Cabo de aço', group: 'material', serviceOrderId: id, items: [{ description: 'Cabo', quantity: 1, unitPrice: 300 }] }).expect(201);
    const payable = (dueDate: string, value: number) => db.financial_Payable.create({ data: { companyId: company.id, description: `Conta ${value}`, value, dueDate: new Date(`${dueDate}T12:00:00Z`), accrualDate: dueDate.slice(0, 7) } as never });
    await payable(day(-3), 100); await payable(day(2), 200); await payable(day(30), 400);

    const all = await esteira(auth(company.id, [...ALL, 'approve_pedidos_de_compra', 'list_pedidos_de_compra', 'update_pedidos_de_compra']));
    expect(all.today).toBe(TODAY);
    expect(all.blocks.map((block: any) => block.key)).toEqual([
      'retornos', 'os_mobilizar', 'os_atrasadas', 'rdo_hoje', 'compras_aprovar', 'compras_comprar', 'compras_receber', 'faturar', 'pagar_atrasadas', 'pagar_semana', 'receber_vencidas',
    ]);
    expect(bloco(all, 'retornos')).toMatchObject({ area: 'Comercial', count: 2 });
    expect(bloco(all, 'retornos').items.map((item: any) => [item.late, item.link])).toEqual([[true, `/comercial/propostas/${proposal.id}`], [false, `/comercial/propostas/${proposal.id}`]]);
    expect(bloco(all, 'os_mobilizar')).toMatchObject({ count: 1, items: [{ id, link: `/servicos/ordens-de-servico/${id}` }] });
    expect(bloco(all, 'os_atrasadas').count).toBe(0);
    expect(bloco(all, 'rdo_hoje').count).toBe(0);
    expect(bloco(all, 'compras_aprovar')).toMatchObject({ count: 1, total: 300 });
    expect(bloco(all, 'compras_comprar').count).toBe(0);
    // a entrada (5 dias após o aceite) já está liberada; a do fim da obra espera a conclusão
    expect(bloco(all, 'faturar')).toMatchObject({ count: 1, items: [{ subtitle: expect.stringContaining('parcela 1/2') }] });
    expect(bloco(all, 'pagar_atrasadas')).toMatchObject({ count: 1, total: 100, items: [{ late: true }] });
    expect(bloco(all, 'pagar_semana')).toMatchObject({ count: 1, total: 200 });

    // obra andando com a data estourada e sem RDO hoje
    await mover(h, id, { status: 'agendada', plannedStart: day(-5), plannedEnd: day(-1) }).expect(200);
    await mover(h, id, { status: 'em_execucao', date: day(-5) }).expect(200);
    const running = await esteira(h);
    expect(bloco(running, 'os_mobilizar').count).toBe(0);
    expect(bloco(running, 'os_atrasadas')).toMatchObject({ count: 1, items: [{ id, late: true }] });
    expect(bloco(running, 'rdo_hoje').count).toBe(1);
    await rdo(h, id, { date: TODAY, activities: 'Jateamento', crew: [{ name: 'João', role: 'Alpinista N1', hours: 8 }] }).expect(201);
    expect(bloco(await esteira(h), 'rdo_hoje').count).toBe(0);

    // cada perfil vê só os seus blocos; o encarregado fora da equipe não vê a obra
    const field = await makeSeller(company.id);
    const f = auth(company.id, FIELD, field.id);
    expect((await esteira(f)).blocks.map((block: any) => [block.key, block.count])).toEqual([['os_atrasadas', 0], ['rdo_hoje', 0]]);
    await api().put(`/service-orders/${id}`).set(h).send({ team: [{ name: 'Campo', role: 'Alpinista N1', userId: field.id }] }).expect(200);
    expect((await esteira(f)).blocks.map((block: any) => [block.key, block.count])).toEqual([['os_atrasadas', 1], ['rdo_hoje', 0]]);
    expect((await esteira(auth(company.id, ['list_pedidos_de_compra', 'update_pedidos_de_compra']))).blocks.map((block: any) => block.key)).toEqual(['compras_comprar', 'compras_receber']);
    expect((await esteira(auth(company.id, ['list_financeiro']))).blocks.map((block: any) => block.key)).toEqual(['faturar', 'pagar_atrasadas', 'pagar_semana', 'receber_vencidas']);
    // retornos são de quem ficou de fazer: outro vendedor não recebe os meus
    expect(bloco(await esteira(auth(company.id, ['list_comercial', 'all_propostas'], field.id)), 'retornos').count).toBe(0);
    // outra empresa: nada
    const otherCompany = await makeCompany();
    expect((await esteira(auth(otherCompany.id))).blocks.every((block: any) => block.count === 0)).toBe(true);
  });
});
