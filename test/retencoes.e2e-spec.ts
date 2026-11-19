import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Plano 08, fase 9: retenção de impostos no faturamento.
 *
 * Ao registrar a nota, informa-se o que o cliente reteve (ISS, INSS, IR, PIS,
 * COFINS, CSLL); a conta a receber fica com o líquido e cada retenção fica
 * registrada. O relatório mensal mostra o que não deve ser pago de novo na
 * guia, e os alertas pegam o pagamento em dobro (cliente reteve e pagou cheio;
 * guia paga de imposto que o cliente já reteve).
 */
describe('Retenção de impostos no faturamento (e2e)', () => {
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

  /** Proposta de serviço enviada, pronta para o aceite. */
  async function cenario(extra: Record<string, unknown> = {}) {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const customer = await makeCustomer(company.id);
    const h = auth(company.id);
    const options = (await api().get('/commercial/proposals/options').set(h).expect(200)).body;
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id;
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId: customer.id, title: 'Jateamento de estrutura', contactName: 'Maria Souza', workDays: 22, contingencyRate: 0.05,
      commission: { rate: 0.02, base: 'faturado' },
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 1 }] }],
      installments: [
        { percent: 0.5, dueRule: 'dias_apos_aceite', dueDays: 5, description: 'Entrada' },
        { percent: 0.5, dueRule: 'dias_apos_nf', dueDays: 28, description: 'Saldo' },
      ],
      ...extra,
    }).expect(201)).body;
    const sent = (await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200)).body;
    return { company, customer, h, proposal: sent };
  }
  const aceitarPeloLink = (key: string) => api().post(`/commercial/public/proposals/${key}/accept`).set('X-Forwarded-For', `192.0.2.${++ipSeq}`)
    .send({ name: 'Maria Souza', cpf: '529.982.247-25', role: 'Gerente de Suprimentos', email: 'maria@alfa.local', declaration: true, termsAccepted: true });
  async function contratoAceito(extra: Record<string, unknown> = {}) {
    const base = await cenario(extra);
    await aceitarPeloLink(base.proposal.publicKey).expect(201);
    const list = (await api().get('/commercial/contracts').set(base.h).expect(200)).body;
    const contract = (await api().get(`/commercial/contracts/${list.rows[0].id}`).set(base.h).expect(200)).body;
    return { ...base, contract };
  }
  const faturar = (h: Record<string, string>, contractId: number, installmentId: number, body: Record<string, unknown> = {}) =>
    api().post(`/commercial/contracts/${contractId}/installments/${installmentId}/bill`).set(h).send({ invoiceNumber: 'NF-1001', ...body });

  const month = TODAY.slice(0, 7);

  it('nota com retenções: líquido na conta a receber, retenção por imposto, alíquotas do cliente no contrato', async () => {
    const { h, contract, company } = await contratoAceito();
    const db = testDb();
    // alíquotas que o cliente costuma reter ficam no contrato (sugestão ao faturar)
    await api().put(`/commercial/contracts/${contract.id}/retention-rates`).set(h).send({ rates: { iss: 5, inss: 11, ir: '' } }).expect(200)
      .then((r) => expect(r.body.retentionRates).toEqual({ iss: 5, inss: 11 }));
    await api().put(`/commercial/contracts/${contract.id}/retention-rates`).set(h).send({ rates: { icms: 3 } }).expect(400);

    const inst = contract.installments[0]; // 10.294,56
    // retenção inválida: imposto desconhecido, repetido, ou passando do valor da nota
    await faturar(h, contract.id, inst.id, { retentions: [{ tax: 'icms', rate: 5 }] }).expect(400);
    await faturar(h, contract.id, inst.id, { retentions: [{ tax: 'iss', rate: 5 }, { tax: 'iss', rate: 2 }] }).expect(400);
    await faturar(h, contract.id, inst.id, { retentions: [{ tax: 'iss', rate: 60 }, { tax: 'inss', rate: 50 }] }).expect(400);

    const billed = (await faturar(h, contract.id, inst.id, { retentions: [
      { tax: 'iss', rate: 5 }, { tax: 'inss', rate: 11 }, { tax: 'ir', value: 154.42 }, { tax: 'pis', rate: 0 },
    ] }).expect(201)).body;
    const record = await db.financialRecords.findUniqueOrThrow({ where: { id: billed.financialRecordId }, include: { retentions: { orderBy: { id: 'asc' } } } });
    // ISS 514,73 + INSS 1.132,40 + IR 154,42 = 1.801,55 → líquido 8.493,01
    expect(Number(record.value)).toBe(10294.56);
    expect(Number(record.netValue)).toBe(8493.01);
    expect(record.retentions.map((r) => [r.tax, r.rate === null ? null : Number(r.rate), Number(r.base), Number(r.value), r.accrualDate, r.invoiceNumber, r.contractId])).toEqual([
      ['iss', 5, 10294.56, 514.73, month, 'NF-1001', contract.id],
      ['inss', 11, 10294.56, 1132.4, month, 'NF-1001', contract.id],
      ['ir', null, 10294.56, 154.42, month, 'NF-1001', contract.id],
    ]);
    const after = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(after.installments[0].record).toMatchObject({ netValue: 8493.01 });

    // corrigir as retenções depois, em qualquer conta a receber: o líquido acompanha
    const edited = (await api().put(`/financial/receivables/${record.id}/retentions`).set(h).send({ retentions: [{ tax: 'iss', rate: 2 }] }).expect(200)).body;
    expect(edited).toMatchObject({ value: 10294.56, netValue: 10088.67, base: 10294.56, retentions: [{ tax: 'iss', rate: 2, value: 205.89 }], suggested: { iss: 5, inss: 11 } });
    await api().put(`/financial/receivables/${record.id}/retentions`).set(h).send({ retentions: [] }).expect(200)
      .then((r) => expect(r.body).toMatchObject({ netValue: null, retentions: [] }));
    // desfazer o faturamento leva as retenções junto (a conta é cancelada e sai do relatório)
    await api().put(`/financial/receivables/${record.id}/retentions`).set(h).send({ retentions: [{ tax: 'iss', rate: 5 }] }).expect(200);
    await api().post(`/commercial/contracts/${contract.id}/installments/${inst.id}/unbill`).set(h).expect(201);
    expect((await api().get('/financial/retentions').set(h).expect(200)).body.total).toBe(0);
    // sem permissão do financeiro não vê o relatório
    await api().get('/financial/retentions').set(auth(company.id, ['list_comercial'])).expect(403);
  });

  it('uma nota para várias parcelas: cada parcela vira sua conta a receber, retenções rateadas', async () => {
    const { h, contract } = await contratoAceito();
    const db = testDb();
    const [a, b] = contract.installments;
    const due = addDays(TODAY, 40);
    const res = (await api().post(`/commercial/contracts/${contract.id}/installments/bill`).set(h).send({
      installmentIds: [b.id, a.id], invoiceNumber: 'NF-2002', dueDates: { [b.id]: due }, retentions: [{ tax: 'iss', rate: 5 }],
    }).expect(201)).body;
    expect(res.financialRecordIds).toHaveLength(2);
    const records = await db.financialRecords.findMany({ where: { contractId: contract.id }, include: { retentions: true }, orderBy: { installmentNumber: 'asc' } });
    expect(records.map((r) => [r.installmentNumber, r.invoiceNumber, Number(r.value), Number(r.netValue), r.retentions.map((x) => Number(x.value))])).toEqual([
      // ISS de 5% sobre 20.589,11 = 1.029,46, rateado 514,73 + 514,73
      [1, 'NF-2002', 10294.56, 9779.83, [514.73]],
      [2, 'NF-2002', 10294.55, 9779.82, [514.73]],
    ]);
    expect(records[1].dueDate!.toISOString().slice(0, 10)).toBe(due);
    expect(res.billed).toBe(20589.11);
    // a mesma parcela não entra em duas notas
    await api().post(`/commercial/contracts/${contract.id}/installments/bill`).set(h).send({ installmentIds: [a.id], invoiceNumber: 'NF-3' }).expect(409);
    await api().post(`/commercial/contracts/${contract.id}/installments/bill`).set(h).send({ installmentIds: [], invoiceNumber: 'NF-3' }).expect(400);
  });

  it('relatório mensal de retidos e os alertas de pagamento em dobro', async () => {
    const { h, contract, company } = await contratoAceito();
    const [a, b] = contract.installments;
    const first = (await faturar(h, contract.id, a.id, { invoiceNumber: 'NF-10', retentions: [{ tax: 'iss', rate: 5 }, { tax: 'inss', rate: 11 }] }).expect(201)).body.financialRecordId;
    const second = (await faturar(h, contract.id, b.id, { invoiceNumber: 'NF-11', retentions: [{ tax: 'iss', rate: 5 }] }).expect(201)).body.financialRecordId;

    let report = (await api().get(`/financial/retentions?from=${month}&to=${month}`).set(h).expect(200)).body;
    expect(report.months).toHaveLength(1);
    expect(report.months[0]).toMatchObject({ month, count: 3, pending: 3, declared: false, totals: { iss: 1029.46, inss: 1132.4, ir: 0 }, total: 2161.86, guides: [] });
    expect(report.rows.map((r: any) => [r.label, r.value, r.invoiceNumber])).toEqual([['ISS', 514.73, 'NF-10'], ['INSS', 1132.4, 'NF-10'], ['ISS', 514.73, 'NF-11']]);
    expect(report.alerts).toEqual([]);

    // guia do Simples do mesmo mês: o retido não pode ser pago de novo
    await api().post('/financial-payables').set(h).send({ description: 'DAS do mês', value: 1800, dueDate: addDays(TODAY, 20), accrualDate: month, taxKind: 'xyz' }).expect(400);
    const das = (await api().post('/financial-payables').set(h).send({ description: 'DAS do mês', value: 1800, dueDate: addDays(TODAY, 20), accrualDate: month, taxKind: 'das' }).expect(201)).body;
    report = (await api().get(`/financial/retentions?from=${month}&to=${month}`).set(h).expect(200)).body;
    expect(report.months[0].guides).toEqual([expect.objectContaining({ id: das.id, taxKind: 'das', value: 1800 })]);
    expect(report.alerts).toEqual([expect.objectContaining({ type: 'retido_e_pago', month, payableId: das.id, taxes: ['iss', 'inss'], retained: 2161.86 })]);
    // marcado como informado na guia: o alerta sai
    expect((await api().post('/financial/retentions/declare').set(h).send({ month }).expect(201)).body.updated).toBe(3);
    report = (await api().get(`/financial/retentions?from=${month}&to=${month}`).set(h).expect(200)).body;
    expect(report.months[0]).toMatchObject({ pending: 0, declared: true });
    expect(report.alerts).toEqual([]);
    await api().post('/financial/retentions/declare').set(h).send({ month, undo: true, taxes: ['inss'] }).expect(201).then((r) => expect(r.body.updated).toBe(1));
    report = (await api().get(`/financial/retentions?from=${month}&to=${month}`).set(h).expect(200)).body;
    expect(report.alerts).toEqual([expect.objectContaining({ type: 'retido_e_pago', taxes: ['inss'], retained: 1132.4 })]);
    await api().post('/financial/retentions/declare').set(h).send({ month }).expect(201);

    // cliente reteve e pagou cheio: alerta forte
    await api().patch(`/financial-records/settle/${first}`).set(h).send({ receivedValue: 10294.56 }).expect(200);
    // cliente pagou menos que o líquido esperado
    await api().patch(`/financial-records/settle/${second}`).set(h).send({ receivedValue: 9000 }).expect(200);
    report = (await api().get(`/financial/retentions?from=${month}&to=${month}`).set(h).expect(200)).body;
    expect(report.alerts.map((x: any) => [x.type, x.financialRecordId, x.invoiceNumber])).toEqual([['pagou_cheio', first, 'NF-10'], ['recebido_menor', second, 'NF-11']]);

    // outra empresa não vê nada
    const other = await makeCompany();
    expect((await api().get('/financial/retentions').set(auth(other.id)).expect(200)).body.total).toBe(0);
    expect(company.id).not.toBe(other.id);
  });

  it('conta de contrato paga a menos e sem retenção informada: avisa para informar a retenção', async () => {
    const { h, contract } = await contratoAceito();
    const id = (await faturar(h, contract.id, contract.installments[0].id, { invoiceNumber: 'NF-20' }).expect(201)).body.financialRecordId;
    await api().patch(`/financial-records/settle/${id}`).set(h).send({ receivedValue: 9779.83 }).expect(200);
    const report = (await api().get('/financial/retentions').set(h).expect(200)).body;
    expect(report.alerts).toEqual([expect.objectContaining({ type: 'retencao_nao_informada', financialRecordId: id, invoiceNumber: 'NF-20' })]);
    // informando a retenção, o alerta some
    await api().put(`/financial/receivables/${id}/retentions`).set(h).send({ retentions: [{ tax: 'iss', rate: 5 }] }).expect(200);
    expect((await api().get('/financial/retentions').set(h).expect(200)).body.alerts).toEqual([]);
  });
});
