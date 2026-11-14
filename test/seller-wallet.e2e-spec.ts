import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, flushCache, httpServer, shutdownTestApp } from './setup/app';
import { blockRealNetwork, mockCheckout, paymentBody, resetAsaasMock } from './setup/asaas-mock';
import { resetDb, testDb } from './setup/db';
import { makeCheckoutScenario, makeCompany, makeCoupon, makeCourse, makeCourseClass, makeGateway } from './setup/factories';

/**
 * Vendedores e carteira de comissões.
 *
 * Vendedor é só um usuário marcado: nenhuma chamada a gateway. A comissão nasce de
 * uma conta a receber (treinamento por cupom, serviço por parcela de contrato),
 * fica PREVISTA até o cliente pagar e só então entra no saldo a pagar. O pagamento
 * ao vendedor é uma baixa lançada aqui.
 */
describe('Vendedores — carteira de comissões (e2e)', () => {
  const COMMERCIAL = ['list_comercial', 'create_comercial', 'update_comercial', 'inactive_comercial', 'activate_comercial', 'view_custos_comercial'];
  const FINANCE = ['list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro', 'activate_financeiro'];
  const ALL = [...COMMERCIAL, ...FINANCE, 'list_user', 'create_user', 'update_user'];
  const TODAY = new Date().toISOString().slice(0, 10);
  let jwt: JwtService;
  let userId = 0;
  let seq = 0;

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

  /** Usuário comum, sem nada de vendedor: nem CPF de verdade, nem endereço, nem PIX. */
  async function makeUser(companyId: number, name = 'Ana Lima', extra: Record<string, unknown> = {}) {
    seq += 1;
    return testDb().user.create({ data: {
      name, email: `usuario${seq}@teste.local`, password: 'hash', phone: '81900000000', cpf: String(70000000000 + seq), companyId, ...extra,
    } as any });
  }
  async function empresa() {
    const company = await makeCompany();
    const admin = await makeUser(company.id, 'Gestora');
    userId = admin.id;
    return { company, admin, h: auth(company.id) };
  }
  const buyer = { name: 'Aluno Comprador', cpf: '52998224725', email: 'aluno@teste.local', phone: '81999990000' };
  function subscribe(fields: Record<string, string>) {
    const req = api().post('/subscription/subscribe');
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  }
  /** Venda de treinamento com cupom de vendedor, no modo manual (baixa pela tela). */
  async function vendaManual(companyId: number, sellerId: number, code = 'CUPOM20') {
    await makeGateway(companyId, { gateway: 'manual', payload: {}, active: true });
    const course = await makeCourse(companyId);
    const courseClass = await makeCourseClass(companyId, course.id, { price: 500 });
    await makeCoupon(companyId, { code, discountType: 'percentage', discountValue: 10, commissionType: 'percentage', commissionValue: 20, sellerId });
    const res = await subscribe({ ...buyer, classId: String(courseClass.id), paymentMethod: 'pix', couponCode: code }).expect(201);
    return { courseClass, financialRecordId: res.body.financialRecordId as number };
  }
  const wallet = async (h: Record<string, string>, sellerId: number) => (await api().get(`/commercial/sellers/${sellerId}`).set(h).expect(200)).body;
  const settle = (h: Record<string, string>, recordId: number) => api().patch(`/financial-records/settle/${recordId}`).set(h).send({ paidAt: TODAY, paymentMethod: 'pix' });

  it('novo vendedor: lista usuários que ainda não são, marca e cria a carteira — sem chamar gateway e sem exigir nada', async () => {
    const { company, admin, h } = await empresa();
    const ana = await makeUser(company.id, 'Ana Lima');
    const bruno = await makeUser(company.id, 'Bruno Sá');
    await makeUser(company.id, 'Inativo', { inactiveAt: new Date() });
    const other = await makeCompany();
    await makeUser(other.id, 'De outra empresa');

    const candidates = (await api().get('/commercial/sellers/candidates').set(h).expect(200)).body;
    expect(candidates.map((u: any) => u.name)).toEqual(['Ana Lima', 'Bruno Sá', 'Gestora']);
    expect((await api().get('/commercial/sellers/candidates').query({ search: 'bru' }).set(h).expect(200)).body.map((u: any) => u.id)).toEqual([bruno.id]);

    // qualquer chamada externa aqui falharia: a rede está bloqueada
    const marked = (await api().post(`/commercial/sellers/${ana.id}`).set(h).expect(201)).body;
    expect(marked).toMatchObject({ seller: { id: ana.id, name: 'Ana Lima', isSeller: true }, balance: 0, pending: 0, paid: 0, generated: 0 });
    expect(nock.pendingMocks()).toEqual([]);
    expect(await testDb().commercial_SellerWallet.count({ where: { userId: ana.id } })).toBe(1);
    // marcar de novo não duplica a carteira
    await api().post(`/commercial/sellers/${ana.id}`).set(h).expect(201);
    expect(await testDb().commercial_SellerWallet.count()).toBe(1);

    const list = (await api().get('/commercial/sellers').set(h).expect(200)).body;
    expect(list.rows.map((row: any) => row.id)).toEqual([ana.id]);
    expect(list.summary).toMatchObject({ sellers: 1, balance: 0 });
    expect((await api().get('/commercial/sellers/candidates').set(h).expect(200)).body.map((u: any) => u.id)).not.toContain(ana.id);

    // permissões e isolamento entre empresas
    await api().post(`/commercial/sellers/${bruno.id}`).set(auth(company.id, ['list_comercial'])).expect(403);
    await api().get('/commercial/sellers').set(auth(company.id, FINANCE)).expect(403);
    await api().get(`/commercial/sellers/${ana.id}`).set(auth(other.id)).expect(404);
    await api().post(`/commercial/sellers/${ana.id}`).set(auth(other.id)).expect(404);

    // deixar de ser vendedor guarda a carteira
    await api().delete(`/commercial/sellers/${ana.id}`).set(h).expect(200);
    expect((await api().get('/commercial/sellers').set(h).expect(200)).body.rows).toEqual([]);
    expect(await testDb().commercial_SellerWallet.count({ where: { userId: ana.id } })).toBe(1);
    expect(admin.id).toBeGreaterThan(0);
  });

  it('ligar "é vendedor" no cadastro do usuário só marca e cria a carteira (sem endereço, PIX ou subconta)', async () => {
    const { company, h } = await empresa();
    const ana = await makeUser(company.id, 'Ana Lima');
    await api().put(`/user/${ana.id}`).set(h).send({ isSeller: true }).expect(200);
    const saved = await testDb().user.findUniqueOrThrow({ where: { id: ana.id } });
    expect(saved).toMatchObject({ isSeller: true, sellerConfig: null });
    expect(await testDb().commercial_SellerWallet.count({ where: { userId: ana.id } })).toBe(1);
  });

  it('treinamento: a comissão do cupom nasce prevista, é liberada quando o cliente paga e volta se a baixa é estornada', async () => {
    const { company, h } = await empresa();
    const ana = await makeUser(company.id, 'Ana Lima');
    await api().post(`/commercial/sellers/${ana.id}`).set(h).expect(201);
    const { courseClass, financialRecordId } = await vendaManual(company.id, ana.id);

    let w = await wallet(h, ana.id);
    expect(w).toMatchObject({ balance: 0, pending: 90, generated: 0, paid: 0, sales: 0 });
    expect(w.byOrigin.treinamento).toMatchObject({ pending: 90, generated: 0 });

    await settle(h, financialRecordId).expect(200);
    w = await wallet(h, ana.id);
    expect(w).toMatchObject({ balance: 90, pending: 0, generated: 90, sales: 1, averageCommission: 90 });
    expect(w.byOrigin).toMatchObject({ treinamento: { generated: 90, sales: 1 }, servico: { generated: 0 } });
    expect(w.months[w.months.length - 1]).toMatchObject({ month: TODAY.slice(0, 7), generated: 90, paid: 0 });

    const entries = (await api().get(`/commercial/sellers/${ana.id}/entries`).set(h).expect(200)).body;
    expect(entries.total).toBe(1);
    expect(entries.rows[0]).toMatchObject({ type: 'comissao', origin: 'treinamento', status: 'liberada', amount: 90, rate: 20, baseValue: 450, courseClass: { id: courseClass.id } });
    expect(entries.rows[0].description).toContain('cupom CUPOM20');

    // estorno da baixa: volta a ser previsão
    await api().patch(`/financial-records/unsettle/${financialRecordId}`).set(h).expect(200);
    expect(await wallet(h, ana.id)).toMatchObject({ balance: 0, pending: 90, generated: 0 });
    // conta a receber inativada: a comissão é cancelada (não apagada)
    await api().patch(`/financial-records/inactive/${financialRecordId}`).set(h).expect(200);
    expect(await wallet(h, ana.id)).toMatchObject({ balance: 0, pending: 0, generated: 0 });
    const kept = await testDb().commercial_SellerWalletEntry.findMany({ where: { sellerId: ana.id } });
    expect(kept.map((entry) => entry.status)).toEqual(['cancelada']);
  });

  it('treinamento pelo Asaas: o webhook de pagamento libera a comissão; repetido, não duplica; estorno cancela', async () => {
    const { h } = await empresa();
    const scenario = await makeCheckoutScenario({ price: 500 });
    userId = (await makeUser(scenario.company.id, 'Gestora Asaas')).id;
    const hc = auth(scenario.company.id);
    const ana = await makeUser(scenario.company.id, 'Ana Lima');
    await makeCoupon(scenario.company.id, { code: 'ASAAS20', discountType: 'percentage', discountValue: 10, commissionType: 'percentage', commissionValue: 20, sellerId: ana.id });
    const payment = paymentBody({ billingType: 'PIX', value: 450 });
    const { sent } = mockCheckout({ billingType: 'PIX', value: 450, id: payment.id } as any);
    const res = await subscribe({ ...buyer, classId: String(scenario.courseClass.id), paymentMethod: 'pix', couponCode: 'ASAAS20' }).expect(201);
    expect(sent.createPayment.split).toBeUndefined();
    const record = await testDb().financialRecords.findUniqueOrThrow({ where: { id: res.body.financialRecordId } });

    // vendedor do cupom ganhou carteira sozinho, com a comissão prevista
    expect(await wallet(hc, ana.id)).toMatchObject({ balance: 0, pending: 90 });

    const event = (status: string, name: string) => ({
      event: name, payment: { id: record.externalId, status, value: 450, billingType: 'PIX', externalReference: `sub_${res.body.id}` },
    });
    await api().post(`/webhooks/asaas/${scenario.company.id}`).send(event('RECEIVED', 'PAYMENT_RECEIVED')).expect((r) => expect(r.status).toBeLessThan(300));
    await api().post(`/webhooks/asaas/${scenario.company.id}`).send(event('RECEIVED', 'PAYMENT_RECEIVED')).expect((r) => expect(r.status).toBeLessThan(300));
    expect(await wallet(hc, ana.id)).toMatchObject({ balance: 90, pending: 0, generated: 90, sales: 1 });
    expect(await testDb().commercial_SellerWalletEntry.count({ where: { sellerId: ana.id } })).toBe(1);

    await api().post(`/webhooks/asaas/${scenario.company.id}`).send(event('REFUNDED', 'PAYMENT_REFUNDED')).expect((r) => expect(r.status).toBeLessThan(300));
    expect(await wallet(hc, ana.id)).toMatchObject({ balance: 0, pending: 0, generated: 0 });
    expect(h.Authorization).toBeDefined();
  });

  it('pagamento ao vendedor: baixa o saldo, pede confirmação para adiantar, estorna com motivo e fica no histórico', async () => {
    const { company, h } = await empresa();
    const ana = await makeUser(company.id, 'Ana Lima');
    await api().post(`/commercial/sellers/${ana.id}`).set(h).expect(201);
    const { financialRecordId } = await vendaManual(company.id, ana.id);
    await settle(h, financialRecordId).expect(200);
    const account = await testDb().financial_BankAccount.create({ data: { companyId: company.id, name: 'Conta principal' } as any });
    const pay = (body: Record<string, unknown>) => api().post(`/commercial/sellers/${ana.id}/payments`).set(h).send(body);

    await pay({ amount: 0 }).expect(400);
    await pay({ amount: 'abc' }).expect(400);
    await pay({ amount: 60, paidAt: '2099-01-01' }).expect(400);
    await pay({ amount: 60, bankAccountId: 999999 }).expect(400);
    await pay({ amount: 60 }).set(auth(company.id, ['list_comercial'])).expect(403);
    // acima do saldo: só confirmando o adiantamento
    const refused = await pay({ amount: 120 }).expect(409);
    expect(JSON.stringify(refused.body)).toContain('adiantamento');

    const paid = (await pay({ amount: 60, paidAt: TODAY, paymentMethod: 'pix', bankAccountId: account.id, note: 'PIX do dia' }).expect(201)).body;
    expect(paid).toMatchObject({ balance: 30, paid: 60, generated: 90, lastPayment: { amount: 60 } });
    expect(paid.months[paid.months.length - 1]).toMatchObject({ generated: 90, paid: 60 });

    const advance = (await pay({ amount: 50, allowAdvance: true }).expect(201)).body;
    expect(advance).toMatchObject({ balance: -20, paid: 110 });

    const entries = (await api().get(`/commercial/sellers/${ana.id}/entries`).query({ type: 'pagamento' }).set(h).expect(200)).body;
    expect(entries.total).toBe(2);
    const first = entries.rows.find((row: any) => row.id === paid.id);
    expect(first).toMatchObject({ type: 'pagamento', status: 'efetivado', amount: -60, paymentMethod: 'pix', bankAccount: { id: account.id, name: 'Conta principal' }, note: 'PIX do dia', createdBy: 'Gestora' });

    // estorno do adiantamento lançado errado
    await api().post(`/commercial/sellers/entries/${advance.id}/reverse`).set(h).send({}).expect(400);
    const reversed = (await api().post(`/commercial/sellers/entries/${advance.id}/reverse`).set(h).send({ reason: 'Lançado em duplicidade' }).expect(201)).body;
    expect(reversed).toMatchObject({ balance: 30, paid: 60 });
    await api().post(`/commercial/sellers/entries/${advance.id}/reverse`).set(h).send({ reason: 'De novo' }).expect(409);
    // comissão não se estorna por aqui, nem lançamento de outra empresa
    const commission = await testDb().commercial_SellerWalletEntry.findFirstOrThrow({ where: { sellerId: ana.id, type: 'comissao' } });
    await api().post(`/commercial/sellers/entries/${commission.id}/reverse`).set(h).send({ reason: 'Tentativa' }).expect(409);
    await api().post(`/commercial/sellers/entries/${paid.id}/reverse`).set(auth((await makeCompany()).id)).send({ reason: 'Invasão' }).expect(404);

    // ajuste manual: crédito e débito, com motivo
    await api().post(`/commercial/sellers/${ana.id}/adjustments`).set(h).send({ amount: 10 }).expect(400);
    const adjusted = (await api().post(`/commercial/sellers/${ana.id}/adjustments`).set(h).send({ amount: -5.5, description: 'Desconto de material' }).expect(201)).body;
    expect(adjusted).toMatchObject({ balance: 24.5, adjustments: -5.5 });

    // a lista traz o saldo de cada vendedor e o total a pagar
    const list = (await api().get('/commercial/sellers').set(h).expect(200)).body;
    expect(list.rows[0]).toMatchObject({ id: ana.id, wallet: { balance: 24.5, paid: 60, generated: 90 } });
    expect(list.summary).toMatchObject({ sellers: 1, balance: 24.5 });
  });

  it('comissão já paga cuja venda foi cancelada vira saldo devedor a compensar', async () => {
    const { company, h } = await empresa();
    const ana = await makeUser(company.id, 'Ana Lima');
    await api().post(`/commercial/sellers/${ana.id}`).set(h).expect(201);
    const { financialRecordId } = await vendaManual(company.id, ana.id);
    await settle(h, financialRecordId).expect(200);
    await api().post(`/commercial/sellers/${ana.id}/payments`).set(h).send({ amount: 90 }).expect(201);
    expect(await wallet(h, ana.id)).toMatchObject({ balance: 0, paid: 90 });
    await api().patch(`/financial-records/unsettle/${financialRecordId}`).set(h).expect(200);
    expect(await wallet(h, ana.id)).toMatchObject({ balance: -90, pending: 90, paid: 90 });
  });

  it('a conferência acerta a carteira quando a conta a receber mudou por um caminho que não avisou', async () => {
    const { company, h } = await empresa();
    const ana = await makeUser(company.id, 'Ana Lima');
    await api().post(`/commercial/sellers/${ana.id}`).set(h).expect(201);
    const { financialRecordId } = await vendaManual(company.id, ana.id);
    // mudança direta no banco (um script, um caminho antigo): a carteira não foi avisada
    await testDb().financialRecords.update({ where: { id: financialRecordId }, data: { status: 'received', paidAt: new Date() } });
    expect((await testDb().commercial_SellerWalletEntry.findFirstOrThrow({ where: { financialRecordId } })).status).toBe('prevista');
    // abrir a carteira confere e acerta
    expect(await wallet(h, ana.id)).toMatchObject({ balance: 90, pending: 0 });
    await testDb().financialRecords.update({ where: { id: financialRecordId }, data: { sellerId: null } });
    expect((await api().get('/commercial/sellers').set(h).expect(200)).body.rows[0].wallet).toMatchObject({ balance: 0, generated: 0 });
  });

  it('serviço: cada parcela faturada do contrato gera a parte dela na comissão, liberada quando a parcela é paga', async () => {
    const { company, h } = await empresa();
    const db = testDb();
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } });
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } });
    const customer = await db.customer.create({ data: {
      name: 'Indústria Alfa', corporateName: 'Indústria Alfa SA', cnpj: '11222333000181', companyId: company.id,
      rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id,
    } });
    const ana = await makeUser(company.id, 'Ana Lima');
    const options = (await api().get('/commercial/proposals/options').set(h).expect(200)).body;
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id;
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId: customer.id, title: 'Jateamento de estrutura', workDays: 22, contingencyRate: 0.05, sellerId: ana.id,
      commission: { rate: 0.02, base: 'faturado' },
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 1 }] }],
      installments: [{ percent: 0.5, dueRule: 'dias_apos_aceite', dueDays: 5 }, { percent: 0.5, dueRule: 'dias_apos_nf', dueDays: 28 }],
    }).expect(201)).body;
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200);
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'aceita', note: 'Aceite por e-mail' }).expect(200);
    const stored = await db.commercial_Proposal.findUniqueOrThrow({ where: { id: proposal.id } });
    const whole = Number(stored.commission);
    expect(whole).toBeGreaterThan(0);

    const contractId = (await api().get('/commercial/contracts').set(h).expect(200)).body.rows[0].id;
    const contract = (await api().get(`/commercial/contracts/${contractId}`).set(h).expect(200)).body;
    const [first, second] = contract.installments;
    const share = (value: number) => Math.round(((whole * value) / Number(stored.total)) * 100) / 100;
    const bill = (installmentId: number, invoiceNumber: string) =>
      api().post(`/commercial/contracts/${contractId}/installments/${installmentId}/bill`).set(h).send({ invoiceNumber });

    // usuário que nunca foi marcado como vendedor ganha a carteira na primeira comissão
    expect(await db.commercial_SellerWallet.count({ where: { userId: ana.id } })).toBe(0);
    const billed = (await bill(first.id, 'NF-1').expect(201)).body;
    expect((await db.user.findUniqueOrThrow({ where: { id: ana.id } })).isSeller).toBe(true);
    let w = await wallet(h, ana.id);
    expect(w).toMatchObject({ balance: 0, pending: share(first.value) });
    expect(w.byOrigin.servico.pending).toBe(share(first.value));

    await settle(h, billed.financialRecordId).expect(200);
    w = await wallet(h, ana.id);
    expect(w).toMatchObject({ balance: share(first.value), pending: 0 });
    expect(w.byOrigin).toMatchObject({ servico: { generated: share(first.value), sales: 1 }, treinamento: { generated: 0 } });

    const entries = (await api().get(`/commercial/sellers/${ana.id}/entries`).query({ origin: 'servico' }).set(h).expect(200)).body;
    expect(entries.rows[0]).toMatchObject({ type: 'comissao', origin: 'servico', status: 'liberada', contract: { id: contractId, number: contract.number } });
    expect(entries.rows[0].description).toContain(`${contract.number} · parcela 1/2`);

    // segunda parcela: faturada e depois desfeita → comissão cancelada
    await bill(second.id, 'NF-2').expect(201);
    expect(await wallet(h, ana.id)).toMatchObject({ pending: share(second.value) });
    await api().post(`/commercial/contracts/${contractId}/installments/${second.id}/unbill`).set(h).expect((r) => expect(r.status).toBeLessThan(300));
    expect(await wallet(h, ana.id)).toMatchObject({ balance: share(first.value), pending: 0 });
    // as duas partes somam a comissão da proposta (a menos do centavo de arredondamento)
    expect(Math.abs(share(first.value) + share(second.value) - whole)).toBeLessThanOrEqual(0.01);
  });
});
