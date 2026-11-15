import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Resultado da OS: orçado × realizado × projeção.
 *
 * O que não pode quebrar: a receita vem do que foi faturado, a mão de obra dos
 * RDOs, o resto dos pedidos de compra e das contas a pagar da obra; a projeção
 * avisa antes da obra acabar; encerrar congela; só vê quem tem a permissão de custos.
 */
describe('Operação — resultado da OS (e2e)', () => {
  const COMMERCIAL = ['list_comercial', 'create_comercial', 'update_comercial', 'all_propostas', 'update_acompanhamento'];
  const ORDERS = ['list_ordens_de_servico', 'update_ordens_de_servico', 'all_ordens_de_servico', 'update_rdo'];
  const PURCHASES = ['list_pedidos_de_compra', 'create_pedidos_de_compra', 'update_pedidos_de_compra', 'approve_pedidos_de_compra'];
  const ALL = [...COMMERCIAL, ...ORDERS, ...PURCHASES, 'view_custos_comercial', 'list_financeiro', 'create_financeiro', 'update_financeiro'];
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
  const resultado = async (h: Record<string, string>, id: number) => (await api().get(`/service-orders/${id}/result`).set(h).expect(200)).body;
  const linha = (result: any, key: string) => result.lines.find((line: any) => line.key === key);
  /** Pedido de compra da obra, levado até a etapa pedida. */
  async function compra(h: Record<string, string>, orderId: number, group: string, value: number, until: 'solicitado' | 'aprovado' | 'comprado', supplierId?: number) {
    const { body } = await api().post('/purchase-orders').set(h).send({ title: `Compra ${group}`, group, serviceOrderId: orderId, supplierId, items: [{ description: 'Item', quantity: 1, unitPrice: value }] }).expect(201);
    if (until !== 'solicitado') await api().patch(`/purchase-orders/${body.id}/status`).set(h).send({ status: 'aprovado' }).expect(200);
    if (until === 'comprado') await api().patch(`/purchase-orders/${body.id}/status`).set(h).send({ status: 'comprado', firstDueDate: day(10) }).expect(200);
    return body.id as number;
  }

  it('orçado da proposta, realizado do diário, das compras e do faturamento, e a projeção', async () => {
    const { h, proposal: draft, company } = await cenario();
    const accepted = await aceitar(h, draft.id, { customerOrderNumber: '4500123' });
    const id = accepted.contract.serviceOrder.id as number;
    const db = testDb();
    const proposal = await db.commercial_Proposal.findUniqueOrThrow({ where: { id: draft.id } });
    const supplier = await db.financial_Supplier.create({ data: { companyId: company.id, name: 'Andaimes Recife' } });

    // antes de começar: só o orçado; a projeção repete o orçamento
    const start = await resultado(h, id);
    expect(start).toMatchObject({ status: 'a_mobilizar', frozen: false, revenue: { budget: Number(proposal.total), invoiced: 0, received: 0, toInvoice: Number(proposal.total) } });
    expect(start.lines.map((line: any) => line.key)).toEqual(['mao_de_obra', 'locacao', 'material', 'outros', 'imposto', 'comissao'].filter((key) => linha(start, key)));
    expect(linha(start, 'locacao')).toMatchObject({ budget: 1500, realized: 0, committed: 0, projected: 1500 });
    expect(linha(start, 'mao_de_obra').budget).toBeGreaterThan(0);
    expect(linha(start, 'terceiros')).toBeUndefined();
    // o orçado fecha com a proposta: o lucro dela, já descontada a comissão do vendedor
    expect(start.totals.budget.profit).toBeCloseTo(Number(proposal.profit) - Number(proposal.commission), 1);
    expect(start.totals.projected).toEqual(start.totals.budget);
    expect(start.totals.realized).toEqual({ revenue: 0, cost: 0, profit: 0, margin: null });
    expect(start.pending[0]).toMatch(/^2 parcelas ainda não faturadas/);

    // obra em andamento: 2 dias de RDO, 10% feito
    await mover(h, id, { status: 'agendada', plannedStart: day(-2) }).expect(200);
    await mover(h, id, { status: 'em_execucao', date: day(-2) }).expect(200);
    const crew = [{ name: 'João', role: 'Alpinista N1', hours: 8, overtime: 0 }, { name: 'Pedro', role: 'Alpinista N1', hours: 8, overtime: 0 }];
    await rdo(h, id, { date: day(-2), crew, activities: 'Montagem', progress: [{ step: 0, percent: 50 }, { step: 1, percent: 0 }] }).expect(201);
    await rdo(h, id, { date: day(-1), crew, activities: 'Jateamento', progress: [{ step: 0, percent: 100 }, { step: 1, percent: 0 }] }).expect(201);
    // compras: locação comprada acima do orçado, material aprovado (não orçado), terceiros só solicitado
    await compra(h, id, 'locacao', 1800, 'comprado', supplier.id);
    await compra(h, id, 'material', 300, 'aprovado');
    await compra(h, id, 'terceiros', 999, 'solicitado');
    // despesa lançada direto no Financeiro para a obra
    await db.financial_Payable.create({ data: { companyId: company.id, description: 'Pedágio', value: 50, dueDate: new Date(`${day(5)}T12:00:00Z`), accrualDate: day(5).slice(0, 7), serviceOrderId: id, origin: 'manual' } as never });
    // fatura a entrada e recebe
    const contract = (await api().get(`/commercial/contracts/${accepted.contract.id}`).set(h).expect(200)).body;
    const billed = (await api().post(`/commercial/contracts/${contract.id}/installments/${contract.installments[0].id}/bill`).set(h).send({ invoiceNumber: 'NF-1' }).expect(201)).body;
    await db.financialRecords.update({ where: { id: billed.financialRecordId }, data: { status: 'received' } });

    const mid = await resultado(h, id);
    const half = Number(contract.installments[0].value);
    expect(mid.revenue).toMatchObject({ invoiced: half, received: half, toInvoice: Number(contract.installments[1].value) });
    expect(mid.progress.done).toBe(9.09); // (2 × 100% + 20 × 0%) ÷ 22
    // mão de obra: 32 h × custo hora; no ritmo atual a obra custaria 11× isso
    const labor = linha(mid, 'mao_de_obra');
    expect(labor.realized).toBeGreaterThan(32 * 59);
    expect(labor.projected).toBeCloseTo(labor.realized / 0.0909, 1);
    expect(labor.note).toMatch(/ritmo atual/);
    // locação estourou: a projeção é o que já foi comprado; material não tinha orçamento
    expect(linha(mid, 'locacao')).toMatchObject({ budget: 1500, realized: 1800, committed: 0, projected: 1800 });
    expect(linha(mid, 'material')).toMatchObject({ budget: 0, realized: 0, committed: 300, projected: 300 });
    expect(linha(mid, 'outros')).toMatchObject({ realized: 50, projected: 50 });
    expect(linha(mid, 'terceiros')).toBeUndefined(); // solicitado não entra na conta
    // imposto pela alíquota da proposta sobre o faturado
    expect(linha(mid, 'imposto').realized).toBeCloseTo((Number(proposal.totalTax) / Number(proposal.total)) * half, 1);
    expect(mid.totals.realized.revenue).toBe(half);
    expect(mid.totals.realized.cost).toBeCloseTo(mid.lines.reduce((sum: number, line: any) => sum + line.realized, 0), 2);
    expect(mid.totals.projected.revenue).toBe(Number(proposal.total));
    expect(mid.totals.projected.profit).toBeLessThan(mid.totals.budget.profit);
    expect(mid.pending.join(' | ')).toMatch(/1 parcela ainda não faturada.*1 pedido de compra aguardando aprovação.*1 pedido de compra aprovado e ainda não comprado.*2 RDOs em rascunho/);

    // resumo da gestão
    const summary = (await api().get('/service-orders/results').set(h).expect(200)).body;
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toMatchObject({ id, status: 'em_execucao', frozen: false, progress: 9.09, projected: mid.totals.projected });
    expect(summary.totals).toMatchObject({ orders: 1, below: 1, projected: mid.totals.projected });
    expect((await api().get('/service-orders/results').query({ view: 'terminadas' }).set(h).expect(200)).body.rows).toHaveLength(0);
    expect((await api().get('/service-orders/results').query({ search: 'jateamento' }).set(h).expect(200)).body.rows).toHaveLength(1);

    // só com a permissão de custos
    const field = auth(company.id, ORDERS);
    await api().get(`/service-orders/${id}/result`).set(field).expect(403);
    await api().get('/service-orders/results').set(field).expect(403);
    await api().get(`/service-orders/${id}/result`).set(auth(company.id, ['view_custos_comercial'])).expect(403);
    const other = await makeCompany();
    await api().get(`/service-orders/${id}/result`).set(auth(other.id)).expect(404);
    expect((await api().get('/service-orders/results').set(auth(other.id)).expect(200)).body.rows).toHaveLength(0);
  });

  it('obra terminada projeta o que foi gasto; encerrar congela o resultado e reabrir volta a calcular', async () => {
    const { h, proposal, company } = await cenario();
    const id = (await aceitar(h, proposal.id, { customerOrderNumber: '1' })).contract.serviceOrder.id as number;
    const db = testDb();
    const supplier = await db.financial_Supplier.create({ data: { companyId: company.id, name: 'Andaimes Recife' } });
    await mover(h, id, { status: 'agendada', plannedStart: day(-1) }).expect(200);
    await mover(h, id, { status: 'em_execucao', date: day(-1) }).expect(200);
    await rdo(h, id, { date: day(-1), crew: [{ name: 'João', role: 'Alpinista N1', hours: 8, overtime: 0 }], activities: 'Tudo', progress: [{ step: 0, percent: 100 }, { step: 1, percent: 100 }] }).expect(201);
    await compra(h, id, 'locacao', 1000, 'comprado', supplier.id);
    await mover(h, id, { status: 'concluida', date: TODAY }).expect(200);

    // concluída: a projeção é o realizado, abaixo do orçado → lucro maior
    const done = await resultado(h, id);
    expect(linha(done, 'locacao')).toMatchObject({ budget: 1500, realized: 1000, projected: 1000 });
    expect(linha(done, 'mao_de_obra').projected).toBe(linha(done, 'mao_de_obra').realized);
    expect(linha(done, 'mao_de_obra').note).toBeNull();
    expect(done.totals.projected.profit).toBeGreaterThan(done.totals.budget.profit);

    const closed = (await mover(h, id, { status: 'encerrada' }).expect(200)).body;
    expect(closed.closedAt).toBeTruthy();
    const frozen = await resultado(h, id);
    expect(frozen).toMatchObject({ status: 'encerrada', frozen: true, totals: done.totals });
    expect(frozen.closedAt).toBeTruthy();
    // o que acontecer depois não mexe no resultado congelado
    await api().post('/purchase-orders').set(h).send({ title: 'Tarde demais', group: 'material', serviceOrderId: id, items: [{ description: 'Item', quantity: 1, unitPrice: 10 }] }).expect(400);
    await db.financial_Payable.create({ data: { companyId: company.id, description: 'Frete de retorno', value: 700, dueDate: new Date(`${day(5)}T12:00:00Z`), accrualDate: day(5).slice(0, 7), serviceOrderId: id, origin: 'manual' } as never });
    expect((await resultado(h, id)).totals).toEqual(done.totals);
    expect((await api().get('/service-orders/results').query({ view: 'terminadas' }).set(h).expect(200)).body.rows[0]).toMatchObject({ frozen: true, projected: done.totals.projected });

    // reabrir descongela e a despesa nova entra
    await mover(h, id, { status: 'concluida' }).expect(200);
    const reopened = await resultado(h, id);
    expect(reopened).toMatchObject({ frozen: false, closedAt: null });
    expect(linha(reopened, 'outros')).toMatchObject({ realized: 700, projected: 700 });
    expect((await db.service_Order.findUnique({ where: { id } })).result).toBeNull();
  });
});
