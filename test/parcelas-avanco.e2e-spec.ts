import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Plano 12: parcelas por avanço da obra (sem o modo "Medição de obra").
 *
 * Mobilização é só uma parcela; as outras vencem "ao atingir X% da obra",
 * lido dos RDOs fechados (avanço pesado pela duração das etapas). Nada trava:
 * a parcela fica "aguardando" até o marco, mas dá para faturar antes. Caução
 * contratual retida de cada nota numa conta própria, devolvida ao desfazer.
 */
describe('Parcelas por avanço da obra (e2e)', () => {
  const COMMERCIAL = ['list_comercial', 'create_comercial', 'update_comercial', 'inactive_comercial', 'activate_comercial', 'view_custos_comercial'];
  const FINANCE = ['list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro', 'activate_financeiro'];
  const ALL = [...COMMERCIAL, ...FINANCE, 'create_classes'];
  const YEAR = new Date().getFullYear();
  const TODAY = new Date().toISOString().slice(0, 10);
  let jwt: JwtService;
  let userId = 0;
  let cnpj = 0;
  let ipSeq = 0;

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
  const addDays = (date: string, days: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

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

  const total = (body: any) => body.calc.totals.total as number;
  const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

  async function proposta(measurement: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const customer = await makeCustomer(company.id);
    const h = auth(company.id);
    const options = (await api().get('/commercial/proposals/options').set(h).expect(200)).body;
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id;
    const created = (await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId: customer.id, title: 'Pintura da esfera', contactName: 'Maria Souza', workDays: 22, contingencyRate: 0,
      commission: { rate: 0.02, base: 'faturado' },
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 1 }] }],
      installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 28 }],
      schedule: { unit: 'dia', steps: [{ title: 'Jateamento', start: 1, duration: 10 }, { title: 'Pintura', start: 11, duration: 10 }] },
      ...(measurement ? { measurement } : {}), ...extra,
    }).expect(201)).body;
    return { company, customer, h, created };
  }
  async function aceitar(h: Record<string, string>, id: number) {
    await api().patch(`/commercial/proposals/status/${id}`).set(h).send({ status: 'enviada' }).expect(200);
    await api().patch(`/commercial/proposals/status/${id}`).set(h).send({ status: 'aceita' }).expect(200);
    const row = await testDb().commercial_Contract.findFirstOrThrow({ where: { proposalId: id } });
    return (await api().get(`/commercial/contracts/${row.id}`).set(h).expect(200)).body;
  }
  async function rdo(contractId: number, date: string, progress: Array<{ step: number; title: string; percent: number }>, status = 'fechado') {
    const db = testDb();
    const order = await db.service_Order.findUniqueOrThrow({ where: { contractId } });
    return db.service_DailyReport.create({ data: {
      companyId: order.companyId, orderId: order.id, date: new Date(`${date}T00:00:00.000Z`), status, weather: 'bom',
      crew: [{ name: 'João', role: 'Alpinista N1', hours: 8, overtime: 1 }, { name: 'Pedro', role: 'Alpinista N1', hours: 8, overtime: 0 }],
      activities: 'Jateamento do costado norte', progress, occurrences: [{ type: 'chuva', description: 'Parada por chuva', hoursLost: 2 }],
      photos: [{ url: 'https://example.com/foto.jpg', caption: 'Costado' }],
    } });
  }


  const series = [
    { description: 'Mobilização', percent: 0.3, dueRule: 'dias_apos_aceite', dueDays: 5 },
    { description: 'Metade da obra', percent: 0.5, dueRule: 'percentual_obra', workPercent: 50 },
    { description: 'Final', percent: 0.2, dueRule: 'percentual_obra', workPercent: 100 },
  ];

  it('mistura aceite e % da obra; marcos validados no envio; documento; contrato copia marcos e caução', async () => {
    const { h, created } = await proposta(undefined, { installments: series, depositRate: 0.05, depositReleaseDays: 30 });
    const T = total(created);
    expect(created.draft.installments.map((i: any) => [i.dueRule, i.workPercent, i.dueDays])).toEqual([['dias_apos_aceite', null, 5], ['percentual_obra', 50, null], ['percentual_obra', 100, null]]);
    expect(created.draft).toMatchObject({ depositRate: 0.05, depositReleaseDays: 30, measurement: null });
    expect(created.calc).toMatchObject({ installmentsDiff: 0, installmentsProblem: null });

    // marcos fora de ordem (ou zerados) aparecem no cálculo e impedem o envio
    const wrong = (await api().put(`/commercial/proposals/${created.id}`).set(h).send({ ...created.draft, installments: [series[0], { ...series[1], workPercent: 80 }, { ...series[2], workPercent: 60 }] }).expect(200)).body;
    expect(wrong.calc.installmentsProblem).toContain('precisam crescer');
    await api().patch(`/commercial/proposals/status/${created.id}`).set(h).send({ status: 'enviada' }).expect(400);
    await api().put(`/commercial/proposals/${created.id}`).set(h).send({ ...created.draft, installments: [series[0], { ...series[1], workPercent: 0 }, series[2]] }).expect(200);
    await api().patch(`/commercial/proposals/status/${created.id}`).set(h).send({ status: 'enviada' }).expect(400);
    await api().put(`/commercial/proposals/${created.id}`).set(h).send({ ...created.draft, installments: series }).expect(200);

    // o documento diz o marco e a caução
    const doc = (await api().post(`/commercial/proposals/${created.id}/document-preview`).set(h).send({}).expect(201)).body;
    expect(doc.html).toContain('ao atingir 50% da obra');
    expect(doc.html).toContain('ao atingir 100% da obra');
    expect(doc.html).toContain('Caução contratual: 5% de cada nota fiscal');

    const contract = await aceitar(h, created.id);
    expect(contract).toMatchObject({ billingMode: 'parcelas', deposit: { rate: 0.05, releaseDays: 30 }, workProgress: { percent: null } });
    expect(contract.installments.map((i: any) => [i.dueRule, i.work?.workPercent ?? null, i.value, i.depositValue])).toEqual([
      ['dias_apos_aceite', null, r2(T * 0.3), r2(r2(T * 0.3) * 0.05)],
      ['percentual_obra', 50, r2(T * 0.5), r2(r2(T * 0.5) * 0.05)],
      ['percentual_obra', 100, r2(T - r2(T * 0.3) - r2(T * 0.5)), r2(r2(T - r2(T * 0.3) - r2(T * 0.5)) * 0.05)],
    ]);
  });

  it('o RDO fechado libera a parcela; dá para faturar antes; caução retida e devolvida ao desfazer', async () => {
    const { h, created } = await proposta(undefined, { installments: series, depositRate: 0.05, depositReleaseDays: 30 });
    const contract = await aceitar(h, created.id);
    const db = testDb();
    const [mob, half, last] = contract.installments;
    const queue = async () => (await api().get('/commercial/contracts/billing').set(h).expect(200)).body.rows.filter((r: any) => r.contractId === contract.id && r.source === 'parcela');

    // sem RDO: as parcelas por % da obra esperam; a mobilização está liberada
    let rows = await queue();
    expect(rows.map((r: any) => r.stage)).toEqual(['liberada', 'aguardando', 'aguardando']);
    expect(rows[1].waitingFor).toBe('a obra chegar a 50% (sem RDO fechado)');

    // Jateamento (10 dias) 80% e Pintura (10 dias) 10% = 45% (rascunho com 100% não conta)
    await rdo(contract.id, '2026-11-02', [{ step: 0, title: 'Jateamento', percent: 80 }, { step: 1, title: 'Pintura', percent: 10 }]);
    await rdo(contract.id, '2026-11-03', [{ step: 0, title: 'Jateamento', percent: 100 }, { step: 1, title: 'Pintura', percent: 100 }], 'rascunho');
    rows = await queue();
    expect(rows[1]).toMatchObject({ stage: 'aguardando', waitingFor: 'a obra chegar a 50% (agora em 45%)', work: { workProgress: 45, reached: false } });

    // RDO fechado chega a 60%: a parcela dos 50% fica pronta (com a data em que cruzou)
    await rdo(contract.id, '2026-11-05', [{ step: 0, title: 'Jateamento', percent: 100 }, { step: 1, title: 'Pintura', percent: 20 }]);
    rows = await queue();
    expect(rows.map((r: any) => r.stage)).toEqual(['liberada', 'liberada', 'aguardando']);
    expect(rows[1].work).toMatchObject({ workProgress: 60, reached: true, reachedAt: '2026-11-05' });
    const detail = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(detail.workProgress).toEqual({ percent: 60, date: '2026-11-05' });

    // a parcela final (100%) ainda não chegou, mas o cliente pediu: fatura mesmo assim, na data combinada
    const due = addDays(TODAY, 10);
    const billed = (await api().post(`/commercial/contracts/${contract.id}/installments/${last.id}/bill`).set(h)
      .send({ invoiceNumber: 'NF-900', dueDate: due, retentions: [{ tax: 'iss', rate: 5 }] }).expect(201)).body;
    const record = await db.financialRecords.findUniqueOrThrow({ where: { id: billed.financialRecordId } });
    const dep = r2(last.value * 0.05);
    // a receber = nota − caução; ISS sobre o valor da nota
    expect(Number(record.value)).toBe(r2(last.value - dep));
    expect(Number(record.netValue)).toBe(r2(last.value - dep - r2(last.value * 0.05)));
    expect(record.dueDate?.toISOString().slice(0, 10)).toBe(due);
    let fresh = await db.commercial_Contract.findUniqueOrThrow({ where: { id: contract.id } });
    const depositRecord = await db.financialRecords.findUniqueOrThrow({ where: { id: fresh.depositRecordId! } });
    expect(Number(depositRecord.value)).toBe(dep);

    // segunda nota soma na mesma conta da caução
    await api().post(`/commercial/contracts/${contract.id}/installments/${half.id}/bill`).set(h).send({ invoiceNumber: 'NF-901' }).expect(201);
    expect(Number((await db.financialRecords.findUniqueOrThrow({ where: { id: fresh.depositRecordId! } })).value)).toBe(r2(dep + r2(half.value * 0.05)));

    // desfazer devolve a caução daquela nota; desfazer a outra cancela a conta da caução
    await api().post(`/commercial/contracts/${contract.id}/installments/${last.id}/unbill`).set(h).expect(201);
    expect(Number((await db.financialRecords.findUniqueOrThrow({ where: { id: fresh.depositRecordId! } })).value)).toBe(r2(half.value * 0.05));
    await api().post(`/commercial/contracts/${contract.id}/installments/${half.id}/unbill`).set(h).expect(201);
    expect((await db.financialRecords.findUniqueOrThrow({ where: { id: depositRecord.id } })).status).toBe('cancelled');
    fresh = await db.commercial_Contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(fresh.depositRecordId).toBeNull();
    expect(mob.dueRule).toBe('dias_apos_aceite');
  });

  it('"% da obra" só vale no serviço: no treinamento vira "dias após a NF"', async () => {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const customer = await makeCustomer(company.id);
    const h = auth(company.id);
    const course = await makeCourse(company.id);
    const created = (await api().post('/commercial/proposals').set(h).send({
      kind: 'treinamento', customerId: customer.id, title: 'NR-35', contingencyRate: 0,
      sections: [{ title: 'Treinamento', kind: 'treinamento', margin: 0.2, items: [{ type: 'treinamento', courseId: course.id, quantity: 1, finalValue: 1000 }] }],
      installments: [{ percent: 1, dueRule: 'percentual_obra', workPercent: 50 }], depositRate: 0.1,
    }).expect(201)).body;
    expect(created.draft.installments[0]).toMatchObject({ dueRule: 'dias_apos_nf', workPercent: null });
    expect(created.draft.depositRate).toBe(0);
  });
});
