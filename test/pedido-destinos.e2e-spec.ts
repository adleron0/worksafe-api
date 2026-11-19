import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Plano 08, fase 6: o pedido de compra ganha a Ordem de Locação e a turma como
 * destino (além da OS e da empresa) — frete, sublocação, material de curso — e
 * o resultado (receita − custo) aparece para a OL e para a turma.
 */
describe('Pedido de compra para OL e turma, e o resultado de cada venda (e2e)', () => {
  const ALL = [
    'list_comercial', 'create_comercial', 'update_comercial', 'view_custos_comercial',
    'list_itens_estoque', 'create_itens_estoque', 'update_itens_estoque', 'movimentar_estoque',
    'list_locacoes', 'create_locacoes', 'update_locacoes',
    'list_financeiro', 'create_financeiro', 'update_financeiro',
    'list_pedidos_de_compra', 'create_pedidos_de_compra', 'update_pedidos_de_compra', 'approve_pedidos_de_compra',
  ];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => { blockRealNetwork(); jwt = (await bootTestApp()).get(JwtService); });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());
  const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const addDays = (value: string, days: number) => { const d = new Date(`${value}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

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
    const supplier = await db.financial_Supplier.create({ data: { companyId: company.id, name: 'Transportes Sul' } });
    const h = auth(company.id);
    await api().get('/commercial/tax-profiles').set(h).expect(200);
    const main = (await api().get('/stock/locations').set(h).expect(200)).body[0];
    const tripe = (await api().post('/stock/items').set(h).send({
      name: 'Tripé com guincho 20 m', tracking: 'quantidade', returnable: true, rentable: true, replacementValue: 10050, lifeMonths: 60, rentMode: 'locacao',
    }).expect(201)).body;
    await api().post('/stock/movements').set(h).send({ type: 'entrada_avulsa', locationId: main.id, lines: [{ itemId: tripe.id, quantity: 2, unitCost: 8000 }] }).expect(201);
    return { db, company, customer, supplier, h, main, tripe };
  }

  /** Compra aprovada e comprada (vira custo realizado). */
  async function comprar(h: Record<string, string>, id: number) {
    await api().patch(`/purchase-orders/${id}/status`).set(h).send({ status: 'aprovado' }).expect(200);
    return (await api().patch(`/purchase-orders/${id}/status`).set(h).send({ status: 'comprado', installments: 1, firstDueDate: addDays(today(), 10), paymentMethod: 'boleto' }).expect(200)).body;
  }

  it('OL: frete e sublocação como pedidos da OL; o resultado junta medições faturadas e compras', async () => {
    const { db, company, customer, supplier, h, main, tripe } = await cenario();
    const start = addDays(today(), -40);
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'locacao', customerId: customer.id, title: 'Tripé para parada', contingencyRate: 0, commission: { rate: 0.05, base: 'faturado' }, referenceDate: start,
      rental: { period: 'mes', periods: 2, billing: 'periodo' },
      sections: [{ title: 'Equipamentos', kind: 'locacao_cliente', items: [{ type: 'locacao_cliente', stockItemId: tripe.id, quantity: 1, extra: { period: 'mes', periods: 2, rate: 1000 } }] }],
    }).expect(201)).body;
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200);
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'aceita' }).expect(200);
    const contract = await db.commercial_Contract.findFirstOrThrow({ where: { proposalId: proposal.id } });
    const ol = await db.stock_Rental.findFirstOrThrow({ where: { contractId: contract.id } });

    // a OL aparece nas opções do pedido; um destino só por pedido
    const options = (await api().get('/purchase-orders/options').set(h).expect(200)).body;
    expect(options.rentals).toEqual([{ id: ol.id, name: `${ol.number} — Refinaria Beta` }]);
    const order = await db.service_Order.create({ data: {
      companyId: company.id, number: 'OS-2026-0001', year: 2026, sequence: 1, contractId: 9001, proposalId: 9001, customerId: customer.id, title: 'Outra obra', status: 'a_mobilizar', scope: [], checklist: [],
    } });
    await api().post('/purchase-orders').set(h).send({ title: 'Frete', group: 'outros', rentalId: ol.id, serviceOrderId: order.id, items: [{ description: 'Frete', quantity: 1, unitPrice: 300 }] }).expect(400);

    const freight = (await api().post('/purchase-orders').set(h).send({ title: 'Frete de entrega', group: 'outros', supplierId: supplier.id, rentalId: ol.id, items: [{ description: 'Frete', quantity: 1, unitPrice: 300 }] }).expect(201)).body;
    expect(freight.rental).toEqual({ id: ol.id, number: ol.number, customer: 'Refinaria Beta' });
    expect(freight.serviceOrder).toBeNull();
    const sublease = (await api().post('/purchase-orders').set(h).send({ title: 'Sublocação de tripé', group: 'locacao', supplierId: supplier.id, rentalId: ol.id, items: [{ description: 'Tripé de terceiro', quantity: 1, unitPrice: 500 }] }).expect(201)).body;
    await comprar(h, freight.id);
    // sublocação aprovada e ainda não comprada: comprometido
    await api().patch(`/purchase-orders/${sublease.id}/status`).set(h).send({ status: 'aprovado' }).expect(200);
    // pedido aprovado não troca de destino
    await api().put(`/purchase-orders/${sublease.id}`).set(h).send({ rentalId: null }).expect(409);

    const list = (await api().get('/purchase-orders').set(h).query({ rentalId: ol.id }).expect(200)).body;
    expect(list.rows.map((r: any) => [r.number, r.rental.number])).toEqual(expect.arrayContaining([[freight.number, ol.number], [sublease.number, ol.number]]));
    const ofRental = (await api().get(`/purchase-orders/rental/${ol.id}`).set(h).expect(200)).body;
    expect(ofRental).toMatchObject({ committed: 800, pending: 0 });

    // entrega há 40 dias e fatura o primeiro mês
    await api().post(`/stock/rentals/${ol.id}/deliver`).set(h).send({ locationId: main.id, date: start }).expect(200);
    await api().post(`/commercial/contracts/${contract.id}/measurements`).set(h).send({ rentalId: ol.id, invoiceNumber: '501', paymentMethod: 'boleto' }).expect(201);

    const result = (await api().get(`/purchase-orders/rental/${ol.id}/result`).set(h).expect(200)).body;
    expect(result).toMatchObject({ kind: 'locacao', number: ol.number, customer: 'Refinaria Beta', contracts: [{ id: contract.id, share: 1 }] });
    expect(result.revenue).toMatchObject({ contracted: 2000, invoiced: 1000, received: 0, toInvoice: 0 });
    const line = (key: string) => result.lines.find((l: any) => l.key === key);
    expect(line('outros')).toMatchObject({ realized: 300, committed: 0 });
    expect(line('locacao')).toMatchObject({ realized: 0, committed: 500 });
    expect(line('comissao').realized).toBeCloseTo(50, 2);
    const realizedCost = result.lines.reduce((s: number, l: any) => s + l.realized, 0);
    expect(result.totals.realized).toMatchObject({ revenue: 1000 });
    expect(result.totals.realized.cost).toBeCloseTo(realizedCost, 2);
    expect(result.totals.realized.profit).toBeCloseTo(1000 - realizedCost, 2);
    expect(result.totals.projected.revenue).toBe(2000);
    expect(result.pending).toEqual(expect.arrayContaining([expect.stringMatching(/faturados e ainda não recebidos/), expect.stringMatching(/aprovado e ainda não comprado/)]));

    // resultado é custo: sem a permissão, 403
    await api().get(`/purchase-orders/rental/${ol.id}/result`).set(auth(company.id, ALL.filter((p) => p !== 'view_custos_comercial'))).expect(403);
  });

  it('turma: material de curso como pedido da turma; receita da venda (turma fechada) e das inscrições pagas', async () => {
    const { db, company, customer, supplier, h } = await cenario();
    const course = await makeCourse(company.id);
    const closed = await makeCourseClass(company.id, course.id, { customerId: customer.id, allowCheckout: false, allowSubscriptions: false, name: 'NR-35 Alfa' });
    const sale = (await api().post('/commercial/quick-sale').set(h).send({
      classId: closed.id, value: 4000, installments: [{ percent: 0.5, dueRule: 'dias_apos_nf', dueDays: 0 }, { percent: 0.5, dueRule: 'dias_apos_nf', dueDays: 30 }],
    }).expect(201)).body;
    const contract = (await api().get(`/commercial/contracts/${sale.contractId}`).set(h).expect(200)).body;
    await api().post(`/commercial/contracts/${sale.contractId}/installments/${contract.installments[0].id}/bill`).set(h).send({ invoiceNumber: 'NF-77' }).expect(201);

    const options = (await api().get('/purchase-orders/options').set(h).expect(200)).body;
    expect(options.classes.map((c: any) => c.id)).toContain(closed.id);
    const material = (await api().post('/purchase-orders').set(h).send({ title: 'Apostilas', group: 'material', supplierId: supplier.id, classId: closed.id, items: [{ description: 'Apostila NR-35', quantity: 20, unitPrice: 15 }] }).expect(201)).body;
    expect(material.courseClass).toMatchObject({ id: closed.id, customer: 'Refinaria Beta' });
    expect(material.courseClass.number).toContain('NR-35 Alfa');
    await comprar(h, material.id);
    expect((await api().get(`/purchase-orders/class/${closed.id}`).set(h).expect(200)).body).toMatchObject({ committed: 300 });

    const result = (await api().get(`/purchase-orders/class/${closed.id}/result`).set(h).expect(200)).body;
    expect(result).toMatchObject({ kind: 'turma', contracts: [{ id: sale.contractId, share: 1 }] });
    expect(result.revenue).toMatchObject({ contracted: 4000, invoiced: 2000, toInvoice: 2000 });
    expect(result.lines.find((l: any) => l.key === 'material')).toMatchObject({ realized: 300 });
    expect(result.pending).toEqual(expect.arrayContaining([expect.stringMatching(/parcela da venda ainda não faturada/)]));

    // turma aberta: a receita é a das inscrições pagas (pagamentos recusados não contam)
    const open = await makeCourseClass(company.id, course.id, { name: 'NR-35 Aberta' });
    const student = await db.courseClassSubscription.create({ data: { companyId: company.id, classId: open.id, name: 'Ana', cpf: '52998224725', email: 'ana@x.local', phone: '81999990000' } as never });
    await db.financialRecords.create({ data: { companyId: company.id, subscriptionId: student.id, value: 650, status: 'received', description: 'Inscrição', accrualDate: '2026-11', gateway: 'manual', paymentMethod: 'pix' } as never });
    await db.financialRecords.create({ data: { companyId: company.id, subscriptionId: student.id, value: 650, status: 'declined', description: 'Inscrição', accrualDate: '2026-11', gateway: 'manual', paymentMethod: 'pix' } as never });
    const openResult = (await api().get(`/purchase-orders/class/${open.id}/result`).set(h).expect(200)).body;
    expect(openResult.revenue).toMatchObject({ invoiced: 650, received: 650, contracted: 650 });
    expect(openResult.contracts).toEqual([]);
  });
});
