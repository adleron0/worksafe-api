import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Plano 08, fase 8: faturamento por medição de obra.
 *
 * Proposta de serviço com medição (frentes do cronograma, mobilização como
 * etapa própria ou adiantamento amortizado, caução contratual) → contrato por
 * medição → boletim (BM) com o % de cada frente sugerido pelo RDO → enviado ao
 * cliente, contestado, revisto e aprovado pelo link → faturado (NF, retenções,
 * caução numa conta própria) → desfazer, liberar a caução, A Faturar.
 */
describe('Medição de obra — boletim de medição (e2e)', () => {
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

  it('etapa de mobilização + frentes + caução: BM sugerido pelo RDO, contestado, aprovado pelo link e faturado com retenção', async () => {
    const { h, created, company } = await proposta({ mode: 'medicao', mobilization: { mode: 'etapa', rate: 0.3 }, depositRate: 0.05, depositReleaseDays: 30 });
    const db = testDb();
    const T = total(created);
    // frentes nascem das etapas do cronograma, com peso pela duração; parcelas não valem
    expect(created.draft.measurement).toEqual({
      mode: 'medicao', depositRate: 0.05, depositReleaseDays: 30, mobilization: { mode: 'etapa', rate: 0.3 },
      fronts: [{ step: 0, title: 'Jateamento', weight: 0.5, rule: 'percentual' }, { step: 1, title: 'Pintura', weight: 0.5, rule: 'percentual' }],
    });
    expect(created.draft.installments).toEqual([]);
    const mob = r2(T * 0.3), half = r2((T - mob) / 2);
    expect(created.calc.measurementPlan).toMatchObject({ problem: null, mobilization: { mode: 'etapa', value: mob }, fronts: [{ id: 1, value: half }, { id: 2, value: r2(T - mob - half) }] });

    // pesos que não fecham 100% não deixam enviar
    await api().put(`/commercial/proposals/${created.id}`).set(h).send({ ...created.draft, measurement: { ...created.draft.measurement, fronts: [{ title: 'Jateamento', step: 0, weight: 0.4 }, { title: 'Pintura', step: 1, weight: 0.5, rule: 'conclusao' }] } }).expect(200);
    await api().patch(`/commercial/proposals/status/${created.id}`).set(h).send({ status: 'enviada' }).expect(400);
    await api().put(`/commercial/proposals/${created.id}`).set(h).send({ ...created.draft, measurement: { ...created.draft.measurement, fronts: [{ title: 'Jateamento', step: 0, weight: 0.5 }, { title: 'Pintura', step: 1, weight: 0.5, rule: 'conclusao' }] } }).expect(200);
    // o documento troca as parcelas pelas condições da medição
    const doc = (await api().post(`/commercial/proposals/${created.id}/document-preview`).set(h).send({}).expect(201)).body;
    expect(doc.html).toContain('Faturamento por medição');
    expect(doc.html).toContain('Mobilização de 30%');
    expect(doc.html).toContain('Caução contratual de 5%');

    const contract = await aceitar(h, created.id);
    expect(contract).toMatchObject({ billingMode: 'medicao', installments: [], toBill: T, works: { measurements: [], summary: { measured: 0, balance: T } } });
    expect(contract.measurementPlan.fronts.map((f: any) => [f.id, f.title, f.rule, f.value])).toEqual([[1, 'Jateamento', 'percentual', half], [2, 'Pintura', 'conclusao', r2(T - mob - half)]]);
    expect(contract.serviceOrder).toBeTruthy();

    // RDO fechado: Jateamento 40% e depois 60% (rascunho não conta)
    await rdo(contract.id, '2026-11-02', [{ step: 0, title: 'Jateamento', percent: 40 }, { step: 1, title: 'Pintura', percent: 0 }]);
    await rdo(contract.id, '2026-11-03', [{ step: 0, title: 'Jateamento', percent: 60 }, { step: 1, title: 'Pintura', percent: 20 }]);
    await rdo(contract.id, '2026-11-04', [{ step: 0, title: 'Jateamento', percent: 90 }, { step: 1, title: 'Pintura', percent: 20 }], 'rascunho');
    const sug = (await api().get(`/commercial/contracts/${contract.id}/works/suggestion?periodEnd=2026-11-10`).set(h).expect(200)).body;
    expect(sug).toMatchObject({ periodEnd: '2026-11-10', rdoDate: '2026-11-03', hasOrder: true });
    expect(sug.fronts.map((f: any) => [f.id, f.prevPercent, f.rdoPercent, f.percent])).toEqual([[1, 0, 60, 60], [2, 0, 20, 20]]);

    // BM-01: mobilização (30%) + 60% do jateamento; a pintura (só ao concluir) não entra; caução de 5%
    const c1 = (await api().post(`/commercial/contracts/${contract.id}/works`).set(h).send({ periodStart: '2026-11-01', periodEnd: '2026-11-10', fronts: [{ id: 1, percent: 60 }, { id: 2, percent: 20 }] }).expect(201)).body;
    expect(c1.created.number).toBe('BM-01');
    const f1 = r2(half * 0.6), dep1 = r2((mob + f1) * 0.05);
    let bm = c1.works.measurements[0];
    expect(bm).toMatchObject({ label: 'BM-01', status: 'rascunho', invoiceValue: r2(mob + f1), depositValue: dep1, value: r2(mob + f1 - dep1) });
    expect(bm.lines.map((l: any) => [l.kind, l.prevPercent ?? null, l.accPercent ?? null, l.value])).toEqual([
      ['mobilizacao', null, null, mob], ['frente', 0, 60, f1], ['frente', 0, 0, 0], ['caucao', null, null, -dep1],
    ]);
    // um boletim em aberto por vez; não fatura sem aprovação
    await api().post(`/commercial/contracts/${contract.id}/works`).set(h).send({}).expect(409);
    await api().post(`/commercial/contracts/${contract.id}/works/${bm.id}/bill`).set(h).send({ invoiceNumber: 'NF-1' }).expect(409);
    // o acumulado não volta
    await api().put(`/commercial/contracts/${contract.id}/works/${bm.id}`).set(h).send({ fronts: [{ id: 1, percent: 120 }] }).expect(400);

    // enviado ao cliente: o link mostra o boletim e o relatório do período (RDOs fechados)
    const sent = (await api().post(`/commercial/contracts/${contract.id}/works/${bm.id}/send`).set(h).expect(201)).body;
    const key = sent.sent.publicKey;
    let pub = (await api().get(`/commercial/public/measurements/${key}`).expect(200)).body;
    expect(pub).toMatchObject({ label: 'BM-01', status: 'enviada', canDecide: true, invoiceValue: r2(mob + f1), contract: { number: contract.number } });
    expect(pub.rdo).toMatchObject({ reports: 2, hours: 32, overtime: 2, hoursLost: 4, roles: [{ role: 'Alpinista N1', people: 4, hours: 32 }] });
    expect(pub.rdo.photos).toHaveLength(2);
    expect(pub.contract.customer).toEqual({ name: 'Indústria Alfa' });
    // contestar exige explicação
    await api().post(`/commercial/public/measurements/${key}/decision`).send({ decision: 'contestar', name: 'Maria Souza' }).expect(400);
    pub = (await api().post(`/commercial/public/measurements/${key}/decision`).set('X-Forwarded-For', '192.0.2.7').send({ decision: 'contestar', name: 'Maria Souza', note: 'O jateamento está em 50%' }).expect(201)).body;
    expect(pub).toMatchObject({ status: 'contestada', canDecide: false, decision: { decision: 'contestada', name: 'Maria Souza', note: 'O jateamento está em 50%', ip: '192.0.2.7' } });
    // revisto: 50%; volta a rascunho e é reenviado; o cliente aprova
    await api().put(`/commercial/contracts/${contract.id}/works/${bm.id}`).set(h).send({ fronts: [{ id: 1, percent: 50 }, { id: 2, percent: 20 }] }).expect(200);
    await api().post(`/commercial/contracts/${contract.id}/works/${bm.id}/send`).set(h).expect(201);
    await api().post(`/commercial/public/measurements/${key}/decision`).send({ decision: 'aprovar', name: 'Maria Souza', role: 'Fiscal' }).expect(201);
    await api().post(`/commercial/public/measurements/${key}/decision`).send({ decision: 'aprovar', name: 'Maria Souza' }).expect(409);

    // aprovado → A Faturar (liberada)
    let queue = (await api().get('/commercial/contracts/billing').set(h).expect(200)).body;
    expect(queue.rows.filter((r: any) => r.contractId === contract.id).map((r: any) => [r.id, r.stage, r.source])).toEqual([[`bw-${bm.id}`, 'liberada', 'obra']]);

    // faturar: NF no valor medido; a conta a receber é a nota menos a caução; ISS retido sobre a nota
    const f1b = r2(half * 0.5), inv1 = r2(mob + f1b), dep1b = r2(inv1 * 0.05);
    const billed = (await api().post(`/commercial/contracts/${contract.id}/works/${bm.id}/bill`).set(h).send({ invoiceNumber: 'NF-100', retentions: [{ tax: 'iss', rate: 5 }] }).expect(201)).body;
    expect(billed.billed).toMatchObject({ number: 'BM-01', value: r2(inv1 - dep1b) });
    const rec = await db.financialRecords.findUniqueOrThrow({ where: { id: billed.billed.financialRecordId }, include: { retentions: true } });
    expect(Number(rec.value)).toBe(r2(inv1 - dep1b));
    expect(Number(rec.netValue)).toBe(r2(inv1 - dep1b - r2(inv1 * 0.05)));
    expect(rec.retentions.map((x) => [x.tax, Number(x.base), Number(x.value)])).toEqual([['iss', inv1, r2(inv1 * 0.05)]]);
    expect(rec).toMatchObject({ contractId: contract.id, measurementId: bm.id, invoiceNumber: 'NF-100' });
    expect(Number(rec.commissionValue)).toBeGreaterThan(0);
    // caução numa conta a receber própria, vencendo depois do fim da obra
    let after = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(after.works.summary).toMatchObject({ measured: inv1, invoiced: inv1, deposit: dep1b, balance: r2(T - inv1), depositRecord: { value: dep1b, status: 'waiting' } });
    const depositId = after.works.summary.depositRecord.id;

    // BM-02 (aprovação registrada à mão): jateamento 100%, pintura concluída → fecha o contrato
    const c2 = (await api().post(`/commercial/contracts/${contract.id}/works`).set(h).send({ periodEnd: '2026-11-20', fronts: [{ id: 1, percent: 100 }, { id: 2, percent: 100 }] }).expect(201)).body;
    bm = c2.works.measurements[1];
    expect(bm).toMatchObject({ label: 'BM-02', periodStart: '2026-11-11', periodEnd: '2026-11-20' });
    await api().post(`/commercial/contracts/${contract.id}/works/${bm.id}/approve`).set(h).send({ name: '' }).expect(400);
    await api().post(`/commercial/contracts/${contract.id}/works/${bm.id}/approve`).set(h).send({ name: 'Maria Souza', note: 'Aprovado por e-mail' }).expect(201);
    // com BM-02 em aberto, BM-01 não pode ser desfeito
    await api().post(`/commercial/contracts/${contract.id}/measurements/${c1.works.measurements[0].id}/unbill`).set(h).expect(409);
    const inv2 = r2(T - inv1), dep2 = r2(inv2 * 0.05);
    await api().post(`/commercial/contracts/${contract.id}/works/${bm.id}/bill`).set(h).send({ invoiceNumber: 'NF-101' }).expect(201);
    after = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(after.works.summary).toMatchObject({ measured: T, invoiced: T, balance: 0, deposit: r2(dep1b + dep2), depositRecord: { id: depositId, value: r2(dep1b + dep2) } });
    // contas a receber do contrato somam o contrato inteiro (boletins + caução)
    const all = await db.financialRecords.findMany({ where: { contractId: contract.id, inactiveAt: null } });
    expect(r2(all.reduce((s, x) => s + Number(x.value), 0))).toBe(T);

    // desfazer o BM-02: a conta é cancelada, a caução volta, o boletim fica aprovado
    await api().post(`/commercial/contracts/${contract.id}/measurements/${bm.id}/unbill`).set(h).expect(201);
    after = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(after.works.measurements[1].status).toBe('aprovada');
    expect(after.works.summary.depositRecord.value).toBe(dep1b);
    // excluir o BM-02 e liberar a caução para hoje
    await api().delete(`/commercial/contracts/${contract.id}/works/${bm.id}`).set(h).expect(200);
    await api().put(`/commercial/contracts/${contract.id}/deposit`).set(h).send({ dueDate: '2027-01-15' }).expect(200);
    expect((await db.financialRecords.findUniqueOrThrow({ where: { id: depositId } })).dueDate!.toISOString().slice(0, 10)).toBe('2027-01-15');
    // sem permissão de financeiro não fatura; outra empresa não acessa
    await api().post(`/commercial/contracts/${contract.id}/works`).set(h).send({ periodEnd: '2026-11-25', fronts: [{ id: 1, percent: 80 }] }).expect(201);
    const open = (await api().get(`/commercial/contracts/${contract.id}`).set(h)).body.works.measurements[1];
    await api().post(`/commercial/contracts/${contract.id}/works/${open.id}/bill`).set(auth(company.id, COMMERCIAL)).send({ invoiceNumber: 'X' }).expect(403);
    const other = await makeCompany();
    await api().get(`/commercial/contracts/${contract.id}/works/${open.id}/report`).set(auth(other.id)).expect(404);
    const report = (await api().get(`/commercial/contracts/${contract.id}/works/${open.id}/report`).set(h).expect(200)).body;
    expect(report).toMatchObject({ label: 'BM-02', status: 'rascunho', contract: { number: contract.number } });
  });

  it('adiantamento amortizado: passa a venda de parcelas para medição; adiantamento no início e abatido até zerar', async () => {
    const { h, created } = await proposta(undefined);
    const T = total(created);
    const contract = await aceitar(h, created.id);
    expect(contract).toMatchObject({ billingMode: 'parcelas' });
    expect(contract.installments).toHaveLength(1);
    await api().put(`/commercial/contracts/${contract.id}/measurement-plan`).set(h).send({ plan: { fronts: [{ title: 'Obra', weight: 0.9 }] } }).expect(400);
    const switched = (await api().put(`/commercial/contracts/${contract.id}/measurement-plan`).set(h).send({ plan: { mobilization: { mode: 'adiantamento', rate: 0.3 }, fronts: [{ title: 'Obra toda', weight: 1 }] } }).expect(200)).body;
    expect(switched).toMatchObject({ billingMode: 'medicao', installments: [] });
    expect(switched.measurementPlan).toMatchObject({ mobilization: { mode: 'adiantamento', value: r2(T * 0.3) }, fronts: [{ id: 1, value: T }] });
    const adv = r2(T * 0.3);
    const bill = async (percent: number, end: string, nf: string) => {
      const c = (await api().post(`/commercial/contracts/${contract.id}/works`).set(h).send({ periodEnd: end, fronts: [{ id: 1, percent }] }).expect(201)).body;
      const m = c.works.measurements[c.works.measurements.length - 1];
      await api().post(`/commercial/contracts/${contract.id}/works/${m.id}/approve`).set(h).send({ name: 'Fiscal' }).expect(201);
      await api().post(`/commercial/contracts/${contract.id}/works/${m.id}/bill`).set(h).send({ invoiceNumber: nf }).expect(201);
      return m;
    };
    // BM-01: só o adiantamento
    const m1 = await bill(0, addDays(TODAY, 5), 'NF-1');
    expect(m1.lines.map((l: any) => [l.kind, l.value])).toEqual([['adiantamento', adv], ['frente', 0]]);
    // BM-02: 50% → abate 30% do medido
    const m2 = await bill(50, addDays(TODAY, 15), 'NF-2');
    const half = r2(T * 0.5);
    expect(m2.lines.map((l: any) => [l.kind, l.value])).toEqual([['frente', half], ['amortizacao', -r2(half * 0.3)]]);
    // BM-03: 100% → abate o resto do adiantamento
    const m3 = await bill(100, addDays(TODAY, 25), 'NF-3');
    expect(m3.lines.map((l: any) => [l.kind, l.value])).toEqual([['frente', r2(T - half)], ['amortizacao', -r2(adv - r2(half * 0.3))]]);
    const after = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(after.works.summary).toMatchObject({ measured: T, invoiced: T, advance: adv, amortized: adv, balance: 0, depositRecord: null });
    // com boletins, o plano não muda mais
    await api().put(`/commercial/contracts/${contract.id}/measurement-plan`).set(h).send({ plan: { fronts: [{ title: 'Obra', weight: 1 }] } }).expect(409);
  });

  it('venda de parcelas com parcela faturada não vira medição; rotas de obra recusam venda que não é por medição', async () => {
    const { h, created } = await proposta(undefined);
    const contract = await aceitar(h, created.id);
    await api().get(`/commercial/contracts/${contract.id}/works/suggestion`).set(h).expect(409);
    await api().post(`/commercial/contracts/${contract.id}/installments/${contract.installments[0].id}/bill`).set(h).send({ invoiceNumber: 'NF-9' }).expect(201);
    await api().put(`/commercial/contracts/${contract.id}/measurement-plan`).set(h).send({ plan: { fronts: [{ title: 'Obra', weight: 1 }] } }).expect(409);
  });
});
