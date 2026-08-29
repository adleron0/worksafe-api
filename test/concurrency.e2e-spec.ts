import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import * as nock from 'nock';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCheckoutScenario } from './setup/factories';
import {
  ASAAS_BASE,
  paymentBody,
  resetAsaasMock,
  blockRealNetwork,
} from './setup/asaas-mock';

/**
 * Concorrência no checkout.
 *
 * O fluxo de inscrição não abre transação — `createSubscriptionWithPayment`
 * recebe `tx = null` e repassa esse nulo ao insert — e o schema não tem
 * constraint única em (cpf, classId) nem em externalId. A checagem de
 * inscrição existente é um selectFirst solto, o que caracteriza um
 * check-then-act sujeito a corrida.
 *
 * Na prática: dois cliques no botão de pagar, ou um retry do navegador,
 * podem gerar duas cobranças. Estes testes existem para tornar esse
 * comportamento visível e servem de critério de aceite da fase 4.
 */
describe('Concorrência no checkout (e2e)', () => {
  beforeAll(async () => {
    blockRealNetwork();
    await bootTestApp();
  });

  afterAll(async () => {
    await shutdownTestApp();
    resetAsaasMock();
  });

  beforeEach(async () => {
    await resetDb();
    await flushCache();
    resetAsaasMock();
  });

  const buyer = {
    name: 'Pedro Alves',
    cpf: '71428793860',
    email: 'pedro@teste.local',
    phone: '81944443333',
  };

  /** Cada tentativa recebe um id de pagamento distinto, como o gateway faria. */
  function mockConcurrentAttempts(count: number) {
    const scope = nock(ASAAS_BASE);
    scope
      .get('/customers')
      .query(true)
      .times(count)
      .reply(200, { object: 'list', totalCount: 0, data: [] });
    scope
      .post('/customers')
      .times(count)
      .reply(200, { object: 'customer', id: 'cus_teste_000001' });

    for (let i = 0; i < count; i++) {
      const payment = paymentBody({ id: `pay_concorrente_${i}` });
      scope.post('/payments').reply(200, payment);
      scope.get(`/payments/${payment.id}`).times(2).reply(200, payment);
      scope
        .get(`/payments/${payment.id}/pixQrCode`)
        .times(2)
        .reply(200, { encodedImage: 'img', payload: 'copia-e-cola' });
    }
  }

  function subscribe(classId: number) {
    const req = request(httpServer()).post('/subscription/subscribe');
    Object.entries({
      ...buyer,
      classId: String(classId),
      paymentMethod: 'pix',
    }).forEach(([k, v]) => req.field(k, v as string));
    return req;
  }

  it('duplo clique não gera cobrança duplicada', async () => {
    const { courseClass } = await makeCheckoutScenario({ price: 500 });
    mockConcurrentAttempts(2);

    // Duas requisições em voo ao mesmo tempo — o duplo clique do usuário.
    const [a, b] = await Promise.all([
      subscribe(courseClass.id),
      subscribe(courseClass.id),
    ]);

    // Uma passa; a outra é recusada com mensagem acionável em vez de virar
    // uma segunda cobrança.
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);


    const subs = await testDb().courseClassSubscription.findMany({
      where: { cpf: buyer.cpf, classId: courseClass.id },
    });
    const records = await testDb().financialRecords.findMany({
      where: { subscriptionId: { in: subs.map((s) => s.id) } },
    });

    const allRecs = await testDb().financialRecords.findMany({});
    const totalCobrado = records.reduce((sum, r) => sum + Number(r.value), 0);

    expect(subs).toHaveLength(1);
    expect(records).toHaveLength(1);
    // O ponto do teste: cobra 500, não 1000.
    expect(totalCobrado).toBe(500);
  });

  it('o banco não impede duas inscrições do mesmo CPF na mesma turma', async () => {
    const { courseClass, company } = await makeCheckoutScenario();

    // Inserção direta: prova que a proteção não existe na camada de dados,
    // independentemente do que a aplicação faça.
    const base = {
      name: buyer.name,
      cpf: buyer.cpf,
      email: buyer.email,
      phone: buyer.phone,
      classId: courseClass.id,
      companyId: company.id,
      subscribeStatus: 'pending' as const,
    };

    await testDb().courseClassSubscription.create({ data: base });
    await testDb().courseClassSubscription.create({ data: base });

    const subs = await testDb().courseClassSubscription.findMany({
      where: { cpf: buyer.cpf, classId: courseClass.id },
    });

    // Falta @@unique([cpf, classId]) — a duplicata é aceita sem erro.
    expect(subs).toHaveLength(2);
  });

  it('o banco não impede dois registros financeiros com o mesmo externalId', async () => {
    const { company } = await makeCheckoutScenario();

    const base = {
      accrualDate: '2026-08',
      companyId: company.id,
      gateway: 'asaas' as const,
      status: 'received' as const,
      paymentMethod: 'pix' as const,
      value: 500,
      dueDate: new Date(),
      externalId: 'pay_mesmo_id',
    };

    await testDb().financialRecords.create({ data: base });
    await testDb().financialRecords.create({ data: base });

    const records = await testDb().financialRecords.findMany({
      where: { externalId: 'pay_mesmo_id' },
    });

    // Falta @@unique([externalId, companyId]) — webhooks concorrentes para o
    // mesmo pagamento podem criar registros duplicados e inflar a receita.
    expect(records).toHaveLength(2);
  });
});
