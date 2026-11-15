import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Pedidos de compra: solicitar, aprovar (permissão própria), comprar (gera as
 * contas a pagar), receber, e o comprometido da obra.
 */
describe('Pedidos de compra (e2e)', () => {
  const BASE = ['list_pedidos_de_compra', 'create_pedidos_de_compra', 'update_pedidos_de_compra', 'list_ordens_de_servico', 'list_financeiro', 'update_financeiro'];
  const APPROVER = [...BASE, 'approve_pedidos_de_compra'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions: string[] = APPROVER) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const supplier = await db.financial_Supplier.create({ data: { companyId: company.id, name: 'Andaimes Recife' } });
    const order = await db.service_Order.create({ data: {
      companyId: company.id, number: 'OS-2026-0001', year: 2026, sequence: 1, contractId: 9001, proposalId: 9001, customerId: 9001,
      title: 'Montagem de linha de vida', status: 'a_mobilizar', scope: [], checklist: [],
      budget: { revenue: 10000, cost: 4000, groups: [{ type: 'material', label: 'Materiais', cost: 1000 }, { type: 'locacao', label: 'Locações', cost: 500 }] },
    } });
    return { db, company, supplier, order };
  }

  const novo = (extra: Record<string, any> = {}) => ({
    title: 'Cabo de aço e grampos', group: 'material',
    items: [{ description: 'Cabo de aço 8mm', unit: 'm', quantity: 100, unitPrice: 6.5 }, { description: 'Grampo', quantity: 20, unitPrice: 2.5 }], ...extra,
  });
  const criar = (companyId: number, body: Record<string, any>, permissions?: string[]) => api().post('/purchase-orders').set(auth(companyId, permissions)).send(body);
  const mover = (companyId: number, id: number, body: Record<string, any>, permissions?: string[]) => api().patch(`/purchase-orders/${id}/status`).set(auth(companyId, permissions)).send(body);

  it('nasce solicitado, numerado, com o total somado dos itens', async () => {
    const { company, supplier, order } = await cenario();
    const res = await criar(company.id, novo({ supplierId: supplier.id, serviceOrderId: order.id, neededBy: '2026-12-01' })).expect(201);
    expect(res.body.number).toMatch(/^PDC-\d{4}-0001$/);
    expect(res.body.status).toBe('solicitado');
    expect(res.body.total).toBe(700);
    expect(res.body.items[0].total).toBe(650);
    expect(res.body.serviceOrder.number).toBe('OS-2026-0001');
    const second = await criar(company.id, novo()).expect(201);
    expect(second.body.number).toMatch(/-0002$/);

    await criar(company.id, novo({ items: [] })).expect(400);
    await criar(company.id, novo({ group: 'xpto' })).expect(400);
    await criar(company.id, novo({ title: '' })).expect(400);
    await criar(company.id, novo({ items: [{ description: 'Sem valor', quantity: 1, unitPrice: 0 }] })).expect(400);
    await criar(company.id, novo(), ['list_pedidos_de_compra']).expect(403);
  });

  it('só aprova e recusa quem tem a permissão de aprovação', async () => {
    const { company, db } = await cenario();
    const { body } = await criar(company.id, novo()).expect(201);
    await mover(company.id, body.id, { status: 'aprovado' }, BASE).expect(403);
    await mover(company.id, body.id, { status: 'recusado', note: 'caro' }, BASE).expect(403);
    await mover(company.id, body.id, { status: 'recusado' }).expect(400); // sem motivo
    const approved = await mover(company.id, body.id, { status: 'aprovado' }).expect(200);
    expect(approved.body.status).toBe('aprovado');
    expect(approved.body.approvedBy).toBeTruthy();
    // aprovado não muda itens; voltar para solicitado zera a aprovação
    await api().put(`/purchase-orders/${body.id}`).set(auth(company.id)).send({ items: novo().items }).expect(409);
    await mover(company.id, body.id, { status: 'solicitado' }, BASE).expect(200);
    const row = await db.purchase_Order.findUnique({ where: { id: body.id } });
    expect(row.approvedByUserId).toBeNull();
    await api().put(`/purchase-orders/${body.id}`).set(auth(company.id, BASE)).send({ items: [{ description: 'Cabo', quantity: 2, unitPrice: 10 }] }).expect(200);
    expect(Number((await db.purchase_Order.findUnique({ where: { id: body.id } })).total)).toBe(20);
    // não pula etapa
    await mover(company.id, body.id, { status: 'comprado', firstDueDate: '2026-12-10' }).expect(409);
  });

  it('mostra ao aprovador o orçado do grupo, o comprometido e o que sobra', async () => {
    const { company, order } = await cenario();
    const first = (await criar(company.id, novo({ serviceOrderId: order.id })).expect(201)).body;
    await mover(company.id, first.id, { status: 'aprovado' }).expect(200);
    const second = (await criar(company.id, novo({ serviceOrderId: order.id, items: [{ description: 'Parafusos', quantity: 1, unitPrice: 400 }] })).expect(201)).body;
    const seen = await api().get(`/purchase-orders/${second.id}`).set(auth(company.id)).expect(200);
    expect(seen.body.budget).toEqual({ group: 'Materiais', budgetLabel: 'Materiais', budget: 1000, committed: 700, thisOrder: 400, remaining: -100 });
    // sem aprovar nem ver custos, o orçamento não aparece
    const hidden = await api().get(`/purchase-orders/${second.id}`).set(auth(company.id, BASE)).expect(200);
    expect(hidden.body.budget).toBeNull();
    // a obra enxerga o comprometido (só o aprovado conta) e o que ainda espera aprovação
    const os = await api().get(`/purchase-orders/service-order/${order.id}`).set(auth(company.id)).expect(200);
    expect(os.body.committed).toBe(700);
    expect(os.body.pending).toBe(400);
    expect(os.body.rows).toHaveLength(2);
  });

  it('comprar gera as contas a pagar das parcelas; receber encerra', async () => {
    const { company, db, supplier, order } = await cenario();
    const { body } = await criar(company.id, novo({ serviceOrderId: order.id })).expect(201);
    await mover(company.id, body.id, { status: 'aprovado' }).expect(200);
    // sem fornecedor não compra
    await mover(company.id, body.id, { status: 'comprado', firstDueDate: '2026-12-10' }).expect(400);
    await api().put(`/purchase-orders/${body.id}`).set(auth(company.id)).send({ supplierId: supplier.id }).expect(200);
    await mover(company.id, body.id, { status: 'comprado' }).expect(400); // sem vencimento
    const bought = await mover(company.id, body.id, { status: 'comprado', installments: 3, firstDueDate: '2026-12-10', paymentMethod: 'boleto' }).expect(200);
    expect(bought.body.status).toBe('comprado');
    expect(bought.body.payables.map((p: any) => p.value)).toEqual([233.33, 233.33, 233.34]);
    expect(bought.body.payables.map((p: any) => p.dueDate)).toEqual(['2026-12-10', '2027-01-10', '2027-02-10']);
    const payables = await db.financial_Payable.findMany({ where: { purchaseOrderId: body.id } });
    expect(payables.every((p) => p.origin === 'pedido_compra' && p.supplierId === supplier.id && p.serviceOrderId === order.id && p.status === 'aberta')).toBe(true);
    expect(payables[0].description).toContain(body.number);
    // aparece em Contas a Pagar
    const list = await api().get('/financial-payables?origin=pedido_compra').set(auth(company.id)).expect(200);
    expect(list.body.total).toBe(3);

    await mover(company.id, body.id, { status: 'recebido', date: '2099-01-01' }).expect(400);
    const received = await mover(company.id, body.id, { status: 'recebido', invoiceNumber: 'NF 123' }).expect(200);
    expect(received.body.status).toBe('recebido');
    expect(received.body.invoiceNumber).toBe('NF 123');
    expect(received.body.events.map((e: any) => e.to)).toEqual(['solicitado', 'aprovado', 'comprado', 'recebido']);
  });

  it('desfazer a compra tira as contas a pagar, a menos que alguma já esteja paga', async () => {
    const { company, db, supplier } = await cenario();
    const { body } = await criar(company.id, novo({ supplierId: supplier.id })).expect(201);
    await mover(company.id, body.id, { status: 'aprovado' }).expect(200);
    await mover(company.id, body.id, { status: 'comprado', installments: 2, firstDueDate: '2026-12-10' }).expect(200);
    const [first] = await db.financial_Payable.findMany({ where: { purchaseOrderId: body.id }, orderBy: { id: 'asc' } });
    await api().patch(`/financial-payables/settle/${first.id}`).set(auth(company.id)).send({}).expect(200);
    await mover(company.id, body.id, { status: 'cancelado', note: 'desistimos' }).expect(409);
    await mover(company.id, body.id, { status: 'aprovado' }).expect(409);
    await api().patch(`/financial-payables/unsettle/${first.id}`).set(auth(company.id)).send({}).expect(200);
    await mover(company.id, body.id, { status: 'cancelado' }).expect(400); // sem motivo
    await mover(company.id, body.id, { status: 'cancelado', note: 'desistimos' }).expect(200);
    expect(await db.financial_Payable.count({ where: { purchaseOrderId: body.id, inactiveAt: null } })).toBe(0);
    // cancelado não conta como comprometido
    const list = await api().get('/purchase-orders').set(auth(company.id)).expect(200);
    expect(list.body.total).toBe(0);
    expect(list.body.summary.cancelado.count).toBe(1);
  });

  it('cadastro rápido de fornecedor e isolamento entre empresas', async () => {
    const { company, order } = await cenario();
    const created = await api().post('/purchase-orders/suppliers').set(auth(company.id)).send({ name: 'Ferragens Boa Vista', document: '11.222.333/0001-81' }).expect(201);
    expect(created.body.document).toBe('11222333000181');
    await api().post('/purchase-orders/suppliers').set(auth(company.id)).send({ name: 'Outro', document: '11222333000181' }).expect(409);
    const options = await api().get('/purchase-orders/options').set(auth(company.id)).expect(200);
    expect(options.body.suppliers.map((s: any) => s.name)).toContain('Ferragens Boa Vista');
    expect(options.body.serviceOrders).toHaveLength(1);

    const { body } = await criar(company.id, novo()).expect(201);
    const other = await makeCompany();
    await api().get(`/purchase-orders/${body.id}`).set(auth(other.id)).expect(404);
    await mover(other.id, body.id, { status: 'aprovado' }).expect(404);
    await criar(other.id, novo({ serviceOrderId: order.id })).expect(400);
    await criar(other.id, novo({ supplierId: created.body.id })).expect(400);
  });
});
