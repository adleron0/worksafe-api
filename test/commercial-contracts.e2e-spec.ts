import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Comercial — contrato e ligação com o Contas a Receber.
 *
 * O caminho inteiro: proposta aceita vira contrato; a nota fiscal de cada
 * parcela vira conta a receber de baixa manual; e do contrato dá para ver o
 * que foi faturado e o que já entrou.
 */
describe('Comercial — contratos e contas a receber (e2e)', () => {
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

  it('aceite pelo link cria o contrato, com o documento aceito, quem aceitou e as parcelas previstas', async () => {
    const { h, proposal, customer, contract } = await contratoAceito();
    expect(contract).toMatchObject({
      number: `CT-${YEAR}-0001`, status: 'vigente', kind: 'servico', title: 'Jateamento de estrutura', value: 20589.11,
      customer: { id: customer.id }, proposal: { id: proposal.id, number: proposal.number }, documentHash: proposal.documentHash, hasDocument: true,
      billed: 0, received: 0, toBill: 20589.11,
    });
    expect(contract.signer).toMatchObject({ name: 'Maria Souza', cpf: '52998224725', role: 'Gerente de Suprimentos', manual: false });
    expect(contract.installments.map((i: any) => [i.number, i.total, i.description, i.value, i.record])).toEqual([[1, 2, 'Entrada', 10294.56, null], [2, 2, 'Saldo', 10294.55, null]]);
    // entrada: 5 dias após o aceite (mas nunca antes de hoje, data da nota sugerida)
    expect(contract.installments[0].suggestedDue).toBe(addDays(TODAY, 5));
    expect(contract.installments[1].suggestedDue).toBe(addDays(TODAY, 28));

    const document = (await api().get(`/commercial/contracts/${contract.id}/document`).set(h).expect(200)).body;
    expect(document.hash).toBe(proposal.documentHash);
    expect(document.html).toContain('20.589,11');
    // a proposta aponta para o contrato
    const after = (await api().get(`/commercial/proposals/${proposal.id}`).set(h).expect(200)).body;
    expect(after.contract).toMatchObject({ id: contract.id, number: contract.number, status: 'vigente' });
    expect(await testDb().commercial_Contract.count()).toBe(1);
  });

  it('aceite registrado à mão também cria o contrato; a numeração segue por empresa', async () => {
    const { h, proposal, company, customer } = await cenario();
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'aceita', note: 'Pedido de compra 4500123' }).expect(200);
    const list = (await api().get('/commercial/contracts').set(h).expect(200)).body;
    expect(list).toMatchObject({ total: 1, summary: { vigente: { count: 1, total: 20589.11 } } });
    expect(list.rows[0]).toMatchObject({ number: `CT-${YEAR}-0001`, value: 20589.11, installments: 2, billed: 0, toBill: 20589.11, customer: { name: 'Indústria Alfa' } });
    const contract = (await api().get(`/commercial/contracts/${list.rows[0].id}`).set(h).expect(200)).body;
    expect(contract.signer).toMatchObject({ manual: true, note: 'Pedido de compra 4500123' });

    // segunda proposta aceita → CT-0002
    const options = (await api().get('/commercial/proposals/options').set(h)).body;
    const second = (await api().post('/commercial/proposals').set(h).send({
      customerId: customer.id, title: 'Outro serviço', workDays: 2,
      sections: [{ title: 'MDO', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId: options.professionals[0].id }] }],
      installments: [{ percent: 1, dueRule: 'data_fixa', dueDate: '2027-03-10' }],
    }).expect(201)).body;
    await api().patch(`/commercial/proposals/status/${second.id}`).set(h).send({ status: 'enviada' }).expect(200);
    await api().patch(`/commercial/proposals/status/${second.id}`).set(h).send({ status: 'aceita' }).expect(200);
    const again = (await api().get('/commercial/contracts?search=outro').set(h).expect(200)).body;
    expect(again.rows.map((r: any) => r.number)).toEqual([`CT-${YEAR}-0002`]);
    expect((await api().get(`/commercial/contracts/${again.rows[0].id}`).set(h)).body.installments[0].suggestedDue).toBe('2027-03-10');
    // outra empresa começa do 0001 e não vê estes
    const other = await makeCompany();
    expect((await api().get('/commercial/contracts').set(auth(other.id)).expect(200)).body.total).toBe(0);
    expect(company.id).not.toBe(other.id);
  });

  it('registrar a nota fiscal de uma parcela cria a conta a receber, já ligada ao contrato', async () => {
    const { h, company, customer, contract } = await contratoAceito();
    const [entrada, saldo] = contract.installments;
    // conta e centro de custo padrão para recebível de contrato
    const accounts = (await api().get('/financial/chart-accounts').set(h).expect(200)).body;
    const leaf = accounts.find((a: any) => a.code === '1.2.1');
    await api().put('/financial/classification-defaults/contrato').set(h).send({ chartAccountId: leaf.id }).expect(200);

    await faturar(h, contract.id, saldo.id, { invoiceNumber: '' }).expect(400);
    await faturar(h, contract.id, saldo.id, { invoiceIssuedAt: addDays(TODAY, 3) }).expect(400);
    await faturar(h, contract.id, saldo.id, { netValue: 99999999 }).expect(400);
    await faturar(h, contract.id, 999999).expect(404);

    const billed = (await faturar(h, contract.id, saldo.id, { invoiceNumber: 'NF-2044', invoiceIssuedAt: TODAY, netValue: 9800, paymentMethod: 'boleto' }).expect(201)).body;
    expect(billed).toMatchObject({ billed: 10294.55, received: 0, toBill: 10294.56 });
    expect(billed.installments[1].record).toMatchObject({ status: 'waiting', invoiceNumber: 'NF-2044', invoiceIssuedAt: TODAY, dueDate: addDays(TODAY, 28), paid: false });

    const record = await testDb().financialRecords.findUniqueOrThrow({ where: { id: billed.financialRecordId } });
    expect(record).toMatchObject({
      companyId: company.id, gateway: 'manual', status: 'waiting', paymentMethod: 'boleto', customerId: customer.id,
      invoiceNumber: 'NF-2044', installmentNumber: 2, installmentTotal: 2, contractId: contract.id, contractInstallmentId: saldo.id,
      accrualDate: TODAY.slice(0, 7), chartAccountId: leaf.id,
    });
    expect([Number(record.value), Number(record.netValue)]).toEqual([10294.55, 9800]);
    expect(record.description).toContain(`${contract.number} — parcela 2/2`);

    // aparece em Contas a Receber, filtrável pelo contrato
    const receivables = (await api().get(`/financial-records?contractId=${contract.id}`).set(h).expect(200)).body;
    expect(receivables.rows.map((r: any) => r.invoiceNumber)).toEqual(['NF-2044']);
    // a mesma parcela não fatura duas vezes
    await faturar(h, contract.id, saldo.id).expect(409);
    // vencimento informado à mão vale; sem data da nota, hoje
    const first = (await faturar(h, contract.id, entrada.id, { invoiceNumber: 'NF-2045', dueDate: '2030-01-15' }).expect(201)).body;
    expect(first.installments[0].record).toMatchObject({ dueDate: '2030-01-15', invoiceIssuedAt: TODAY });
    expect(first).toMatchObject({ billed: 20589.11, toBill: 0 });
  });

  it('baixa no financeiro aparece no contrato; parcela paga não desfaz o faturamento', async () => {
    const { h, contract } = await contratoAceito();
    const saldo = contract.installments[1];
    const billed = (await faturar(h, contract.id, saldo.id).expect(201)).body;
    const recordId = billed.financialRecordId;

    await api().patch(`/financial-records/settle/${recordId}`).set(h).send({ paidAt: TODAY, paymentMethod: 'pix' }).expect(200);
    const paid = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(paid).toMatchObject({ billed: 10294.55, received: 10294.55 });
    expect(paid.installments[1].record).toMatchObject({ status: 'received', paid: true });
    const listed = (await api().get('/commercial/contracts').set(h)).body.rows[0];
    expect(listed).toMatchObject({ billed: 10294.55, received: 10294.55, toBill: 10294.56 });

    const unbill = () => api().post(`/commercial/contracts/${contract.id}/installments/${saldo.id}/unbill`).set(h);
    await unbill().expect(409); // já pago
    await api().patch(`/financial-records/unsettle/${recordId}`).set(h).expect(200);
    const undone = (await unbill().expect(201)).body;
    expect(undone).toMatchObject({ billed: 0, received: 0, toBill: 20589.11 });
    expect(undone.installments[1].record).toBeNull();
    const record = await testDb().financialRecords.findUniqueOrThrow({ where: { id: recordId } });
    expect(record.inactiveAt).not.toBeNull();
    expect(record.status).toBe('cancelled');
    await unbill().expect(409); // nada para desfazer
    // pode faturar de novo, com outra nota
    await faturar(h, contract.id, saldo.id, { invoiceNumber: 'NF-3000' }).expect(201);
  });

  it('pelo cadastro genérico de recebíveis não dá para forjar o vínculo com contrato', async () => {
    const { h, customer, contract } = await contratoAceito();
    const created = (await api().post('/financial-records').set(h)
      .field('customerId', String(customer.id)).field('value', '100').field('dueDate', '2030-01-10').field('contractId', String(contract.id)).field('contractInstallmentId', '1').expect(201)).body;
    const stored = await testDb().financialRecords.findUniqueOrThrow({ where: { id: created.id } });
    expect([stored.contractId, stored.contractInstallmentId]).toEqual([null, null]);
    expect((await api().get(`/commercial/contracts/${contract.id}`).set(h)).body.billed).toBe(0);
  });

  it('situação do contrato: concluir, cancelar (só sem título em aberto) e reabrir; datas', async () => {
    const { h, contract } = await contratoAceito({ installments: [{ percent: 1, dueRule: 'dias_apos_conclusao', dueDays: 10 }] });
    const status = (target: string, note?: string) => api().patch(`/commercial/contracts/status/${contract.id}`).set(h).send({ status: target, note });
    const put = (body: Record<string, unknown>) => api().put(`/commercial/contracts/${contract.id}`).set(h).send(body);

    await put({ startDate: '2027-02-10', endDate: '2027-02-01' }).expect(400);
    const dated = (await put({ startDate: '2027-02-01', endDate: '2027-03-05', notes: 'Mobilização na semana anterior.' }).expect(200)).body;
    expect(dated).toMatchObject({ startDate: '2027-02-01', endDate: '2027-03-05', notes: 'Mobilização na semana anterior.' });
    // "10 dias após a conclusão" passa a usar a data de conclusão do contrato
    expect(dated.installments[0].suggestedDue).toBe('2027-03-15');

    await status('inventada').expect(400);
    const billed = (await faturar(h, contract.id, contract.installments[0].id).expect(201)).body;
    await status('cancelado').expect(409); // há título em aberto
    await status('concluido', 'Serviço entregue').expect(200);
    await api().post(`/commercial/contracts/${contract.id}/installments/${contract.installments[0].id}/unbill`).set(h).expect(201);
    await faturar(h, contract.id, contract.installments[0].id).expect(409); // concluído não fatura
    const cancelled = (await status('cancelado', 'Cliente desistiu').expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'cancelado', statusNote: 'Cliente desistiu', billed: 0 });
    expect((await status('vigente').expect(200)).body.status).toBe('vigente');
    expect(billed.financialRecordId).toBeGreaterThan(0);
    expect((await api().get('/commercial/contracts?status=cancelado').set(h)).body.total).toBe(0);
  });

  it('contrato de treinamento: criar a turma fechada do item', async () => {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const customer = await makeCustomer(company.id);
    const h = auth(company.id);
    const course = await makeCourse(company.id);
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'treinamento', customerId: customer.id, title: 'NR-35 in company', contingencyRate: 0,
      sections: [{ title: 'Treinamentos', kind: 'treinamento', margin: 0, items: [
        { type: 'treinamento', courseId: course.id, quantity: 2, finalValue: 9000, extra: { students: 30, workload: 8, dates: '10 e 11/02', location: 'Planta do cliente' } },
        { type: 'treinamento', description: 'Palestra de segurança', quantity: 1, finalValue: 1500 },
      ] }],
      installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 30 }],
    }).expect(201)).body;
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200);
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'aceita' }).expect(200);
    const contract = (await api().get(`/commercial/contracts/${(await api().get('/commercial/contracts').set(h)).body.rows[0].id}`).set(h).expect(200)).body;
    expect(contract.kind).toBe('treinamento');
    expect(contract.classes).toHaveLength(2);
    expect(contract.classes[0]).toMatchObject({ index: 0, courseId: course.id, quantity: 2, students: 30, workload: 8, location: 'Planta do cliente', classes: [] });

    const create = (index: number, body: Record<string, unknown> = {}) => api().post(`/commercial/contracts/${contract.id}/classes/${index}`).set(h).send(body);
    await create(0, { initialDate: '2027-02-11', finalDate: '2027-02-10' }).expect(400);
    const first = (await create(0, { initialDate: '2027-02-10', finalDate: '2027-02-11' }).expect(201)).body;
    const klass = await testDb().courseClass.findUniqueOrThrow({ where: { id: first.classId } });
    expect(klass).toMatchObject({
      companyId: company.id, customerId: customer.id, courseId: course.id, openClass: false, allowCheckout: false, allowSubscriptions: false,
      classCode: contract.number, hoursDuration: 8, maxSubscriptions: 15, address: 'Planta do cliente', name: 'NR-35 Trabalho em Altura — Indústria Alfa',
    });
    expect(first.classes[0].classes.map((c: any) => c.id)).toEqual([klass.id]);
    await create(0, { name: 'Turma B' }).expect(201);
    await create(0).expect(409); // as duas turmas do item já existem
    await create(1).expect(400); // item sem curso
    await create(9).expect(404);
    // a turma fechada não aparece para o site (que só lista turma aberta)
    const publicList = (await api().get('/classes?openClass=true').expect(200)).body;
    expect(publicList.rows.map((c: any) => c.id)).not.toContain(klass.id);
    await create(0).set(auth(company.id, COMMERCIAL)).expect(403); // sem permissão de turmas
  });

  it('proposta aceita antes de existir contrato ganha o seu ao abrir a lista', async () => {
    const { h, contract, proposal } = await contratoAceito();
    await testDb().commercial_Contract.delete({ where: { id: contract.id } });
    const list = (await api().get('/commercial/contracts').set(h).expect(200)).body;
    expect(list.total).toBe(1);
    const restored = (await api().get(`/commercial/contracts/${list.rows[0].id}`).set(h).expect(200)).body;
    expect(restored).toMatchObject({ value: 20589.11, proposal: { id: proposal.id }, documentHash: proposal.documentHash });
    expect(restored.signer).toMatchObject({ name: 'Maria Souza', cpf: '52998224725', manual: false });
    expect(restored.installments).toHaveLength(2);
    await api().get('/commercial/contracts').set(h).expect(200);
    expect(await testDb().commercial_Contract.count()).toBe(1);
  });

  it('permissões e isolamento entre empresas', async () => {
    const { h, company, contract } = await contratoAceito();
    const installmentId = contract.installments[0].id;
    await api().get('/commercial/contracts').expect(401);
    await api().get('/commercial/contracts').set(auth(company.id, FINANCE)).expect(403);
    // comercial vê e conclui, mas faturar é do financeiro
    const sales = auth(company.id, COMMERCIAL);
    await api().get(`/commercial/contracts/${contract.id}`).set(sales).expect(200);
    await faturar(sales, contract.id, installmentId).expect(403);
    await api().put(`/commercial/contracts/${contract.id}`).set(auth(company.id, ['list_comercial'])).send({ notes: 'x' }).expect(403);
    // financeiro com leitura do comercial fatura
    await faturar(auth(company.id, ['list_comercial', 'create_financeiro']), contract.id, installmentId).expect(201);
    await api().post(`/commercial/contracts/${contract.id}/installments/${installmentId}/unbill`).set(auth(company.id, ['list_comercial', 'create_financeiro'])).expect(403);

    const other = await makeCompany();
    const foreign = auth(other.id);
    await api().get(`/commercial/contracts/${contract.id}`).set(foreign).expect(404);
    await api().get(`/commercial/contracts/${contract.id}/document`).set(foreign).expect(404);
    await faturar(foreign, contract.id, contract.installments[1].id).expect(404);
    await api().patch(`/commercial/contracts/status/${contract.id}`).set(foreign).send({ status: 'cancelado' }).expect(404);
    expect((await api().get(`/financial-records?contractId=${contract.id}`).set(foreign).expect(200)).body.rows).toHaveLength(0);
    expect(h).toBeTruthy();
  });
});
