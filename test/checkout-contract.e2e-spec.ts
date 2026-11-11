import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb } from './setup/db';
import { makeCheckoutScenario } from './setup/factories';
import {
  mockCheckout,
  resetAsaasMock,
  blockRealNetwork,
  PIX_PAYLOAD,
  PIX_QR_CODE,
  BOLETO_LINE,
} from './setup/asaas-mock';

/**
 * GOLDEN CONTRACT do checkout público.
 *
 * Estes testes congelam o formato da resposta de POST /subscription/subscribe,
 * que é exatamente o que o worksafe-site consome em turma.$id.tsx e
 * CheckoutForm.tsx. Se a refatoração de desacoplamento mudar qualquer um
 * destes campos, o checkout público quebra — e é aqui que isso aparece.
 *
 * R6: o site envia multipart/form-data, não JSON. Testar em JSON passaria e
 * mentiria, porque em produção todo valor chega como string.
 */
describe('Checkout público — contrato de resposta (e2e)', () => {
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

  /** Reproduz o envio do site: multipart, todo valor como string. */
  function subscribeAsSite(fields: Record<string, string>) {
    const req = request(httpServer()).post('/subscription/subscribe');
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  }

  const buyer = {
    name: 'Maria Souza',
    cpf: '39053344705',
    email: 'maria@teste.local',
    phone: '81999998888',
    address: 'Rua Teste',
    addressNumber: '100',
    neighborhood: 'Centro',
    city: 'Recife',
    state: 'PE',
    zipCode: '50000000',
  };

  it('PIX: devolve os campos que o site usa para exibir QR code e copia-e-cola', async () => {
    const { courseClass } = await makeCheckoutScenario();
    mockCheckout({ billingType: 'PIX', value: 500 });

    const res = await subscribeAsSite({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'pix',
    }).expect(201);

    // O site lê financialRecord.{key,pixUrl,pixNumber,status}
    expect(res.body).toMatchObject({
      financialRecord: {
        status: 'waiting',
        paymentMethod: 'pix',
        pixUrl: PIX_QR_CODE,
        pixNumber: PIX_PAYLOAD,
      },
    });

    // `key` é o UUID usado no polling GET /financial-records/key/:key
    expect(res.body.financialRecord.key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.body.financialRecordId).toEqual(expect.any(Number));
    expect(res.body.payment.status).toBe('PENDING');
  });

  it('Boleto: devolve billUrl e a linha digitável', async () => {
    const { courseClass } = await makeCheckoutScenario();
    mockCheckout({ billingType: 'BOLETO', value: 500 });

    const res = await subscribeAsSite({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'boleto',
    }).expect(201);

    expect(res.body.financialRecord).toMatchObject({
      status: 'waiting',
      paymentMethod: 'boleto',
      billUrl: 'https://www.asaas.com/b/pdf/teste',
      billNumber: BOLETO_LINE,
    });
  });

  it('Cartão aprovado: marca o registro como recebido e preenche paidAt', async () => {
    const { courseClass } = await makeCheckoutScenario();
    mockCheckout({ billingType: 'CREDIT_CARD', status: 'CONFIRMED', value: 500 });

    const res = await subscribeAsSite({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'cartaoCredito',
      creditCard: JSON.stringify({
        cardName: 'MARIA SOUZA',
        cardNumber: '5162306219378829',
        expiryDate: '12/28',
        cvv: '318',
        installments: '1',
      }),
    }).expect(201);

    expect(res.body.financialRecord.status).toBe('received');
    expect(res.body.financialRecord.paidAt).not.toBeNull();
    expect(res.body.payment.status).toBe('CONFIRMED');
  });
});
