import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Contas a receber de empresas: lançamento manual, nota fiscal emitida fora
 * do sistema e baixa manual.
 *
 * O ponto sensível é que a tabela é a MESMA do checkout. Então metade destes
 * testes é sobre o que NÃO pode acontecer: baixar à mão uma cobrança do
 * Asaas, mudar status por PUT, mexer no recebível de outra empresa.
 */
describe('Contas a receber — NF e baixa manual (e2e)', () => {
  const ALL = ['list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro', 'activate_financeiro'];
  let jwt: JwtService;
  /** Usuário real do cenário: a auditoria grava quem fez, com FK para User. */
  let userId = 0;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  function tokenFor(companyId: number, permissions: string[] = ALL) {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' });
  }
  const auth = (companyId: number, permissions?: string[]) => ({ Authorization: `Bearer ${tokenFor(companyId, permissions)}` });

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } as any }).catch(() => null);
    const rank = await db.dOM_Ranks.findFirst();
    const state = await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } as any });
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } as any });
    const customer = await db.customer.create({
      data: {
        name: 'Indústria Alfa', corporateName: 'Indústria Alfa SA', cnpj: '11222333000181', companyId: company.id,
        rankId: rank.id, phone: '8133334444', email: 'financeiro@alfa.local', stateId: state.id, cityId: city.id,
      },
    });
    return { db, company, customer };
  }

  const novo = (customerId: number, extra: Record<string, any> = {}) => ({
    customerId, value: 12500.5, dueDate: '2026-12-10', description: 'Turma fechada NR-35', paymentMethod: 'transferencia', ...extra,
  });

  function criar(companyId: number, body: Record<string, any>) {
    return request(httpServer()).post('/financial-records').set(auth(companyId)).send(body);
  }

  describe('lançamento manual', () => {
    it('cria recebível manual em aberto, com competência derivada do vencimento', async () => {
      const { db, company, customer } = await cenario();
      const res = await criar(company.id, novo(customer.id)).expect(201);

      const record = await db.financialRecords.findUnique({ where: { id: res.body.id } });
      expect(record.gateway).toBe('manual');
      expect(record.status).toBe('waiting');
      expect(Number(record.value)).toBe(12500.5);
      expect(record.accrualDate).toBe('2026-12');
      expect(record.companyId).toBe(company.id);
      expect(record.paymentMethod).toBe('transferencia');
      // meio-dia UTC: o dia não muda no fuso do Brasil
      expect(record.dueDate.toISOString()).toBe('2026-12-10T12:00:00.000Z');
    });

    it('ignora gateway, status e pagamento enviados no corpo', async () => {
      const { db, company, customer } = await cenario();
      const res = await criar(company.id, novo(customer.id, {
        gateway: 'asaas', status: 'received', paidAt: '2026-11-01', receivedValue: 1, externalId: 'pay_forjado',
      })).expect(201);

      const record = await db.financialRecords.findUnique({ where: { id: res.body.id } });
      expect(record.gateway).toBe('manual');
      expect(record.status).toBe('waiting');
      expect(record.paidAt).toBeNull();
      expect(record.receivedValue).toBeNull();
      expect(record.externalId).toBeNull();
    });

    it.each([
      ['sem valor', { value: undefined }],
      ['valor zero', { value: 0 }],
      ['sem vencimento', { dueDate: undefined }],
      ['sem cliente', { customerId: undefined }],
      ['parcela maior que o total', { installmentNumber: 4, installmentTotal: 3 }],
    ])('recusa lançamento %s', async (_nome, extra) => {
      const { db, company, customer } = await cenario();
      await criar(company.id, novo(customer.id, extra)).expect(400);
      expect(await db.financialRecords.count()).toBe(0);
    });

    it('exige permissão de criação', async () => {
      const { company, customer } = await cenario();
      await request(httpServer()).post('/financial-records')
        .set(auth(company.id, ['list_financeiro'])).send(novo(customer.id)).expect(403);
    });
  });

  describe('nota fiscal', () => {
    it('registra número e data da NF, parcela e valor líquido', async () => {
      const { db, company, customer } = await cenario();
      const { body } = await criar(company.id, novo(customer.id)).expect(201);

      await request(httpServer()).put(`/financial-records/${body.id}`).set(auth(company.id))
        .send({ invoiceNumber: ' 2026/000123 ', invoiceIssuedAt: '2026-11-13', netValue: 11800, installmentNumber: 1, installmentTotal: 2 })
        .expect(200);

      const record = await db.financialRecords.findUnique({ where: { id: body.id } });
      expect(record.invoiceNumber).toBe('2026/000123');
      expect(record.invoiceIssuedAt.toISOString()).toBe('2026-11-13T12:00:00.000Z');
      expect(Number(record.netValue)).toBe(11800);
      expect([record.installmentNumber, record.installmentTotal]).toEqual([1, 2]);
    });

    it('filtra por número da NF e por cliente', async () => {
      const { company, customer } = await cenario();
      await criar(company.id, novo(customer.id, { invoiceNumber: 'NF-1' })).expect(201);
      await criar(company.id, novo(customer.id, { invoiceNumber: 'NF-2' })).expect(201);

      const porNf = await request(httpServer()).get('/financial-records').query({ invoiceNumber: 'NF-2' }).set(auth(company.id)).expect(200);
      expect(porNf.body.total).toBe(1);
      expect(porNf.body.rows[0].invoiceNumber).toBe('NF-2');

      const porCliente = await request(httpServer()).get('/financial-records').query({ customerId: customer.id, show: 'customer' }).set(auth(company.id)).expect(200);
      expect(porCliente.body.total).toBe(2);
      expect(porCliente.body.rows[0].customer.name).toBe('Indústria Alfa');
    });

    it('permite registrar NF em cobrança de gateway, mas não mudar o valor dela', async () => {
      const { db, company, customer } = await cenario();
      const asaas = await db.financialRecords.create({
        data: { companyId: company.id, customerId: customer.id, gateway: 'asaas', status: 'waiting', paymentMethod: 'boleto',
          value: 500, accrualDate: '2026-11', externalId: 'pay_1', dueDate: new Date('2026-11-20T12:00:00Z') },
      });

      await request(httpServer()).put(`/financial-records/${asaas.id}`).set(auth(company.id))
        .send({ invoiceNumber: 'NF-9', value: 500 }).expect(200);
      await request(httpServer()).put(`/financial-records/${asaas.id}`).set(auth(company.id))
        .send({ value: 1 }).expect(409);

      const record = await db.financialRecords.findUnique({ where: { id: asaas.id } });
      expect(record.invoiceNumber).toBe('NF-9');
      expect(Number(record.value)).toBe(500);
    });
  });

  describe('baixa manual', () => {
    it('dá baixa: recebido, data, valor recebido e quem baixou', async () => {
      const { db, company, customer } = await cenario();
      const { body } = await criar(company.id, novo(customer.id, { netValue: 11800 })).expect(201);

      await request(httpServer()).patch(`/financial-records/settle/${body.id}`).set(auth(company.id))
        .send({ paidAt: '2026-11-12', paymentMethod: 'pix', observations: 'Pix do Itaú' }).expect(200);

      const record = await db.financialRecords.findUnique({ where: { id: body.id } });
      expect(record.status).toBe('received');
      expect(record.paidAt.toISOString()).toBe('2026-11-12T12:00:00.000Z');
      // sem valor informado, entra o líquido esperado
      expect(Number(record.receivedValue)).toBe(11800);
      expect(record.paymentMethod).toBe('pix');
      expect(record.settledByUserId).toBe(userId);
      expect(record.observations).toBe('Pix do Itaú');
    });

    it('aceita valor recebido diferente do título', async () => {
      const { db, company, customer } = await cenario();
      const { body } = await criar(company.id, novo(customer.id)).expect(201);
      await request(httpServer()).patch(`/financial-records/settle/${body.id}`).set(auth(company.id))
        .send({ receivedValue: 12000 }).expect(200);
      const record = await db.financialRecords.findUnique({ where: { id: body.id } });
      expect(Number(record.receivedValue)).toBe(12000);
      expect(Number(record.value)).toBe(12500.5);
    });

    it('não baixa duas vezes, nem com data futura, nem valor inválido', async () => {
      const { company, customer } = await cenario();
      const { body } = await criar(company.id, novo(customer.id)).expect(201);
      const settle = (payload: Record<string, any>) =>
        request(httpServer()).patch(`/financial-records/settle/${body.id}`).set(auth(company.id)).send(payload);

      await settle({ paidAt: '2099-01-01' }).expect(400);
      await settle({ receivedValue: -5 }).expect(400);
      await settle({ paymentMethod: 'cheque' }).expect(400);
      await settle({}).expect(200);
      await settle({}).expect(409);
    });

    it('recusa baixa manual em cobrança de gateway', async () => {
      const { db, company, customer } = await cenario();
      const asaas = await db.financialRecords.create({
        data: { companyId: company.id, customerId: customer.id, gateway: 'asaas', status: 'waiting', paymentMethod: 'pix',
          value: 500, accrualDate: '2026-11', externalId: 'pay_2' },
      });
      await request(httpServer()).patch(`/financial-records/settle/${asaas.id}`).set(auth(company.id)).send({}).expect(409);
      expect((await db.financialRecords.findUnique({ where: { id: asaas.id } })).status).toBe('waiting');
    });

    it('PUT não muda status nem data de pagamento', async () => {
      const { db, company, customer } = await cenario();
      const { body } = await criar(company.id, novo(customer.id)).expect(201);
      await request(httpServer()).put(`/financial-records/${body.id}`).set(auth(company.id))
        .send({ status: 'received', paidAt: '2026-11-01', description: 'editado' }).expect(200);
      const record = await db.financialRecords.findUnique({ where: { id: body.id } });
      expect(record.status).toBe('waiting');
      expect(record.paidAt).toBeNull();
      expect(record.description).toBe('editado');
    });

    it('estorna a baixa e bloqueia mudar o valor enquanto baixado', async () => {
      const { db, company, customer } = await cenario();
      const { body } = await criar(company.id, novo(customer.id)).expect(201);
      await request(httpServer()).patch(`/financial-records/settle/${body.id}`).set(auth(company.id)).send({}).expect(200);

      await request(httpServer()).put(`/financial-records/${body.id}`).set(auth(company.id)).send({ value: 1 }).expect(409);

      await request(httpServer()).patch(`/financial-records/unsettle/${body.id}`).set(auth(company.id)).expect(200);
      const record = await db.financialRecords.findUnique({ where: { id: body.id } });
      expect(record.status).toBe('waiting');
      expect(record.paidAt).toBeNull();
      expect(record.receivedValue).toBeNull();
      expect(record.settledByUserId).toBeNull();

      await request(httpServer()).patch(`/financial-records/unsettle/${body.id}`).set(auth(company.id)).expect(409);
    });

    it('não enxerga recebível de outra empresa', async () => {
      const { db, company, customer } = await cenario();
      const outra = await makeCompany();
      const { body } = await criar(company.id, novo(customer.id)).expect(201);

      await request(httpServer()).patch(`/financial-records/settle/${body.id}`).set(auth(outra.id)).send({}).expect(404);
      expect((await db.financialRecords.findUnique({ where: { id: body.id } })).status).toBe('waiting');
    });

    it('exige permissão de edição para baixar e estornar', async () => {
      const { company, customer } = await cenario();
      const { body } = await criar(company.id, novo(customer.id)).expect(201);
      const leitor = auth(company.id, ['list_financeiro']);
      await request(httpServer()).patch(`/financial-records/settle/${body.id}`).set(leitor).send({}).expect(403);
      await request(httpServer()).patch(`/financial-records/unsettle/${body.id}`).set(leitor).expect(403);
      await request(httpServer()).patch(`/financial-records/settle/${body.id}`).send({}).expect(401);
    });
  });
});
