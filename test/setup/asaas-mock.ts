import * as nock from 'nock';

/**
 * Mock do Asaas para a suíte e2e.
 *
 * As respostas reproduzem o formato real da API v3. A sequência de chamadas de
 * um checkout é:
 *   1. GET  /customers?cpfCnpj=...        (getCustomerByCpf)
 *   2. POST /customers                    (só se o 1 não achou)
 *   3. POST /payments                     (createPayment)
 *   4. GET  /payments/:id                 (getPaymentDetails, sempre)
 *   5. GET  /payments/:id/pixQrCode       (só PIX)
 *      GET  /payments/:id/identificationField (só boleto)
 */

export const ASAAS_BASE = 'https://api.asaas.com/v3';

export const PIX_QR_CODE = 'iVBORw0KGgoAAAANSUhEUg==';
export const PIX_PAYLOAD = '00020126580014br.gov.bcb.pix0136teste-payload-copia-e-cola5204000053039865802BR';
export const BOLETO_LINE = '34191.79001 01043.510047 91020.150008 1 96560000050000';

type PaymentSeed = {
  id?: string;
  status?: string;
  value?: number;
  billingType?: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
  externalReference?: string;
  installmentCount?: number;
};

/** Corpo de um pagamento como o Asaas devolve. */
export function paymentBody(seed: PaymentSeed = {}) {
  const billingType = seed.billingType ?? 'PIX';
  return {
    object: 'payment',
    id: seed.id ?? 'pay_teste_000001',
    dateCreated: '2026-08-29',
    customer: 'cus_teste_000001',
    value: seed.value ?? 500,
    netValue: (seed.value ?? 500) - 1.99,
    billingType,
    status: seed.status ?? (billingType === 'CREDIT_CARD' ? 'CONFIRMED' : 'PENDING'),
    dueDate: '2026-08-30',
    description: 'Inscrição - Turma Teste',
    externalReference: seed.externalReference ?? null,
    invoiceUrl: 'https://www.asaas.com/i/teste',
    bankSlipUrl:
      billingType === 'BOLETO' ? 'https://www.asaas.com/b/pdf/teste' : null,
    transactionReceiptUrl:
      billingType === 'CREDIT_CARD' ? 'https://www.asaas.com/c/teste' : null,
    nossoNumero: billingType === 'BOLETO' ? '9876543' : null,
    deleted: false,
    ...(seed.installmentCount ? { installmentCount: seed.installmentCount } : {}),
  };
}

/**
 * Registra o caminho completo de um checkout bem-sucedido.
 * `customerExists` controla se o CPF já tem cadastro no Asaas.
 */
export function mockCheckout(
  seed: PaymentSeed = {},
  opts: { customerExists?: boolean } = {},
) {
  const payment = paymentBody(seed);
  const scope = nock(ASAAS_BASE);
  // Guarda o corpo enviado ao Asaas: é onde se verifica valor final,
  // parcelamento e split sem depender do que a API devolve.
  const sent: { createPayment: any } = { createPayment: null };

  scope
    .get('/customers')
    .query(true)
    .reply(
      200,
      opts.customerExists
        ? { object: 'list', totalCount: 1, data: [{ id: 'cus_teste_000001' }] }
        : { object: 'list', totalCount: 0, data: [] },
    );

  if (!opts.customerExists) {
    scope
      .post('/customers')
      .reply(200, { object: 'customer', id: 'cus_teste_000001' });
  }

  scope
    .post('/payments', (body) => {
      sent.createPayment = body;
      return true;
    })
    .reply(200, payment);

  // getPaymentDetails é chamado logo após a criação, e de novo em reprocessos.
  scope.get(`/payments/${payment.id}`).times(3).reply(200, payment);

  if (payment.billingType === 'PIX') {
    scope
      .get(`/payments/${payment.id}/pixQrCode`)
      .times(3)
      .reply(200, {
        success: true,
        encodedImage: PIX_QR_CODE,
        payload: PIX_PAYLOAD,
        expirationDate: '2026-08-30 23:59:59',
      });
  }

  if (payment.billingType === 'BOLETO') {
    scope
      .get(`/payments/${payment.id}/identificationField`)
      .times(3)
      .reply(200, {
        identificationField: BOLETO_LINE.replace(/[^\d]/g, ''),
        nossoNumero: '9876543',
        barCode: '34191965600000500000179000104351004910201500',
        digitableLine: BOLETO_LINE,
      });
  }

  return { payment, scope, sent };
}

export function resetAsaasMock(): void {
  nock.cleanAll();
}

/** Impede qualquer chamada de rede real escapar da suíte. */
export function blockRealNetwork(): void {
  nock.disableNetConnect();
  // supertest fala com a app pelo loopback.
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
}
