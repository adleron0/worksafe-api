import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCheckoutScenario, makeGateway } from './setup/factories';
import {
  mockCheckout,
  resetAsaasMock,
  blockRealNetwork,
} from './setup/asaas-mock';

/**
 * Prova do desacoplamento (fase 1).
 *
 * O checkout não conhece mais fornecedor: ele pede um adapter ao
 * GatewayResolver e valida contra as capabilities declaradas. Estes testes
 * cobrem o que antes era o `if (gateway !== asaas) throw 501` espalhado e o
 * `selectFirst` sem desempate.
 */
describe('Resolução de gateway (e2e)', () => {
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
    name: 'Carlos Dias',
    cpf: '19100000034',
    email: 'carlos@teste.local',
    phone: '81955554444',
  };

  function subscribe(fields: Record<string, string>) {
    const req = request(httpServer()).post('/subscription/subscribe');
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  }

  it('sem gateway ativo, o checkout falha e a inscrição não confirma', async () => {
    const scenario = await makeCheckoutScenario();
    await testDb().companyGateWays.updateMany({
      where: { companyId: scenario.company.id },
      data: { active: false },
    });

    const res = await subscribe({
      ...buyer,
      classId: String(scenario.courseClass.id),
      paymentMethod: 'pix',
    }).expect(201);

    // A inscrição é criada como pendente, mas sem cobrança: o erro do
    // checkout é reportado sem derrubar o cadastro.
    expect(res.body.paymentError).toBeDefined();
    expect(res.body.financialRecordId).toBeUndefined();
  });

  it('gateway configurado mas não implementado não é escolhido silenciosamente', async () => {
    const scenario = await makeCheckoutScenario();
    // Empresa migrando: desliga o Asaas e deixa só um gateway sem adapter.
    await testDb().companyGateWays.updateMany({
      where: { companyId: scenario.company.id },
      data: { active: false },
    });
    await makeGateway(scenario.company.id, {
      gateway: 'stripe',
      payload: { secretKey: 'sk_teste' },
      active: true,
    });

    const res = await subscribe({
      ...buyer,
      classId: String(scenario.courseClass.id),
      paymentMethod: 'pix',
    }).expect(201);

    expect(res.body.paymentError).toMatch(/não está implementad/i);
  });

  /**
   * R5 do plano: com dois gateways ativos — o cenário real de uma migração —
   * a escolha antes dependia da ordem que o banco devolvesse. Agora o
   * resolver ignora o que não tem adapter e usa o implementado.
   */
  it('com dois gateways ativos, escolhe deterministicamente o implementado', async () => {
    const scenario = await makeCheckoutScenario();
    await makeGateway(scenario.company.id, {
      gateway: 'mercadoPago',
      payload: { accessToken: 'mp_teste' },
      active: true,
    });
    mockCheckout({ billingType: 'PIX', value: 500 });

    const res = await subscribe({
      ...buyer,
      classId: String(scenario.courseClass.id),
      paymentMethod: 'pix',
    }).expect(201);

    expect(res.body.paymentError).toBeUndefined();
    expect(res.body.financialRecord.gateway).toBe('asaas');
    expect(res.body.financialRecord.status).toBe('waiting');
  });
});
