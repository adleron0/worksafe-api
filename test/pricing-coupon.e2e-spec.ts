import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import {
  makeCheckoutScenario,
  makeCoupon,
  makeSeller,
} from './setup/factories';
import {
  mockCheckout,
  resetAsaasMock,
  blockRealNetwork,
} from './setup/asaas-mock';

/**
 * Regras de dinheiro: preço, cupom e split.
 *
 * O valor cobrado é decidido no servidor a partir da turma no banco. Estes
 * testes provam isso e travam o comportamento antes da extração do
 * PricingService (fase 2), que hoje está dividido entre checkout.service
 * (calculatePrice) e coupon.service (getClassPrice + calculateCommission).
 */
describe('Preço, cupom e split (e2e)', () => {
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
    name: 'Ana Costa',
    cpf: '15350946056',
    email: 'ana@teste.local',
    phone: '81966665555',
  };

  function subscribe(fields: Record<string, string>) {
    const req = request(httpServer()).post('/subscription/subscribe');
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  }

  it('ignora valor enviado pelo cliente e cobra o preço da turma', async () => {
    const { courseClass } = await makeCheckoutScenario({ price: 500 });
    const { sent } = mockCheckout({ billingType: 'PIX', value: 500 });

    const res = await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'pix',
      // Tentativa de manipulação: nenhum destes pode influenciar a cobrança.
      value: '1',
      price: '1',
      finalPrice: '1',
    }).expect(201);

    expect(sent.createPayment.value).toBe(500);
    expect(Number(res.body.financialRecord.value)).toBe(500);
  });

  it('usa discountPrice quando existe, em vez de price', async () => {
    const { courseClass } = await makeCheckoutScenario({
      price: 500,
      discountPrice: 399.9,
    });
    const { sent } = mockCheckout({ billingType: 'PIX', value: 399.9 });

    await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'pix',
    }).expect(201);

    expect(sent.createPayment.value).toBe(399.9);
  });

  it('aplica desconto percentual do cupom no servidor', async () => {
    const scenario = await makeCheckoutScenario({ price: 500 });
    await makeCoupon(scenario.company.id, {
      code: 'DEZ',
      discountType: 'percentage',
      discountValue: 10,
    });
    const { sent } = mockCheckout({ billingType: 'PIX', value: 450 });

    const res = await subscribe({
      ...buyer,
      classId: String(scenario.courseClass.id),
      paymentMethod: 'pix',
      couponCode: 'DEZ',
    }).expect(201);

    expect(sent.createPayment.value).toBe(450);
    expect(Number(res.body.financialRecord.originalValue)).toBe(500);
    expect(Number(res.body.financialRecord.discount)).toBe(50);
  });

  it('cupom inexistente é ignorado e a compra segue pelo preço cheio', async () => {
    const { courseClass } = await makeCheckoutScenario({ price: 500 });
    const { sent } = mockCheckout({ billingType: 'PIX', value: 500 });

    await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'pix',
      couponCode: 'NAO-EXISTE',
    }).expect(201);

    expect(sent.createPayment.value).toBe(500);
  });

  it('cupom expirado não desconta', async () => {
    const scenario = await makeCheckoutScenario({ price: 500 });
    await makeCoupon(scenario.company.id, {
      code: 'VENCIDO',
      discountType: 'percentage',
      discountValue: 50,
      validUntil: new Date('2020-01-01'),
    });
    const { sent } = mockCheckout({ billingType: 'PIX', value: 500 });

    await subscribe({
      ...buyer,
      classId: String(scenario.courseClass.id),
      paymentMethod: 'pix',
      couponCode: 'VENCIDO',
    }).expect(201);

    expect(sent.createPayment.value).toBe(500);
  });

  it('cupom com comissão: nada de split no gateway; a comissão vai prevista para a carteira do vendedor', async () => {
    const scenario = await makeCheckoutScenario({ price: 500 });
    const seller = await makeSeller(scenario.company.id);
    await makeCoupon(scenario.company.id, {
      code: 'VENDEDOR',
      discountType: 'percentage',
      discountValue: 10,
      commissionType: 'percentage',
      commissionValue: 20,
      sellerId: seller.id,
    });
    const { sent } = mockCheckout({ billingType: 'PIX', value: 450 });

    const res = await subscribe({
      ...buyer,
      classId: String(scenario.courseClass.id),
      paymentMethod: 'pix',
      couponCode: 'VENDEDOR',
    }).expect(201);

    // O gateway recebe a cobrança inteira: não há mais divisão nem subconta.
    expect(sent.createPayment.split).toBeUndefined();
    expect(sent.createPayment.value).toBe(450);

    // A comissão (20% de 450) fica na carteira do vendedor, prevista até o cliente pagar.
    const entries = await testDb().commercial_SellerWalletEntry.findMany({
      where: { financialRecordId: res.body.financialRecordId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sellerId: seller.id, type: 'comissao', origin: 'treinamento', status: 'prevista' });
    expect(Number(entries[0].amount)).toBe(90);
    expect(Number(entries[0].rate)).toBe(20);
    expect(entries[0].description).toContain('cupom VENDEDOR');
    // nada mais é gravado na tabela antiga
    expect(await testDb().splitTransaction.count({ where: { financialRecordId: res.body.financialRecordId } })).toBe(0);
  });

  it('recusa método de pagamento não aceito pela turma', async () => {
    const { courseClass } = await makeCheckoutScenario({
      paymentMethods: ['pix'],
    });

    const res = await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'boleto',
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('parcelamento envia installmentCount e valor da parcela ao gateway', async () => {
    const { courseClass } = await makeCheckoutScenario({
      price: 1200,
      dividedIn: 12,
    });
    const { sent } = mockCheckout({
      billingType: 'CREDIT_CARD',
      status: 'CONFIRMED',
      value: 1200,
    });

    await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'cartaoCredito',
      creditCard: JSON.stringify({
        cardName: 'ANA COSTA',
        cardNumber: '5162306219378829',
        expiryDate: '12/28',
        cvv: '318',
        installments: '3',
      }),
    }).expect(201);

    expect(sent.createPayment.value).toBe(1200);
    expect(sent.createPayment.installmentCount).toBe(3);
    expect(sent.createPayment.installmentValue).toBe(400);
  });
});
