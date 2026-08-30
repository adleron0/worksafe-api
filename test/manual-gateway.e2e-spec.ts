import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import {
  makeCompany,
  makeCourse,
  makeCourseClass,
  makeGateway,
  makeCoupon,
  makeSeller,
} from './setup/factories';
import { resetAsaasMock, blockRealNetwork } from './setup/asaas-mock';

/**
 * Operação SEM provedor de pagamento.
 *
 * O aluno se inscreve, a inscrição fica pendente, o pagamento é combinado por
 * fora e alguém dá baixa no painel. Comissão e desconto são calculados e
 * registrados normalmente — o que muda é que ninguém cobra nem repassa
 * automaticamente.
 *
 * O `blockRealNetwork` sem nenhum mock registrado é parte da asserção: se o
 * modo manual tentasse falar com qualquer provedor, o teste falharia com erro
 * de rede em vez de passar silenciosamente.
 */
describe('Gateway manual — sem provedor (e2e)', () => {
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
    name: 'Rita Nunes',
    cpf: '86288366757',
    email: 'rita@teste.local',
    phone: '81933332222',
  };

  async function manualScenario(classOverrides: Record<string, any> = {}) {
    const company = await makeCompany();
    await makeGateway(company.id, { gateway: 'manual', payload: {}, active: true });
    const course = await makeCourse(company.id);
    const courseClass = await makeCourseClass(company.id, course.id, {
      price: 500,
      ...classOverrides,
    });
    return { company, course, courseClass };
  }

  function subscribe(fields: Record<string, string>) {
    const req = request(httpServer()).post('/subscription/subscribe');
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  }

  it('cria inscrição pendente e cobrança local, sem falar com provedor', async () => {
    const { courseClass } = await manualScenario();

    const res = await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'pix',
    }).expect(201);

    // A inscrição aguarda aprovação humana.
    expect(res.body.subscribeStatus).toBe('pending');

    const record = await testDb().financialRecords.findUnique({
      where: { id: res.body.financialRecordId },
    });

    expect(record).not.toBeNull();
    expect(record.gateway).toBe('manual');
    expect(Number(record.value)).toBe(500);
    // Nenhum provedor gerou cobrança: não há id externo nem QR nem boleto.
    expect(record.externalId).toBeNull();
    expect(record.pixUrl).toBeNull();
    expect(record.billUrl).toBeNull();
  });

  it('aceita boleto, que o provedor automatizado também aceitaria', async () => {
    const { courseClass } = await manualScenario({
      paymentMethods: ['boleto'],
    });

    const res = await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'boleto',
    }).expect(201);

    const record = await testDb().financialRecords.findUnique({
      where: { id: res.body.financialRecordId },
    });
    expect(record.paymentMethod).toBe('boleto');
    expect(record.externalId).toBeNull();
  });

  it('aplica desconto de cupom e registra a comissão para repasse manual', async () => {
    const { company, courseClass } = await manualScenario();
    const seller = await makeSeller(company.id, { sellerConfig: {} });
    await makeCoupon(company.id, {
      code: 'MANUAL10',
      discountType: 'percentage',
      discountValue: 10,
      commissionType: 'percentage',
      commissionValue: 20,
      sellerId: seller.id,
    });

    const res = await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'pix',
      couponCode: 'MANUAL10',
    }).expect(201);

    const record = await testDb().financialRecords.findUnique({
      where: { id: res.body.financialRecordId },
    });
    // O desconto é regra nossa: vale igual, com ou sem provedor.
    expect(Number(record.value)).toBe(450);
    expect(Number(record.originalValue)).toBe(500);

    const splits = await testDb().splitTransaction.findMany({
      where: { financialRecordId: res.body.financialRecordId },
    });

    // O ponto deste teste: a comissão NÃO some por não haver carteira.
    // Ela fica registrada, sem destino, aguardando repasse por fora.
    expect(splits).toHaveLength(1);
    expect(splits[0].sellerId).toBe(seller.id);
    expect(splits[0].toWalletId).toBeNull();
    expect(splits[0].status).toBe('PENDING');
    expect(splits[0].splitDescription).toMatch(/repasse manual/i);
    // Sem taxa de provedor: o vendedor recebe o valor cheio combinado.
    expect(Number(splits[0].netValue)).toBe(Number(splits[0].splitValue));
  });

  it('baixa manual: marcar como recebido não depende de webhook', async () => {
    const { courseClass } = await manualScenario();
    const res = await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'pix',
    }).expect(201);

    // É o que o painel faz hoje ao dar baixa.
    await testDb().financialRecords.update({
      where: { id: res.body.financialRecordId },
      data: { status: 'received', paidAt: new Date() },
    });

    const record = await testDb().financialRecords.findUnique({
      where: { id: res.body.financialRecordId },
    });
    expect(record.status).toBe('received');
    expect(record.paidAt).not.toBeNull();
  });
});
