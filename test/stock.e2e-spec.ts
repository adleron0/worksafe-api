import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Estoque (fases 1 e 2): catálogo, saldo, custo médio, estorno, obra (romaneio,
 * retorno, consumo) e o pedido de compra entrando no estoque sem contar em dobro.
 */
describe('Estoque (e2e)', () => {
  const ALL = [
    'list_itens_estoque', 'create_itens_estoque', 'update_itens_estoque', 'inactive_itens_estoque', 'activate_itens_estoque',
    'movimentar_estoque', 'ajuste_estoque', 'custos_estoque', 'list_ordens_de_servico', 'all_ordens_de_servico', 'view_custos_comercial',
    'list_pedidos_de_compra', 'create_pedidos_de_compra', 'update_pedidos_de_compra', 'approve_pedidos_de_compra',
  ];
  const FIELD = ['movimentar_estoque', 'list_ordens_de_servico', 'all_ordens_de_servico'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => { jwt = (await bootTestApp()).get(JwtService); });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions: string[] = ALL) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const order = await db.service_Order.create({ data: {
      companyId: company.id, number: 'OS-2026-0001', year: 2026, sequence: 1, contractId: 9001, proposalId: 9001, customerId: 9001,
      title: 'Pintura de linha de vida', status: 'em_execucao', scope: [], checklist: [{ id: 'a', title: 'Separar materiais', done: false, doneAt: null, doneBy: null }],
      budget: { revenue: 10000, cost: 3000, groups: [{ type: 'material', label: 'Materiais', cost: 1000 }] },
    } });
    const supplier = await db.financial_Supplier.create({ data: { companyId: company.id, name: 'Tintas Recife' } });
    const locations = (await api().get('/stock/locations').set(auth(company.id)).expect(200)).body;
    const second = (await api().post('/stock/locations').set(auth(company.id)).send({ name: 'Container base Suape', kind: 'container' }).expect(201)).body;
    return { db, company, order, supplier, main: locations[0], second };
  }
  const item = async (companyId: number, body: Record<string, unknown>) => (await api().post('/stock/items').set(auth(companyId)).send(body).expect(201)).body;
  const entrada = (companyId: number, locationId: number, lines: unknown[], type = 'entrada_avulsa') =>
    api().post('/stock/movements').set(auth(companyId)).send({ type, locationId, lines });

  it('cadastra item pelo modelo, dá entrada, calcula o custo médio e recusa saldo negativo', async () => {
    const { company, main, second } = await cenario();
    expect(main.name).toBe('Almoxarifado');
    const category = (await api().post('/stock/categories').set(auth(company.id)).send({ name: 'Tintas', prefix: 'tin' }).expect(201)).body;
    const tinta = await item(company.id, { name: 'Tinta epóxi amarela', unit: 'l', categoryId: category.id, preset: 'consumivel', minQuantity: 10 });
    expect(tinta.code).toBe('TIN-0001');
    expect(tinta.tracking).toBe('quantidade');
    expect(tinta.returnable).toBe(false);

    await entrada(company.id, main.id, [{ itemId: tinta.id, quantity: 10, unitCost: 20 }]).expect(201);
    await entrada(company.id, main.id, [{ itemId: tinta.id, quantity: 10, unitCost: 30 }]).expect(201);
    let detail = (await api().get(`/stock/items/${tinta.id}`).set(auth(company.id)).expect(200)).body;
    expect(detail.inStock).toBe(20);
    expect(detail.averageCost).toBe(25);
    // sem a permissão de custo, o médio não aparece
    detail = (await api().get(`/stock/items/${tinta.id}`).set(auth(company.id, ['list_itens_estoque'])).expect(200)).body;
    expect(detail.averageCost).toBeNull();

    // transferência e saldo insuficiente
    await api().post('/stock/movements').set(auth(company.id)).send({ type: 'transferencia', locationId: main.id, toLocationId: second.id, lines: [{ itemId: tinta.id, quantity: 5 }] }).expect(201);
    await api().post('/stock/movements').set(auth(company.id)).send({ type: 'transferencia', locationId: second.id, toLocationId: main.id, lines: [{ itemId: tinta.id, quantity: 6 }] }).expect(409);
    const balances = (await api().get('/stock/balances').set(auth(company.id)).query({ itemId: tinta.id }).expect(200)).body;
    expect(balances.rows.map((r: any) => [r.holder, r.quantity])).toEqual([['Almoxarifado', 15], ['Container base Suape', 5]]);
    expect(balances.value).toBe(500);

    // ajuste pede a permissão e o motivo
    await api().post('/stock/movements').set(auth(company.id, FIELD)).send({ type: 'ajuste', locationId: main.id, note: 'contagem', lines: [{ itemId: tinta.id, quantity: -1 }] }).expect(403);
    await api().post('/stock/movements').set(auth(company.id)).send({ type: 'ajuste', locationId: main.id, lines: [{ itemId: tinta.id, quantity: -1 }] }).expect(400);
    await api().post('/stock/movements').set(auth(company.id)).send({ type: 'ajuste', locationId: main.id, note: 'Lata furada', lines: [{ itemId: tinta.id, quantity: -1 }] }).expect(201);

    // abaixo do mínimo (19 < 10? não; consome até ficar abaixo)
    await api().post('/stock/movements').set(auth(company.id)).send({ type: 'consumo_interno', locationId: main.id, lines: [{ itemId: tinta.id, quantity: 12 }] }).expect(201);
    const reorder = (await api().get('/stock/reorder').set(auth(company.id)).expect(200)).body;
    expect(reorder).toHaveLength(1);
    expect(reorder[0].available).toBe(7);

    // não inativa local com saldo
    await api().patch(`/stock/locations/${second.id}/inactive`).set(auth(company.id)).expect(409);
    // kardex do item, do mais novo para o mais velho
    const kardex = (await api().get(`/stock/items/${tinta.id}/movements`).set(auth(company.id)).expect(200)).body;
    expect(kardex.rows[0].typeLabel).toBe('Consumo interno');
    expect(kardex.rows[0].inStockAfter).toBe(7);
  });

  it('estorna uma movimentação e recalcula o médio; estorno não se estorna', async () => {
    const { company, main } = await cenario();
    const tinta = await item(company.id, { name: 'Solvente', unit: 'l' });
    await entrada(company.id, main.id, [{ itemId: tinta.id, quantity: 10, unitCost: 10 }]).expect(201);
    const second = (await entrada(company.id, main.id, [{ itemId: tinta.id, quantity: 10, unitCost: 30 }]).expect(201)).body;
    expect((await api().get(`/stock/items/${tinta.id}`).set(auth(company.id))).body.averageCost).toBe(20);
    const reversal = (await api().post(`/stock/movements/${second.id}/reverse`).set(auth(company.id)).send({}).expect(200)).body;
    expect(reversal.type).toBe('estorno');
    const detail = (await api().get(`/stock/items/${tinta.id}`).set(auth(company.id))).body;
    expect(detail.inStock).toBe(10);
    expect(detail.averageCost).toBe(10);
    await api().post(`/stock/movements/${second.id}/reverse`).set(auth(company.id)).send({}).expect(409);
    await api().post(`/stock/movements/${reversal.id}/reverse`).set(auth(company.id)).send({}).expect(409);
  });

  it('duas saídas ao mesmo tempo não passam do saldo', async () => {
    const { company, main, order } = await cenario();
    const tinta = await item(company.id, { name: 'Fita zebrada', unit: 'rolo' });
    await entrada(company.id, main.id, [{ itemId: tinta.id, quantity: 5, unitCost: 3 }]).expect(201);
    const send = () => api().post(`/stock/service-orders/${order.id}/dispatch`).set(auth(company.id)).send({ locationId: main.id, lines: [{ itemId: tinta.id, quantity: 4 }] });
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const detail = (await api().get(`/stock/items/${tinta.id}`).set(auth(company.id))).body;
    expect(detail.inStock).toBe(1);
    expect(detail.out).toBe(4);
  });

  it('obra: romaneio cobra o consumível, a sobra abate, o resto vira consumo; o resultado da OS soma', async () => {
    const { company, main, order, db } = await cenario();
    const tinta = await item(company.id, { name: 'Tinta', unit: 'l' });
    const cinta = await item(company.id, { name: 'Cinta de ancoragem', unit: 'un', returnable: true });
    await entrada(company.id, main.id, [{ itemId: tinta.id, quantity: 20, unitCost: 25 }, { itemId: cinta.id, quantity: 4, unitCost: 80 }]).expect(201);

    // o encarregado (sem ver custo) dá a saída
    const out = (await api().post(`/stock/service-orders/${order.id}/dispatch`).set(auth(company.id, FIELD))
      .send({ locationId: main.id, receivedBy: 'José encarregado', lines: [{ itemId: tinta.id, quantity: 10 }, { itemId: cinta.id, quantity: 2 }] }).expect(201)).body;
    expect(out.number).toMatch(/^MOV-\d{4}-\d{5}$/);
    expect(out.lines.find((l: any) => l.itemId === tinta.id).chargedToOrder).toBe(true);
    expect(out.lines.find((l: any) => l.itemId === cinta.id).chargedToOrder).toBe(false);
    expect(out.signature.name).toBe('José encarregado');
    expect((await db.service_Order.findUnique({ where: { id: order.id } })).checklist[0].done).toBe(true);

    let panel = (await api().get(`/stock/service-orders/${order.id}`).set(auth(company.id)).expect(200)).body;
    expect(panel.atOrder.map((r: any) => [r.item, r.quantity])).toEqual(expect.arrayContaining([['Tinta', 10], ['Cinta de ancoragem', 2]]));
    expect(panel.cost.total).toBe(250);

    // sobra de 3 litros volta e abate 75
    await api().post(`/stock/service-orders/${order.id}/return`).set(auth(company.id, FIELD))
      .send({ locationId: main.id, lines: [{ itemId: tinta.id, quantity: 3 }, { itemId: cinta.id, quantity: 2, condition: 'ok' }] }).expect(201);
    panel = (await api().get(`/stock/service-orders/${order.id}`).set(auth(company.id)).expect(200)).body;
    expect(panel.cost).toMatchObject({ sent: 250, returned: 75, total: 175 });
    // o que ficou é dado como consumido, sem cobrar de novo
    await api().post(`/stock/service-orders/${order.id}/consume`).set(auth(company.id, FIELD)).send({}).expect(201);
    panel = (await api().get(`/stock/service-orders/${order.id}`).set(auth(company.id)).expect(200)).body;
    expect(panel.atOrder).toEqual([]);
    expect(panel.cost.total).toBe(175);

    const result = (await api().get(`/service-orders/${order.id}/result`).set(auth(company.id)).expect(200)).body;
    const material = result.lines.find((l: any) => l.key === 'material');
    expect(material.realized).toBe(175);
    expect(material.note).toContain('saíram do estoque');
  });

  it('pedido de compra sem obra: recebe em partes no local, vira recebido e desfaz se nada saiu', async () => {
    const { company, main, second, supplier } = await cenario();
    const luva = await item(company.id, { name: 'Luva de vaqueta', unit: 'par', purchaseUnit: 'cx', purchaseFactor: 12 });
    const pdc = (await api().post('/purchase-orders').set(auth(company.id)).send({
      title: 'Reposição de luvas', group: 'material', supplierId: supplier.id,
      items: [{ description: 'Luva de vaqueta (caixa com 12)', unit: 'cx', quantity: 2, unitPrice: 120, itemId: luva.id }, { description: 'Frete', quantity: 1, unitPrice: 30 }],
    }).expect(201)).body;
    expect(pdc.items[0].itemId).toBe(luva.id);
    await api().patch(`/purchase-orders/${pdc.id}/status`).set(auth(company.id)).send({ status: 'aprovado' }).expect(200);
    await api().patch(`/purchase-orders/${pdc.id}/status`).set(auth(company.id)).send({ status: 'comprado', firstDueDate: '2026-12-10' }).expect(200);

    // chega 1 caixa no container
    let res = (await api().post(`/purchase-orders/${pdc.id}/receive`).set(auth(company.id)).send({ lines: [{ index: 0, quantity: 1, locationId: second.id }] }).expect(201)).body;
    expect(res.status).toBe('comprado');
    expect(res.items[0].receivedQuantity).toBe(1);
    await api().post(`/purchase-orders/${pdc.id}/receive`).set(auth(company.id)).send({ lines: [{ index: 0, quantity: 2 }] }).expect(409);
    res = (await api().post(`/purchase-orders/${pdc.id}/receive`).set(auth(company.id)).send({ lines: [{ index: 0, quantity: 1, locationId: main.id }] }).expect(201)).body;
    expect(res.status).toBe('recebido');
    let detail = (await api().get(`/stock/items/${luva.id}`).set(auth(company.id))).body;
    expect(detail.inStock).toBe(24);
    expect(detail.averageCost).toBe(10);
    const history = (await api().get(`/stock/items/${luva.id}/purchases`).set(auth(company.id))).body;
    expect(history[0]).toMatchObject({ number: pdc.number, received: 2, supplier: 'Tintas Recife' });

    // desfaz o recebimento: as entradas são estornadas
    res = (await api().patch(`/purchase-orders/${pdc.id}/status`).set(auth(company.id)).send({ status: 'comprado' }).expect(200)).body;
    expect(res.items[0].receivedQuantity).toBe(0);
    detail = (await api().get(`/stock/items/${luva.id}`).set(auth(company.id))).body;
    expect(detail.inStock).toBe(0);

    // recebe tudo pelo botão simples; consome parte; aí não dá mais para desfazer
    await api().patch(`/purchase-orders/${pdc.id}/status`).set(auth(company.id)).send({ status: 'recebido', locationId: main.id }).expect(200);
    await api().post('/stock/movements').set(auth(company.id)).send({ type: 'consumo_interno', locationId: main.id, lines: [{ itemId: luva.id, quantity: 20 }] }).expect(201);
    await api().patch(`/purchase-orders/${pdc.id}/status`).set(auth(company.id)).send({ status: 'comprado' }).expect(409);
  });

  it('pedido de compra com obra entra na posição da obra sem contar em dobro; a sobra abate', async () => {
    const { company, main, order, supplier } = await cenario();
    const tinta = await item(company.id, { name: 'Tinta PU', unit: 'l' });
    const pdc = (await api().post('/purchase-orders').set(auth(company.id)).send({
      title: 'Tinta para a obra', group: 'material', supplierId: supplier.id, serviceOrderId: order.id,
      items: [{ description: 'Tinta PU', unit: 'l', quantity: 10, unitPrice: 40, itemId: tinta.id }],
    }).expect(201)).body;
    await api().patch(`/purchase-orders/${pdc.id}/status`).set(auth(company.id)).send({ status: 'aprovado' }).expect(200);
    await api().patch(`/purchase-orders/${pdc.id}/status`).set(auth(company.id)).send({ status: 'comprado', firstDueDate: '2026-12-10' }).expect(200);
    await api().patch(`/purchase-orders/${pdc.id}/status`).set(auth(company.id)).send({ status: 'recebido' }).expect(200);

    let panel = (await api().get(`/stock/service-orders/${order.id}`).set(auth(company.id)).expect(200)).body;
    expect(panel.atOrder[0]).toMatchObject({ item: 'Tinta PU', quantity: 10 });
    expect(panel.cost.total).toBe(0);
    let material = (await api().get(`/service-orders/${order.id}/result`).set(auth(company.id))).body.lines.find((l: any) => l.key === 'material');
    expect(material.realized).toBe(400);

    await api().post(`/stock/service-orders/${order.id}/return`).set(auth(company.id)).send({ locationId: main.id, lines: [{ itemId: tinta.id, quantity: 2 }] }).expect(201);
    panel = (await api().get(`/stock/service-orders/${order.id}`).set(auth(company.id)).expect(200)).body;
    expect(panel.cost.total).toBe(-80);
    material = (await api().get(`/service-orders/${order.id}/result`).set(auth(company.id))).body.lines.find((l: any) => l.key === 'material');
    expect(material.realized).toBe(320);
  });

  it('carga inicial por planilha cria categoria, local e item e lança o saldo', async () => {
    const { company } = await cenario();
    const csv = 'código;nome;categoria;unidade;controle;quantidade;local;custo\n;Corda estática 11mm;Cordas;m;quantidade;200;Almoxarifado;8,50\nTIN-9;Tinta branca;Tintas;l;;12;Base Suape;30\n;Sem quantidade;Tintas;un;;;;\n';
    const result = (await api().post('/stock/import').set(auth(company.id)).send({ csv }).expect(200)).body;
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ items: 3, categories: 2, locations: 1, lines: 2 });
    const list = (await api().get('/stock/items').set(auth(company.id)).expect(200)).body;
    expect(list.rows.find((r: any) => r.code === 'TIN-9').inStock).toBe(12);
    expect(list.value).toBe(2060);
  });
});
