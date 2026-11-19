import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { rentalsFromContract } from 'src/features/stock/rental.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Estoque (fases 3 a 7): peças com inspeção e vida útil, bloqueio na saída,
 * calibração, corte de corda, perda na obra, EPI, locação a cliente,
 * inventário, loja e Minha esteira.
 */
describe('Estoque — equipamentos, EPI, locação e inventário (e2e)', () => {
  const ALL = [
    'list_itens_estoque', 'create_itens_estoque', 'update_itens_estoque', 'movimentar_estoque', 'ajuste_estoque', 'view_ajuste_estoque', 'custos_estoque',
    'list_equipamentos', 'update_equipamentos', 'inactive_equipamentos', 'view_inspecoes_equipamentos', 'inspecoes_equipamentos',
    'view_entregas_epi', 'list_entregas_epi', 'create_entregas_epi', 'list_locacoes', 'create_locacoes', 'update_locacoes', 'update_financeiro',
    'list_ordens_de_servico', 'all_ordens_de_servico', 'view_custos_comercial', 'create_loja_site',
  ];
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
  const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const order = await db.service_Order.create({ data: {
      companyId: company.id, number: 'OS-2026-0001', year: 2026, sequence: 1, contractId: 9001, proposalId: 9001, customerId: 9001,
      title: 'Resgate em espaço confinado', status: 'em_execucao', scope: [], checklist: [], plannedEnd: new Date('2099-01-01T00:00:00.000Z'),
      budget: { revenue: 10000, cost: 3000, groups: [{ type: 'material', label: 'Materiais', cost: 1000 }] },
    } });
    const supplier = await db.financial_Supplier.create({ data: { companyId: company.id, name: 'Laboratório Gás Certo' } });
    const main = (await api().get('/stock/locations').set(auth(company.id)).expect(200)).body[0];
    return { db, company, order, supplier, main };
  }
  const post = (companyId: number, path: string, body: unknown, permissions?: string[]) => api().post(path).set(auth(companyId, permissions)).send(body as object);

  it('corda por unidade: nasce esperando inspeção, só sai inspecionada, volta para inspeção, reprova e é baixada', async () => {
    const { company, main, order, db } = await cenario();
    const corda = (await post(company.id, '/stock/items', { name: 'Corda semiestática 11mm 50m', preset: 'reutilizavel', lifeMonths: 60, lifeFrom: 'primeiro_uso' }).expect(201)).body;
    expect(corda).toMatchObject({ tracking: 'unidade', returnable: true, requiresInspection: true, inspectionIntervalDays: 180 });
    await post(company.id, '/stock/movements', { type: 'entrada_avulsa', locationId: main.id, lines: [{ itemId: corda.id, unitCost: 900, units: [{ serialNumber: 'SN-1', manufacturedAt: '2026-01-10' }, { serialNumber: 'SN-2' }] }] }).expect(201);
    let units = (await api().get('/stock/units').set(auth(company.id)).expect(200)).body.rows;
    expect(units.map((u: any) => [u.tag, u.status])).toEqual([[`${corda.code}-001`, 'em_inspecao'], [`${corda.code}-002`, 'em_inspecao']]);
    const [u1, u2] = units;

    // esperando inspeção: não sai
    const dispatch = (unitId: number) => post(company.id, `/stock/service-orders/${order.id}/dispatch`, { locationId: main.id, lines: [{ itemId: corda.id, unitId }] });
    expect((await dispatch(u1.id).expect(409)).body.message).toContain('esperando inspeção');
    // inspeção de recebimento com item "não OK" não pode ser aprovada
    const templates = (await api().get('/stock/inspection-templates').set(auth(company.id)).expect(200)).body;
    const roteiro = templates.find((t: any) => t.name.startsWith('Corda'));
    const answers = Object.fromEntries(roteiro.items.filter((q: any) => q.kind === 'ok_nok').map((q: any) => [q.key, 'ok']));
    await post(company.id, '/stock/inspections', { unitId: u1.id, kind: 'recebimento', result: 'aprovado', templateId: roteiro.id, answers: { ...answers, capa: 'nok' } }).expect(400);
    const insp = (await post(company.id, '/stock/inspections', { unitId: u1.id, kind: 'recebimento', result: 'aprovado', templateId: roteiro.id, answers }).expect(201)).body;
    expect(insp.unit.status).toBe('disponivel');
    expect(insp.nextDueAt).toBeTruthy();

    // sai para a obra: primeiro uso marca o fim da vida (60 meses)
    await dispatch(u1.id).expect(201);
    let unit = (await api().get(`/stock/units/${u1.id}`).set(auth(company.id)).expect(200)).body;
    expect(unit).toMatchObject({ status: 'em_uso', holderType: 'os', firstUseAt: today() });
    expect(unit.lifeEndsAt.slice(0, 4)).toBe(String(Number(today().slice(0, 4)) + 5));
    const panel = (await api().get(`/stock/service-orders/${order.id}`).set(auth(company.id)).expect(200)).body;
    expect(panel.units[0].tag).toBe(u1.tag);
    expect(panel.cost.total).toBe(0); // equipamento que volta não é custo da obra

    // volta da obra: esperando inspeção de novo
    await post(company.id, `/stock/service-orders/${order.id}/return`, { locationId: main.id, lines: [{ itemId: corda.id, unitId: u1.id, condition: 'ok' }] }).expect(201);
    unit = (await api().get(`/stock/units/${u1.id}`).set(auth(company.id)).expect(200)).body;
    expect(unit.status).toBe('em_inspecao');
    // reprovada: bloqueia; liberar à mão não vale para item com inspeção
    await post(company.id, '/stock/inspections', { unitId: u1.id, kind: 'periodica', result: 'reprovado', templateId: roteiro.id, answers: { ...answers, alma: 'nok' } }).expect(400); // sem contar o que achou
    await post(company.id, '/stock/inspections', { unitId: u1.id, kind: 'periodica', result: 'reprovado', templateId: roteiro.id, answers: { ...answers, alma: 'nok' }, notes: 'Ponto duro na alma a 12 m' }).expect(201);
    expect((await api().get(`/stock/units/${u1.id}`).set(auth(company.id))).body.status).toBe('bloqueado');
    await api().patch(`/stock/units/${u1.id}/state`).set(auth(company.id)).send({ action: 'liberar' }).expect(409);
    // baixa com motivo; a ficha continua
    await post(company.id, `/stock/units/${u1.id}/retire`, { reason: 'reprovado', note: 'Cortada e descartada' }).expect(200);
    unit = (await api().get(`/stock/units/${u1.id}`).set(auth(company.id)).expect(200)).body;
    expect(unit).toMatchObject({ status: 'baixado', retiredReason: 'reprovado' });
    expect(unit.timeline.length).toBeGreaterThanOrEqual(5);
    expect((await db.stock_Balance.aggregate({ where: { itemId: corda.id }, _sum: { quantity: true } }))._sum.quantity.toNumber()).toBe(1);

    // inspeção vencida bloqueia; extraordinária também
    await post(company.id, '/stock/inspections', { unitId: u2.id, kind: 'recebimento', result: 'aprovado', templateId: roteiro.id, answers, date: '2025-01-01', nextDueAt: '2025-06-01' }).expect(201);
    expect((await dispatch(u2.id).expect(409)).body.message).toContain('inspeção vencida');
    await post(company.id, '/stock/inspections', { unitId: u2.id, kind: 'periodica', result: 'aprovado', templateId: roteiro.id, answers }).expect(201);
    await api().patch(`/stock/units/${u2.id}/state`).set(auth(company.id, ['inspecoes_equipamentos'])).send({ action: 'extraordinaria', note: 'Segurou uma queda' }).expect(200);
    expect((await dispatch(u2.id).expect(409)).body.message).toContain('extraordinária');

    // vencimentos e Minha esteira
    const dues = (await api().get('/stock/dues').set(auth(company.id)).query({ days: 4000 }).expect(200)).body;
    expect(dues.rows.some((r: any) => r.type === 'vida_util')).toBe(false); // a peça viva ainda não tem primeiro uso
    const pipeline = (await api().get('/my-pipeline').set(auth(company.id)).expect(200)).body;
    expect(pipeline.blocks.map((b: any) => b.key)).toContain('estoque_inspecoes');
  });

  it('detector: calibração vencida bloqueia; envio ao laboratório e retorno com certificado; pedido de compra ligado', async () => {
    const { company, main, order, supplier } = await cenario();
    const detector = (await post(company.id, '/stock/items', { name: 'Detector 4 gases', preset: 'calibravel', calibrationIntervalMonths: 6, rentable: true, rentMonthly: 800 }).expect(201)).body;
    await post(company.id, '/stock/movements', { type: 'entrada_avulsa', locationId: main.id, lines: [{ itemId: detector.id, unitCost: 5000, units: [{ serialNumber: 'DG-77' }] }] }).expect(201);
    const unit = (await api().get('/stock/units').set(auth(company.id))).body.rows[0];
    expect(unit.status).toBe('disponivel');
    const out = await post(company.id, `/stock/service-orders/${order.id}/dispatch`, { locationId: main.id, lines: [{ itemId: detector.id, unitId: unit.id }] }).expect(409);
    expect(out.body.message).toContain('calibração vencida');

    const sent = (await post(company.id, `/stock/units/${unit.id}/service`, { kind: 'calibracao', supplierId: supplier.id }).expect(201)).body;
    expect(sent.status).toBe('enviado');
    expect((await api().get(`/stock/units/${unit.id}`).set(auth(company.id))).body).toMatchObject({ status: 'em_calibracao', holderType: 'fornecedor', holder: 'Laboratório Gás Certo' });
    // o pedido de compra aberto pelo envio fica ligado
    const pdc = (await post(company.id, '/purchase-orders', { title: 'Calibração DG-77', group: 'outros', supplierId: supplier.id, stockServiceEventId: sent.id, items: [{ description: 'Calibração', quantity: 1, unitPrice: 350 }] },
      [...ALL, 'create_pedidos_de_compra', 'list_pedidos_de_compra']).expect(201)).body;
    expect((await api().get(`/stock/services/${sent.id}`).set(auth(company.id))).body.purchaseOrder.number).toBe(pdc.number);

    await post(company.id, `/stock/services/${sent.id}/return`, { result: 'aprovado', certificateNumber: 'CERT-2026-118', cost: 350 }).expect(200);
    const back = (await api().get(`/stock/units/${unit.id}`).set(auth(company.id))).body;
    expect(back).toMatchObject({ status: 'disponivel', holder: main.name });
    expect(back.nextCalibrationAt > today()).toBe(true);
    expect(back.services[0]).toMatchObject({ certificateNumber: 'CERT-2026-118', result: 'aprovado' });
    await post(company.id, `/stock/service-orders/${order.id}/dispatch`, { locationId: main.id, lines: [{ itemId: detector.id, unitId: unit.id }] }).expect(201);
  });

  it('corte de corda e perda na obra (o custo da peça entra no resultado)', async () => {
    const { company, main, order } = await cenario();
    const corda = (await post(company.id, '/stock/items', { name: 'Corda dinâmica', tracking: 'unidade', returnable: true }).expect(201)).body;
    await post(company.id, '/stock/movements', { type: 'entrada_avulsa', locationId: main.id, lines: [{ itemId: corda.id, unitCost: 1000, units: [{ length: 100 }, {}] }] }).expect(201);
    const [big, other] = (await api().get('/stock/units').set(auth(company.id))).body.rows;
    await post(company.id, `/stock/units/${big.id}/cut`, { lengths: [60, 50] }).expect(400);
    const cut = (await post(company.id, `/stock/units/${big.id}/cut`, { lengths: [60, 40] }).expect(200)).body;
    expect(cut.pieces.map((p: any) => [p.tag, p.length])).toEqual([[`${big.tag}-A`, 60], [`${big.tag}-B`, 40]]);
    const piece = (await api().get(`/stock/units/${cut.pieces[0].id}`).set(auth(company.id))).body;
    expect(piece).toMatchObject({ status: 'disponivel', acquisitionCost: 600, origin: { tag: big.tag } });

    await post(company.id, `/stock/service-orders/${order.id}/dispatch`, { locationId: main.id, lines: [{ itemId: corda.id, unitId: other.id }] }).expect(201);
    await post(company.id, `/stock/units/${other.id}/retire`, { reason: 'perda' }).expect(400);
    await post(company.id, `/stock/units/${other.id}/retire`, { reason: 'perda', note: 'Caiu no tanque' }).expect(200);
    const result = (await api().get(`/service-orders/${order.id}/result`).set(auth(company.id)).expect(200)).body;
    const material = result.lines.find((l: any) => l.key === 'material');
    expect(material.realized).toBe(1000);
    expect(material.note).toContain('equipamento perdido');
  });

  it('EPI: entrega com assinatura, ficha, troca e pendência do desligado', async () => {
    const { company, main, db } = await cenario();
    const joao = await db.hr_Employee.create({ data: { companyId: company.id, name: 'João Silva' } });
    const luva = (await post(company.id, '/stock/items', { name: 'Luva de vaqueta', preset: 'epi', caNumber: '12345', caExpiry: '2020-01-01', replaceEveryDays: 30 }).expect(201)).body;
    await post(company.id, '/stock/movements', { type: 'entrada_avulsa', locationId: main.id, lines: [{ itemId: luva.id, quantity: 10, unitCost: 15 }] }).expect(201);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const given = (await post(company.id, '/stock/ppe/deliveries', { employeeId: joao.id, locationId: main.id, reason: 'admissao', lines: [{ itemId: luva.id, quantity: 2 }], signatureName: 'João Silva', signatureImage: png }).expect(201)).body;
    expect(given.warnings.join(' ')).toContain('CA 12345');
    const image = await api().get(`/stock/ppe/signatures/${given.movementId}`).set(auth(company.id)).expect(200);
    expect(image.headers['content-type']).toBe('image/png');

    let mine = (await api().get(`/stock/ppe/employees/${joao.id}`).set(auth(company.id)).expect(200)).body;
    expect(mine.holding[0]).toMatchObject({ item: 'Luva de vaqueta', quantity: 2, caState: 'vencido' });
    const sheet = (await api().get(`/stock/ppe/employees/${joao.id}/sheet`).set(auth(company.id)).expect(200)).body;
    expect(sheet.entries[0]).toMatchObject({ type: 'Entrega', caNumber: '12345', signed: true, signedBy: 'João Silva' });

    // troca: descarta 1 e entrega 1
    await post(company.id, '/stock/ppe/exchanges', { employeeId: joao.id, locationId: main.id, discard: true, returnLines: [{ itemId: luva.id, quantity: 1 }], lines: [{ itemId: luva.id, quantity: 1 }] }).expect(201);
    mine = (await api().get(`/stock/ppe/employees/${joao.id}`).set(auth(company.id))).body;
    expect(mine.holding[0].quantity).toBe(2);
    expect((await api().get(`/stock/items/${luva.id}`).set(auth(company.id))).body.inStock).toBe(7);

    // desligado: não recebe e aparece nas pendências
    await db.hr_Employee.update({ where: { id: joao.id }, data: { terminationDate: new Date('2026-01-01T00:00:00.000Z') } });
    await post(company.id, '/stock/ppe/deliveries', { employeeId: joao.id, locationId: main.id, lines: [{ itemId: luva.id, quantity: 1 }] }).expect(409);
    const pending = (await api().get('/stock/ppe/pending').set(auth(company.id)).expect(200)).body;
    expect(pending[0]).toMatchObject({ kind: 'desligado', employee: 'João Silva' });
  });

  it('locação: reserva, conflito de peça, entrega, cobra o período, devolve com falta e encerra', async () => {
    const { company, main, db } = await cenario();
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } });
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } });
    const customer = await db.customer.create({ data: { name: 'Indústria Alfa', corporateName: 'Indústria Alfa SA', cnpj: '11222333000181', companyId: company.id, rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id } });
    const tripe = (await post(company.id, '/stock/items', { name: 'Tripé de resgate', tracking: 'unidade', returnable: true, rentable: true, rentDaily: 100, replacementValue: 4000 }).expect(201)).body;
    const cinto = (await post(company.id, '/stock/items', { name: 'Cinta de ancoragem', returnable: true, rentable: true, replacementValue: 90 }).expect(201)).body;
    await post(company.id, '/stock/movements', { type: 'entrada_avulsa', locationId: main.id, lines: [{ itemId: tripe.id, unitCost: 3000, units: [{}] }, { itemId: cinto.id, quantity: 5, unitCost: 60 }] }).expect(201);
    const unit = (await api().get('/stock/units').set(auth(company.id))).body.rows[0];

    const start = '2026-11-01';
    // a tela do estoque não cria mais locação (toda locação nasce da proposta); as antigas continuam operáveis
    await post(company.id, '/stock/rentals', { customerId: customer.id, startDate: start, expectedEnd: '2026-11-03', period: 'dia', lines: [{ itemId: tripe.id, unitId: unit.id, rate: 100 }] }).expect(409);
    const legacy = (number: string, sequence: number, lines: Array<{ itemId: number; unitId?: number; quantity: number; rate: number }>, startDate = start, expectedEnd: string | null = '2026-11-03') => db.stock_Rental.create({ data: {
      companyId: company.id, number, year: 2026, sequence, customerId: customer.id, status: 'reservada', startDate: new Date(`${startDate}T00:00:00.000Z`),
      expectedEnd: expectedEnd ? new Date(`${expectedEnd}T00:00:00.000Z`) : null, period: 'dia', billing: 'periodo', lines: { createMany: { data: lines } },
    } });
    const created = await legacy('OL-2026-0001', 1, [{ itemId: tripe.id, unitId: unit.id, quantity: 1, rate: 100 }, { itemId: cinto.id, quantity: 2, rate: 10 }]);
    const rental = (await api().get(`/stock/rentals/${created.id}`).set(auth(company.id)).expect(200)).body;
    expect(rental).toMatchObject({ number: 'OL-2026-0001', status: 'reservada', stage: 'a_entregar', ratePerPeriod: 120, fromContract: false });
    // outra locação antiga não reserva a mesma peça no mesmo período
    const other = await legacy('OL-2026-0002', 2, [{ itemId: cinto.id, quantity: 1, rate: 10 }], '2026-11-02', null);
    await api().put(`/stock/rentals/${other.id}`).set(auth(company.id)).send({ lines: [{ itemId: tripe.id, unitId: unit.id, rate: 100 }] }).expect(409);
    await api().patch(`/stock/rentals/${other.id}/status`).set(auth(company.id)).send({ status: 'cancelada', note: 'teste' }).expect(200);

    let r = (await post(company.id, `/stock/rentals/${rental.id}/deliver`, { locationId: main.id, date: start, receivedBy: 'Carlos (Alfa)' }).expect(200)).body;
    expect(r.status).toBe('ativa');
    expect((await api().get(`/stock/units/${unit.id}`).set(auth(company.id))).body.holderType).toBe('locacao');
    // cobra dia a dia: 1º período
    r = (await post(company.id, `/stock/rentals/${rental.id}/bill`, {}).expect(200)).body.rental;
    expect(r.charges[0]).toMatchObject({ kind: 'aluguel', value: 120, periodStart: start, periodEnd: start });
    expect(r.billedUntil).toBe(start);

    // devolve o tripé e só 1 cinta: a outra é falta (cobrada pelo valor de reposição)
    const lines = r.lines;
    r = (await post(company.id, `/stock/rentals/${rental.id}/return`, { locationId: main.id, date: '2026-11-03', lines: [
      { lineId: lines[0].id, condition: 'ok' }, { lineId: lines[1].id, quantity: 1, condition: 'ok' },
    ] }).expect(200)).body;
    expect(r.status).toBe('ativa');
    r = (await post(company.id, `/stock/rentals/${rental.id}/return`, { locationId: main.id, date: '2026-11-03', lines: [{ lineId: lines[1].id, condition: 'faltando' }] }).expect(200)).body;
    expect(r.status).toBe('devolvida');
    expect(r.charges.find((c: any) => c.kind === 'falta').value).toBe(90);
    await api().patch(`/stock/rentals/${rental.id}/status`).set(auth(company.id)).send({ status: 'encerrada' }).expect(409);
    // fatura os dias restantes (2 e 3) e a falta
    while ((await api().get(`/stock/rentals/${rental.id}`).set(auth(company.id))).body.nextPeriod) await post(company.id, `/stock/rentals/${rental.id}/bill`, {}).expect(200);
    await post(company.id, `/stock/rentals/${rental.id}/bill`, {}).expect(400); // nada mais a faturar (a falta foi junto)
    r = (await api().get(`/stock/rentals/${rental.id}`).set(auth(company.id)).expect(200)).body;
    expect(r.charges.filter((c: any) => c.kind === 'aluguel').map((c: any) => c.value)).toEqual([120, 120, 120]);
    expect(r.charges.every((c: any) => c.financialRecordId)).toBe(true);
    const records = await db.financialRecords.findMany({ where: { customerId: customer.id } });
    expect(records.reduce((s, x) => s + Number(x.value), 0)).toBe(450);
    r = (await api().patch(`/stock/rentals/${rental.id}/status`).set(auth(company.id)).send({ status: 'encerrada' }).expect(200)).body;
    expect(r.status).toBe('encerrada');
    expect((await api().get(`/stock/units/${unit.id}`).set(auth(company.id))).body.status).toBe('disponivel');

    // venda com item "locação a cliente" cria a locação reservada
    const proposal = await db.commercial_Proposal.create({ data: { companyId: company.id, number: 'P-2026-0001', year: 2026, sequence: 1, customerId: customer.id, title: 'Locação de tripé', referenceDate: new Date('2026-11-15T00:00:00.000Z'), snapshot: {} } as any });
    const section = await db.commercial_ProposalSection.create({ data: { companyId: company.id, proposalId: proposal.id, title: 'Locações', kind: 'locacao_cliente', margin: 0 } as any });
    await db.commercial_ProposalItem.create({ data: { companyId: company.id, proposalId: proposal.id, sectionId: section.id, type: 'locacao_cliente', description: 'Tripé', quantity: 1, stockItemId: tripe.id, extra: { period: 'mes', periods: 2, rate: 1500 } } as any });
    const contract = await db.commercial_Contract.create({ data: { companyId: company.id, number: 'CT-2026-0001', year: 2026, sequence: 1, proposalId: proposal.id, customerId: customer.id, kind: 'servico', title: 'Locação', value: 3000, acceptedAt: new Date(), startDate: new Date('2026-12-01T00:00:00.000Z') } as any });
    await db.$transaction((tx) => rentalsFromContract(tx, contract.id));
    const fromSale = await db.stock_Rental.findFirst({ where: { contractId: contract.id }, include: { lines: true } });
    expect(fromSale).toMatchObject({ status: 'reservada' });
    expect(fromSale.expectedEnd.toISOString().slice(0, 10)).toBe('2027-01-31');
    expect(Number(fromSale.lines[0].rate)).toBe(1500);
    await post(company.id, `/stock/rentals/${fromSale.id}/bill`, {}).expect(409);
  });

  it('inventário às cegas: diferença vira ajuste; peça não achada fica bloqueada', async () => {
    const { company, main } = await cenario();
    const fita = (await post(company.id, '/stock/items', { name: 'Fita', unit: 'rolo' }).expect(201)).body;
    const polia = (await post(company.id, '/stock/items', { name: 'Polia', tracking: 'unidade', returnable: true }).expect(201)).body;
    await post(company.id, '/stock/movements', { type: 'entrada_avulsa', locationId: main.id, lines: [{ itemId: fita.id, quantity: 10, unitCost: 5 }, { itemId: polia.id, unitCost: 200, units: [{}, {}] }] }).expect(201);
    const count = (await post(company.id, '/stock/counts', { locationId: main.id, blindCount: true }).expect(201)).body;
    expect(count.lines.every((l: any) => l.expected === null)).toBe(true);
    await post(company.id, '/stock/counts', { locationId: main.id }).expect(409);
    const fitaLine = count.lines.find((l: any) => l.itemId === fita.id);
    const [p1] = count.lines.filter((l: any) => l.itemId === polia.id);
    await api().put(`/stock/counts/${count.id}`).set(auth(company.id)).send({ lines: [{ id: fitaLine.id, counted: 8 }], tag: p1.tag }).expect(200);
    const closed = (await post(company.id, `/stock/counts/${count.id}/close`, {}).expect(200)).body;
    expect(closed.status).toBe('fechada');
    expect(closed.lines.find((l: any) => l.itemId === fita.id)).toMatchObject({ expected: 10, counted: 8, difference: -2, value: -10 });
    expect((await api().get(`/stock/items/${fita.id}`).set(auth(company.id))).body.inStock).toBe(8);
    const units = (await api().get('/stock/units').set(auth(company.id))).body.rows;
    expect(units.find((u: any) => u.tag === p1.tag).status).toBe('disponivel');
    expect(units.find((u: any) => u.tag !== p1.tag).status).toBe('bloqueado');
  });

  it('loja: publicar cria o produto ligado; a rota pública diz pronta entrega ou sob encomenda', async () => {
    const { company, main } = await cenario();
    const capacete = (await post(company.id, '/stock/items', { name: 'Capacete com jugular', preset: 'epi' }).expect(201)).body;
    const product = (await post(company.id, `/stock/items/${capacete.id}/publish`, { price: 89.9 }).expect(201)).body;
    expect(product.name).toBe('Capacete com jugular');
    let availability = (await api().get('/stock/public/availability').expect(200)).body;
    expect(availability[String(product.id)]).toBe('sob_encomenda');
    await post(company.id, '/stock/movements', { type: 'entrada_avulsa', locationId: main.id, lines: [{ itemId: capacete.id, quantity: 3, unitCost: 40 }] }).expect(201);
    availability = (await api().get('/stock/public/availability').expect(200)).body;
    expect(availability[String(product.id)]).toBe('pronta_entrega');
    expect(JSON.stringify(availability)).not.toContain('3');
    await post(company.id, '/stock/movements', { type: 'venda', locationId: main.id, note: 'Venda balcão', lines: [{ itemId: capacete.id, quantity: 3 }] }).expect(201);
    availability = (await api().get('/stock/public/availability').expect(200)).body;
    expect(availability[String(product.id)]).toBe('sob_encomenda');
    const report = (await api().get('/stock/reports').set(auth(company.id)).expect(200)).body;
    expect(report.topItems[0]).toMatchObject({ name: 'Capacete com jugular', out: 3, value: 120 });
  });
});
