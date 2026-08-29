import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCheckoutScenario } from './setup/factories';
import {
  mockCheckout,
  resetAsaasMock,
  blockRealNetwork,
} from './setup/asaas-mock';

/**
 * Caracterização do webhook de pagamento.
 *
 * É o caminho que confirma a matrícula, e o mais frágil do sistema: hoje não
 * tem validação de origem (C2) nem chave de idempotência. Estes testes
 * congelam o comportamento atual e viram o critério de aceite da fase 4 —
 * a idempotência precisa existir ANTES de a fase 3 endurecer o webhook (R2).
 */
describe('Webhook de pagamento — confirmação e idempotência (e2e)', () => {
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
    name: 'João Lima',
    cpf: '52998224725',
    email: 'joao@teste.local',
    phone: '81977776666',
  };

  /** Cria uma inscrição PIX pendente e devolve os ids envolvidos. */
  async function pendingPixSubscription() {
    const scenario = await makeCheckoutScenario();
    const { payment } = mockCheckout({ billingType: 'PIX', value: 500 });

    const req = request(httpServer()).post('/subscription/subscribe');
    Object.entries({
      ...buyer,
      classId: String(scenario.courseClass.id),
      paymentMethod: 'pix',
    }).forEach(([k, v]) => req.field(k, v as string));

    const res = await req.expect(201);
    return {
      ...scenario,
      externalId: payment.id,
      subscriptionId: res.body.id as number,
      financialRecordId: res.body.financialRecordId as number,
    };
  }

  function sendWebhook(companyId: number, payload: any) {
    return request(httpServer())
      .post(`/webhooks/asaas/${companyId}`)
      .send(payload);
  }

  function receivedEvent(externalId: string, subscriptionId: number) {
    return {
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: externalId,
        status: 'RECEIVED',
        value: 500,
        billingType: 'PIX',
        dueDate: '2026-08-30',
        externalReference: `sub_${subscriptionId}`,
        deleted: false,
      },
    };
  }

  it('confirma a inscrição e cria o aluno ao receber PAYMENT_RECEIVED', async () => {
    const s = await pendingPixSubscription();

    await sendWebhook(s.company.id, receivedEvent(s.externalId, s.subscriptionId))
      .expect(201);

    const sub = await testDb().courseClassSubscription.findUnique({
      where: { id: s.subscriptionId },
    });
    expect(sub?.subscribeStatus).toBe('confirmed');
    expect(sub?.traineeId).toEqual(expect.any(Number));

    const record = await testDb().financialRecords.findUnique({
      where: { id: s.financialRecordId },
    });
    expect(record?.status).toBe('received');
    expect(record?.paidAt).not.toBeNull();

    const trainees = await testDb().trainee.findMany({
      where: { cpf: buyer.cpf },
    });
    expect(trainees).toHaveLength(1);
  });

  it('reentrega do mesmo evento não duplica aluno nem registro financeiro', async () => {
    const s = await pendingPixSubscription();
    const event = receivedEvent(s.externalId, s.subscriptionId);

    // O Asaas reenvia o mesmo evento em caso de timeout ou retry manual.
    await sendWebhook(s.company.id, event).expect(201);
    await sendWebhook(s.company.id, event).expect(201);
    await sendWebhook(s.company.id, event).expect(201);

    const trainees = await testDb().trainee.findMany({
      where: { cpf: buyer.cpf },
    });
    expect(trainees).toHaveLength(1);

    const records = await testDb().financialRecords.findMany({
      where: { externalId: s.externalId },
    });
    expect(records).toHaveLength(1);

    const subs = await testDb().courseClassSubscription.findMany({
      where: { cpf: buyer.cpf, classId: s.courseClass.id },
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].subscribeStatus).toBe('confirmed');
  });

  it('PAYMENT_DELETED marca a cobrança como cancelada e recusa a inscrição', async () => {
    const s = await pendingPixSubscription();

    await sendWebhook(s.company.id, {
      event: 'PAYMENT_DELETED',
      payment: {
        id: s.externalId,
        status: 'DELETED',
        value: 500,
        billingType: 'PIX',
        externalReference: `sub_${s.subscriptionId}`,
        deleted: true,
      },
    }).expect(201);

    const record = await testDb().financialRecords.findUnique({
      where: { id: s.financialRecordId },
    });
    expect(record?.status).toBe('cancelled');

    const sub = await testDb().courseClassSubscription.findUnique({
      where: { id: s.subscriptionId },
    });
    expect(sub?.subscribeStatus).toBe('declined');
  });

  /**
   * COMPORTAMENTO ATUAL, NÃO DESEJADO — documenta a vulnerabilidade C2.
   * O endpoint aceita qualquer POST sem autenticação e cria um registro
   * financeiro "recebido" do nada, confirmando matrícula sem pagamento.
   * Quando a fase 3 entrar, este teste passa a asserir 401.
   */
  it('[C2] hoje aceita webhook forjado sem qualquer validação de origem', async () => {
    const scenario = await makeCheckoutScenario();
    const sub = await testDb().courseClassSubscription.create({
      data: {
        name: 'Fraudador',
        cpf: '11144477735',
        email: 'fraude@teste.local',
        phone: '81900000000',
        classId: scenario.courseClass.id,
        companyId: scenario.company.id,
        subscribeStatus: 'pending',
      },
    });

    await sendWebhook(scenario.company.id, {
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_forjado_sem_autenticacao',
        status: 'RECEIVED',
        value: 1,
        billingType: 'PIX',
        dueDate: '2026-12-01',
        externalReference: `sub_${sub.id}`,
        deleted: false,
      },
    }).expect(201);

    const forged = await testDb().financialRecords.findFirst({
      where: { externalId: 'pay_forjado_sem_autenticacao' },
    });

    // Falha de segurança confirmada: registro criado sem pagamento real.
    expect(forged).not.toBeNull();
    expect(forged?.status).toBe('received');
  });
});
