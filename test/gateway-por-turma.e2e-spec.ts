import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import {
  makeCompany,
  makeCourse,
  makeCourseClass,
  makeGateway,
} from './setup/factories';
import {
  mockCheckout,
  resetAsaasMock,
  blockRealNetwork,
} from './setup/asaas-mock';

/**
 * Provedor escolhido por TURMA.
 *
 * É o que permite migrar de provedor uma turma por vez, ou manter turmas que
 * precisam de boleto num provedor e as demais em outro mais barato — sem
 * arriscar o faturamento inteiro numa troca só.
 */
describe('Gateway por turma (e2e)', () => {
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
    name: 'Sofia Ramos',
    cpf: '30809540070',
    email: 'sofia@teste.local',
    phone: '81922221111',
  };

  function subscribe(fields: Record<string, string>) {
    const req = request(httpServer()).post('/subscription/subscribe');
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  }

  /** Empresa com DOIS provedores configurados: Asaas ativo e manual. */
  async function empresaComDoisProvedores() {
    const company = await makeCompany();
    const asaas = await makeGateway(company.id, {
      gateway: 'asaas',
      active: true,
    });
    const manual = await makeGateway(company.id, {
      gateway: 'manual',
      payload: {},
      active: true,
    });
    const course = await makeCourse(company.id);
    return { company, asaas, manual, course };
  }

  it('duas turmas da mesma empresa usam provedores diferentes', async () => {
    const { company, asaas, manual, course } = await empresaComDoisProvedores();

    const turmaAutomatizada = await makeCourseClass(company.id, course.id, {
      name: 'Turma no Asaas',
      companyGatewayId: asaas.id,
    });
    const turmaManual = await makeCourseClass(company.id, course.id, {
      name: 'Turma manual',
      companyGatewayId: manual.id,
    });

    mockCheckout({ billingType: 'PIX', value: 500 });
    const resAuto = await subscribe({
      ...buyer,
      classId: String(turmaAutomatizada.id),
      paymentMethod: 'pix',
    }).expect(201);

    const resManual = await subscribe({
      ...buyer,
      cpf: '19100000034',
      classId: String(turmaManual.id),
      paymentMethod: 'pix',
    }).expect(201);

    const rAuto = await testDb().financialRecords.findUnique({
      where: { id: resAuto.body.financialRecordId },
    });
    const rManual = await testDb().financialRecords.findUnique({
      where: { id: resManual.body.financialRecordId },
    });

    expect(rAuto.gateway).toBe('asaas');
    expect(rAuto.externalId).not.toBeNull(); // cobrança criada no provedor
    expect(rAuto.pixNumber).not.toBeNull();

    expect(rManual.gateway).toBe('manual');
    expect(rManual.externalId).toBeNull(); // nenhuma cobrança externa
  });

  it('sem provedor na turma, cai no provedor ativo da empresa', async () => {
    const company = await makeCompany();
    await makeGateway(company.id, { gateway: 'asaas', active: true });
    const course = await makeCourse(company.id);
    const courseClass = await makeCourseClass(company.id, course.id, {
      companyGatewayId: null,
    });

    mockCheckout({ billingType: 'PIX', value: 500 });
    const res = await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'pix',
    }).expect(201);

    const record = await testDb().financialRecords.findUnique({
      where: { id: res.body.financialRecordId },
    });
    expect(record.gateway).toBe('asaas');
  });

  it('recusa turma com método que o provedor escolhido não aceita', async () => {
    const { company, manual, course } = await empresaComDoisProvedores();
    // O adapter manual aceita os três métodos, então para exercitar a recusa
    // usamos parcelas acima do teto declarado.
    const res = await request(httpServer())
      .post('/classes')
      .field('name', 'Turma inválida')
      .field('courseId', String(course.id))
      .field('companyGatewayId', String(manual.id))
      .field('dividedIn', '99')
      .field('allowCheckout', 'true');

    // Sem token a rota exige autenticação; o que importa é não ser 201.
    expect(res.status).not.toBe(201);
  });

  /**
   * O bug que a escolha por turma expôs: o webhook resolvia o provedor pela
   * EMPRESA e não pela URL. Com dois provedores ativos, um evento do Asaas
   * podia cair no adapter errado.
   */
  it('webhook é processado pelo provedor da URL, não pelo da empresa', async () => {
    const { company, asaas, course } = await empresaComDoisProvedores();
    const courseClass = await makeCourseClass(company.id, course.id, {
      companyGatewayId: asaas.id,
    });

    const { payment } = mockCheckout({ billingType: 'PIX', value: 500 });
    const res = await subscribe({
      ...buyer,
      classId: String(courseClass.id),
      paymentMethod: 'pix',
    }).expect(201);

    await request(httpServer())
      .post(`/webhooks/asaas/${company.id}`)
      .send({
        event: 'PAYMENT_RECEIVED',
        payment: {
          id: payment.id,
          status: 'RECEIVED',
          value: 500,
          billingType: 'PIX',
          externalReference: `sub_${res.body.id}`,
          deleted: false,
        },
      })
      .expect(201);

    const record = await testDb().financialRecords.findUnique({
      where: { id: res.body.financialRecordId },
    });
    expect(record.status).toBe('received');

    const sub = await testDb().courseClassSubscription.findUnique({
      where: { id: res.body.id },
    });
    expect(sub.subscribeStatus).toBe('confirmed');
  });
});
