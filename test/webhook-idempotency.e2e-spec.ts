import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import {
  bootTestApp,
  httpServer,
  shutdownTestApp,
  flushCache,
} from './setup/app';
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

  // Token global de teste (ASAAS_WEBHOOK_TOKEN): sem token o webhook é recusado.
  const GLOBAL_TOKEN = 'whtok_global_teste_0123456789abcdef';
  const previousGlobal = process.env.ASAAS_WEBHOOK_TOKEN;
  beforeAll(() => {
    process.env.ASAAS_WEBHOOK_TOKEN = GLOBAL_TOKEN;
  });
  afterAll(() => {
    process.env.ASAAS_WEBHOOK_TOKEN = previousGlobal;
  });

  function sendWebhook(
    companyId: number,
    payload: any,
    token: string | null = GLOBAL_TOKEN,
  ) {
    const req = request(httpServer()).post(`/webhooks/asaas/${companyId}`);
    if (token) req.set('asaas-access-token', token);
    return req.send(payload);
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

    await sendWebhook(
      s.company.id,
      receivedEvent(s.externalId, s.subscriptionId),
    ).expect(201);

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
   * C2: o modo de transição acabou — sem token configurado (nem da empresa
   * nem global) ou sem o header, o evento é recusado e nada é gravado.
   */
  it('[C2] evento sem token é recusado (não cria registro forjado)', async () => {
    const saved = process.env.ASAAS_WEBHOOK_TOKEN;
    delete process.env.ASAAS_WEBHOOK_TOKEN;
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

    await sendWebhook(
      scenario.company.id,
      {
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
      },
      null,
    ).expect(401);
    process.env.ASAAS_WEBHOOK_TOKEN = saved;

    const forged = await testDb().financialRecords.findFirst({
      where: { externalId: 'pay_forjado_sem_autenticacao' },
    });

    expect(forged).toBeNull();
  });

  describe('[C2] empresa com webhookToken configurado', () => {
    const TOKEN = 'whtok_teste_0123456789abcdef';

    async function scenarioWithToken() {
      const scenario = await makeCheckoutScenario();
      await testDb().companyGateWays.updateMany({
        where: { companyId: scenario.company.id, gateway: 'asaas' },
        data: {
          payload: {
            token: 'tok_teste_asaas',
            webhookId: 'wh_teste',
            webhookToken: TOKEN,
          },
        },
      });
      const sub = await testDb().courseClassSubscription.create({
        data: {
          name: 'Comprador',
          cpf: '11144477735',
          email: 'c@teste.local',
          phone: '81900000000',
          classId: scenario.courseClass.id,
          companyId: scenario.company.id,
          subscribeStatus: 'pending',
        },
      });
      return { scenario, sub };
    }

    it('recusa evento sem header e não cria registro financeiro', async () => {
      const { scenario, sub } = await scenarioWithToken();
      const res = await sendWebhook(
        scenario.company.id,
        receivedEvent('pay_sem_header', sub.id),
      );
      expect(res.status).toBe(401);
      expect(
        await testDb().financialRecords.findFirst({
          where: { externalId: 'pay_sem_header' },
        }),
      ).toBeNull();
    });

    it('recusa evento com token errado', async () => {
      const { scenario, sub } = await scenarioWithToken();
      const res = await sendWebhook(
        scenario.company.id,
        receivedEvent('pay_token_errado', sub.id),
      ).set('asaas-access-token', 'whtok_errado');
      expect(res.status).toBe(401);
      expect(
        await testDb().financialRecords.findFirst({
          where: { externalId: 'pay_token_errado' },
        }),
      ).toBeNull();
    });

    it('aceita evento com o token correto', async () => {
      const { scenario, sub } = await scenarioWithToken();
      await sendWebhook(
        scenario.company.id,
        receivedEvent('pay_token_ok', sub.id),
      )
        .set('asaas-access-token', TOKEN)
        .expect(201);
      const rec = await testDb().financialRecords.findFirst({
        where: { externalId: 'pay_token_ok' },
      });
      expect(rec?.status).toBe('received');
    });
  });
});
