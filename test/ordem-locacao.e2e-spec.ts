import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Plano 08, fases 2 a 4: proposta de locação (período, "até devolver",
 * caução, frete, disponibilidade) → aceite → Ordem de Locação (OL) → entrega
 * com caução → faturamento por medição (períodos vencidos, avaria, frete) →
 * conta a receber com contrato e comissão de origem "locação" → devolução,
 * acerto da caução e encerramento. Lembretes no acompanhamento.
 */
describe('Locação pela proposta — OL e faturamento por medição (e2e)', () => {
  const ALL = [
    'list_comercial', 'create_comercial', 'update_comercial', 'view_custos_comercial',
    'list_itens_estoque', 'create_itens_estoque', 'update_itens_estoque', 'movimentar_estoque',
    'list_locacoes', 'create_locacoes', 'update_locacoes',
    'list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro',
  ];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    blockRealNetwork();
    jwt = (await bootTestApp()).get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());
  const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const addDays = (value: string, days: number) => { const d = new Date(`${value}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const addMonths = (value: string, months: number) => {
    const [y, m, d] = value.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
  };

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
    const h = auth(company.id);
    await api().get('/commercial/tax-profiles').set(h).expect(200);
    const main = (await api().get('/stock/locations').set(h).expect(200)).body[0];
    const tripe = (await api().post('/stock/items').set(h).send({
      name: 'Tripé com guincho 20 m', tracking: 'quantidade', returnable: true, rentable: true, replacementValue: 10050, lifeMonths: 60, rentMode: 'locacao',
    }).expect(201)).body;
    await api().post('/stock/movements').set(h).send({ type: 'entrada_avulsa', locationId: main.id, lines: [{ itemId: tripe.id, quantity: 2, unitCost: 8000 }] }).expect(201);
    return { db, company, customer, h, main, tripe };
  }

  const proposalBody = (customerId: number, itemId: number, quantity: number, rental: Record<string, unknown>) => ({
    kind: 'locacao', customerId, title: 'Tripé para parada', contingencyRate: 0, commission: { rate: 0.05, base: 'faturado' },
    // parcelas não valem para locação: ela é cobrada por medição
    installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 10 }],
    rental,
    sections: [
      { title: 'Equipamentos', kind: 'locacao_cliente', items: [{ type: 'locacao_cliente', stockItemId: itemId, quantity, extra: { period: 'dia', periods: 1, rate: 1000 } }] },
      { title: 'Frete e mobilização', kind: 'avulso', items: [{ type: 'avulso', description: 'Frete de ida e volta', quantity: 1, finalValue: 250 }] },
    ],
  });

  it('proposta → aceite → OL → entrega com caução → medição → conta a receber com comissão de locação → devolução, caução e encerramento', async () => {
    const { db, customer, h, main, tripe } = await cenario();
    const start = addDays(today(), -70);

    // proposta: 4 meses, cobrança mensal, caução; o período da proposta vale para as linhas
    const created = (await api().post('/commercial/proposals').set(h).send({ ...proposalBody(customer.id, tripe.id, 1, { period: 'mes', periods: 4, billing: 'periodo', deposit: 500, deliveryAddress: 'Av. do Porto, 100' }), referenceDate: start }).expect(201)).body;
    expect(created.draft.rental).toEqual({ period: 'mes', periods: 4, untilReturn: false, billing: 'periodo', deposit: 500, deliveryAddress: 'Av. do Porto, 100' });
    expect(created.draft.sections[0].items[0].extra).toMatchObject({ period: 'mes', periods: 4 });
    expect(created.draft.installments).toEqual([]);
    expect(created.calc.sections[0].lines[0].value).toBe(4000);
    expect(created.availability).toMatchObject({ ok: true, items: [{ itemId: tripe.id, requested: 1, available: 2, ok: true }] });
    const total = created.calc.totals.total;
    expect(total).toBe(4250);

    // pedir 3 tripés: só há 2
    const short = (await api().post('/commercial/proposals/preview').set(h).send(proposalBody(customer.id, tripe.id, 3, { period: 'mes', periods: 3 })).expect(201)).body;
    expect(short.availability).toMatchObject({ ok: false, items: [{ requested: 3, available: 2, ok: false }] });

    // o documento leva as condições da locação no lugar das parcelas
    const doc = (await api().post(`/commercial/proposals/${created.id}/document-preview`).set(h).send({}).expect(201)).body;
    expect(doc.html).toContain('Cobrança mensal');
    expect(doc.html).toContain('Caução de R$');

    // aceite: contrato por medição, sem parcelas e sem OS; nasce a OL a entregar, com o frete pendente
    await api().patch(`/commercial/proposals/status/${created.id}`).set(h).send({ status: 'enviada' }).expect(200);
    await api().patch(`/commercial/proposals/status/${created.id}`).set(h).send({ status: 'aceita' }).expect(200);
    const contract = await db.commercial_Contract.findFirstOrThrow({ where: { proposalId: created.id }, include: { installments: true } });
    expect(contract).toMatchObject({ kind: 'locacao', billingMode: 'periodo' });
    expect(contract.installments).toHaveLength(0);
    expect(await db.service_Order.count({ where: { contractId: contract.id } })).toBe(0);
    const ol = await db.stock_Rental.findFirstOrThrow({ where: { contractId: contract.id } });
    expect(ol).toMatchObject({ number: expect.stringMatching(/^OL-\d{4}-0001$/), status: 'reservada', periods: 4, billing: 'periodo', deliveryAddress: 'Av. do Porto, 100' });
    expect(Number(ol.deposit)).toBe(500);
    let rental = (await api().get(`/stock/rentals/${ol.id}`).set(h).expect(200)).body;
    expect(rental).toMatchObject({ stage: 'a_entregar', ratePerPeriod: 1000, pending: [] });
    expect(rental.charges).toEqual([expect.objectContaining({ kind: 'frete', value: 250, description: 'Frete de ida e volta' })]);

    // a tela avulsa do estoque não cria locação nova
    await api().post('/stock/rentals').set(h).send({ customerId: customer.id, startDate: start, lines: [{ itemId: tripe.id, quantity: 1 }] }).expect(409);

    // entrega há 70 dias: a caução vira conta a receber (fora do contrato e sem comissão)
    rental = (await api().post(`/stock/rentals/${ol.id}/deliver`).set(h).send({ locationId: main.id, date: start, receivedBy: 'Carlos' }).expect(200)).body;
    expect(rental).toMatchObject({ status: 'ativa', startDate: start, expectedEnd: addDays(addMonths(start, 4), -1) });
    const deposit = await db.financialRecords.findFirstOrThrow({ where: { description: { contains: 'Caução' } } });
    expect(Number(deposit.value)).toBe(500);
    expect(deposit.contractId).toBeNull();
    expect(rental.depositState).toMatchObject({ value: 500, settled: false, left: 500 });

    // dois períodos fecharam + o frete: é o que a medição leva
    const p1End = addDays(addMonths(start, 1), -1), p2Start = addMonths(start, 1), p2End = addDays(addMonths(start, 2), -1);
    expect(rental.pending.map((l: any) => [l.kind, l.periodStart, l.periodEnd, l.value])).toEqual([
      ['aluguel', start, p1End, 1000], ['aluguel', p2Start, p2End, 1000], ['frete', start, start, 250],
    ]);
    expect(rental.stage).toBe('ativa');

    // lembretes no acompanhamento: fim do período em curso e devolução prevista
    const reminders = await db.commercial_Activity.findMany({ where: { rentalId: ol.id, doneAt: null }, orderBy: { dueDate: 'asc' } });
    expect(reminders.map((r) => r.subject)).toEqual([
      expect.stringMatching(/^Fim do período da OL-.*faturar/), expect.stringMatching(/^Devolução prevista da OL-/),
    ]);
    const activities = (await api().get('/commercial/activities').set(h).query({ status: 'pendentes' }).expect(200)).body;
    expect(activities.rows[0]).toMatchObject({ rental: { id: ol.id, number: ol.number }, automatic: true, proposal: { id: created.id } });

    // A Faturar: uma linha da OL pronta para faturar
    let queue = (await api().get('/commercial/contracts/billing').set(h).expect(200)).body;
    expect(queue.rows.find((r: any) => r.id === `ol-${ol.id}`)).toMatchObject({ stage: 'liberada', source: 'medicao', value: 2250, contractId: contract.id });

    // faturar: nota obrigatória; cria a conta a receber com o contrato e a comissão proporcional
    await api().post(`/commercial/contracts/${contract.id}/measurements`).set(h).send({ rentalId: ol.id }).expect(400);
    const billed = (await api().post(`/commercial/contracts/${contract.id}/measurements`).set(h).send({ rentalId: ol.id, invoiceNumber: '1001', paymentMethod: 'boleto' }).expect(201)).body;
    expect(billed.billed).toMatchObject({ number: 'BM-01', value: 2250 });
    expect(billed.measurements).toHaveLength(1);
    const record = await db.financialRecords.findUniqueOrThrow({ where: { id: billed.billed.financialRecordId } });
    expect(record).toMatchObject({ contractId: contract.id, measurementId: billed.billed.measurementId, invoiceNumber: '1001', sellerId: userId, status: 'waiting' });
    expect(Number(record.value)).toBe(2250);
    const proposalRow = await db.commercial_Proposal.findUniqueOrThrow({ where: { id: created.id } });
    expect(Number(record.commissionValue)).toBeCloseTo((Number(proposalRow.commission) * 2250) / Number(proposalRow.total), 2);
    expect(Number(record.commissionValue)).toBeGreaterThan(0);
    const entry = await db.commercial_SellerWalletEntry.findUniqueOrThrow({ where: { financialRecordId: record.id } });
    expect(entry).toMatchObject({ origin: 'locacao', status: 'prevista', contractId: contract.id });
    expect(entry.description).toMatch(/^Comissão de locação/);

    // nada mais a faturar agora; o período em curso aparece como "aguardando"
    await api().post(`/commercial/contracts/${contract.id}/measurements`).set(h).send({ rentalId: ol.id, invoiceNumber: '1002' }).expect(409);
    rental = (await api().get(`/stock/rentals/${ol.id}`).set(h).expect(200)).body;
    expect(rental.billedUntil).toBe(p2End);
    expect(rental.pending).toEqual([]);
    queue = (await api().get('/commercial/contracts/billing').set(h).expect(200)).body;
    expect(queue.rows.filter((r: any) => r.contractId === contract.id).map((r: any) => [r.id, r.stage])).toEqual([
      [`op-${ol.id}`, 'aguardando'], [`bm-${billed.billed.measurementId}`, 'faturada'],
    ]);
    // o lembrete é do período em curso (o 3º): continua um só, pendente
    const periodReminders = await db.commercial_Activity.findMany({ where: { rentalId: ol.id, autoKey: { contains: 'periodo' } }, orderBy: { id: 'asc' } });
    expect(periodReminders.map((r) => [r.dueDate.toISOString().slice(0, 10), !!r.doneAt])).toEqual([[addDays(addMonths(start, 3), -1), false]]);

    // desfazer a medição volta tudo a pendente; faturar de novo
    await api().post(`/commercial/contracts/${contract.id}/measurements/${billed.billed.measurementId}/unbill`).set(h).expect(201);
    expect((await db.financialRecords.findUniqueOrThrow({ where: { id: record.id } })).status).toBe('cancelled');
    expect((await db.commercial_SellerWalletEntry.findUniqueOrThrow({ where: { financialRecordId: record.id } })).status).toBe('cancelada');
    rental = (await api().get(`/stock/rentals/${ol.id}`).set(h).expect(200)).body;
    expect(rental.pending.map((l: any) => l.kind)).toEqual(['aluguel', 'aluguel', 'frete']);
    expect(rental.billedUntil).toBeNull();
    const again = (await api().post(`/commercial/contracts/${contract.id}/measurements`).set(h).send({ rentalId: ol.id, invoiceNumber: '1001' }).expect(201)).body;
    expect(again.billed).toMatchObject({ number: 'BM-02', value: 2250 });

    // devolução hoje com avaria: período proporcional + avaria entram na próxima medição
    rental = (await api().post(`/stock/rentals/${ol.id}/return`).set(h).send({ locationId: main.id, date: today(), lines: [{ lineId: rental.lines[0].id, quantity: 1, condition: 'avariado', damageValue: 300 }] }).expect(200)).body;
    expect(rental.status).toBe('devolvida');
    expect(rental.pending.map((l: any) => l.kind)).toEqual(['aluguel', 'avaria']);
    const partial = rental.pending[0].value;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1000);
    expect(await db.commercial_Activity.count({ where: { rentalId: ol.id, doneAt: null } })).toBe(0);

    // encerrar sem faturar e sem acertar a caução: recusado
    await api().patch(`/stock/rentals/${ol.id}/status`).set(h).send({ status: 'encerrada' }).expect(409);

    // caução: cobre a avaria (300) e o resto (200) volta ao cliente como conta a pagar
    rental = (await api().post(`/stock/rentals/${ol.id}/deposit`).set(h).send({ mode: 'devolver' }).expect(200)).body;
    expect(rental.depositState).toMatchObject({ abated: 300, returned: 200, settled: true, left: 0 });
    expect(rental.pending.map((l: any) => [l.kind, l.value])).toEqual([['aluguel', partial], ['avaria', 300], ['abatimento', -300]]);
    const payable = await db.financial_Payable.findFirstOrThrow({ where: { origin: 'locacao' } });
    expect(Number(payable.value)).toBe(200);
    await api().post(`/stock/rentals/${ol.id}/deposit`).set(h).send({ mode: 'devolver' }).expect(409);

    const last = (await api().post(`/commercial/contracts/${contract.id}/measurements`).set(h).send({ rentalId: ol.id, invoiceNumber: '1003' }).expect(201)).body;
    expect(last.billed).toMatchObject({ number: 'BM-03', value: partial });
    rental = (await api().patch(`/stock/rentals/${ol.id}/status`).set(h).send({ status: 'encerrada' }).expect(200)).body;
    expect(rental.stage).toBe('encerrada');

    // o contrato soma o faturado pelas medições
    const view = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(view.billingMode).toBe('periodo');
    expect(view.measurements.map((m: any) => m.label)).toEqual(['BM-02', 'BM-03']);
    expect(view.billed).toBeCloseTo(2250 + partial, 2);
  });

  it('"até devolver" com pagamento único: sem data de devolução, cobra tudo de uma vez na devolução; esteira a devolver e atrasada', async () => {
    const { db, customer, h, main, tripe } = await cenario();
    const proposal = (await api().post('/commercial/proposals').set(h).send(proposalBody(customer.id, tripe.id, 1, { period: 'semana', periods: 2, untilReturn: true, billing: 'unico' })).expect(201)).body;
    expect(proposal.availability).toMatchObject({ end: null, ok: true });
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200);
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'aceita' }).expect(200);
    const ol = await db.stock_Rental.findFirstOrThrow({ where: { proposalId: proposal.id } });
    expect(ol.expectedEnd).toBeNull();
    expect(ol.periods).toBeNull();

    const start = addDays(today(), -20);
    let rental = (await api().post(`/stock/rentals/${ol.id}/deliver`).set(h).send({ locationId: main.id, date: start }).expect(200)).body;
    expect(rental.depositState).toBeNull();
    // ativa e sem data: só o frete está pendente (o aluguel sai na devolução)
    expect(rental.pending.map((l: any) => l.kind)).toEqual(['frete']);
    expect(rental.stage).toBe('ativa');

    // combinou a devolução para daqui a 3 dias: "a devolver"; data passada: "atrasada"
    rental = (await api().put(`/stock/rentals/${ol.id}`).set(h).send({ expectedEnd: addDays(today(), 3) }).expect(200)).body;
    expect(rental.stage).toBe('a_devolver');
    let list = (await api().get('/stock/rentals').set(h).query({ stage: 'a_devolver' }).expect(200)).body;
    expect(list.rows.map((r: any) => r.id)).toEqual([ol.id]);
    rental = (await api().put(`/stock/rentals/${ol.id}`).set(h).send({ expectedEnd: addDays(today(), -1) }).expect(200)).body;
    expect(rental.stage).toBe('atrasada');
    list = (await api().get('/stock/rentals').set(h).expect(200)).body;
    expect(list.summary).toMatchObject({ atrasada: 1 });

    // devolveu hoje: 21 dias = 3 semanas, de uma vez só
    rental = (await api().post(`/stock/rentals/${ol.id}/return`).set(h).send({ locationId: main.id, date: today(), lines: [{ lineId: rental.lines[0].id, quantity: 1, condition: 'ok' }] }).expect(200)).body;
    const rent = rental.pending.find((l: any) => l.kind === 'aluguel');
    expect(rent).toMatchObject({ periodStart: start, periodEnd: today(), value: 3000 });
    expect(rent.description).toMatch(/pagamento único na devolução/);
  });
});
