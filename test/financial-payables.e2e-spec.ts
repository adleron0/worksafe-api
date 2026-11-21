import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Fornecedores e contas a pagar: cadastro, parcelas, baixa com conta de saída,
 * estorno, resumo e o reflexo no saldo das contas e no plano de contas.
 */
describe('Contas a pagar e fornecedores (e2e)', () => {
  const ALL = ['list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro', 'activate_financeiro'];
  let jwt: JwtService;
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
  const api = () => request(httpServer());

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const accounts = (await api().get('/financial/chart-accounts').set(auth(company.id)).expect(200)).body as Array<{ id: number; nature: string; acceptsEntries: boolean }>;
    const despesa = accounts.find((a) => a.nature === 'despesa' && a.acceptsEntries);
    const receita = accounts.find((a) => a.nature === 'receita' && a.acceptsEntries);
    const bank = (await api().post('/financial-bank-accounts').set(auth(company.id)).send({ name: 'Conta principal', type: 'corrente', openingBalance: 1000 }).expect(201)).body;
    const supplier = (await api().post('/financial-suppliers').set(auth(company.id)).send({ name: 'Andaimes Recife', document: '11.222.333/0001-81', pixKey: 'pix@andaimes.local' }).expect(201)).body;
    return { db, company, despesa, receita, bank, supplier };
  }

  const nova = (extra: Record<string, any> = {}) => ({ description: 'Locação de andaimes', value: 1000, dueDate: '2026-12-10', ...extra });
  const criar = (companyId: number, body: Record<string, any>) => api().post('/financial-payables').set(auth(companyId)).send(body);

  describe('fornecedores', () => {
    it('guarda o documento só com dígitos e não aceita repetido', async () => {
      const { db, company, supplier } = await cenario();
      expect((await db.financial_Supplier.findUnique({ where: { id: supplier.id } })).document).toBe('11222333000181');
      const dup = await api().post('/financial-suppliers').set(auth(company.id)).send({ name: 'Outro', document: '11222333000181' });
      expect(dup.status).toBe(409);
      await api().post('/financial-suppliers').set(auth(company.id)).send({ name: 'Sem doc', document: '123' }).expect(400);
      await api().post('/financial-suppliers').set(auth(company.id)).send({ name: 'A' }).expect(400);
    });

    it('grava o endereço com CEP formatado e UF em maiúsculas', async () => {
      const { db, company } = await cenario();
      const { body } = await api().post('/financial-suppliers').set(auth(company.id)).send({
        name: 'Com endereço', zipcode: '51020000', street: ' Rua  das Flores ', number: 'S/N', neighborhood: 'Boa Viagem', city: 'Recife', state: 'pe',
      }).expect(201);
      const row = await db.financial_Supplier.findUnique({ where: { id: body.id } });
      expect(row).toMatchObject({ zipcode: '51020-000', street: 'Rua das Flores', number: 'S/N', city: 'Recife', state: 'PE' });
      await api().put(`/financial-suppliers/${body.id}`).set(auth(company.id)).send({ zipcode: '123' }).expect(400);
      await api().put(`/financial-suppliers/${body.id}`).set(auth(company.id)).send({ state: 'Pernambuco' }).expect(400);
      await api().put(`/financial-suppliers/${body.id}`).set(auth(company.id)).send({ zipcode: '', city: '' }).expect(200);
      expect(await db.financial_Supplier.findUnique({ where: { id: body.id } })).toMatchObject({ zipcode: null, city: null, state: 'PE' });
    });

    it('não inativa fornecedor com conta em aberto', async () => {
      const { company, supplier } = await cenario();
      await criar(company.id, nova({ supplierId: supplier.id })).expect(201);
      const res = await api().patch(`/financial-suppliers/inactive/${supplier.id}`).set(auth(company.id));
      expect(res.status).toBe(409);
    });
  });

  describe('lançamento', () => {
    it('nasce aberta, com competência do vencimento, e ignora situação e pagamento do corpo', async () => {
      const { db, company, supplier, despesa, bank } = await cenario();
      const res = await criar(company.id, nova({
        supplierId: supplier.id, chartAccountId: despesa.id, status: 'paga', paidAt: '2026-01-01', paidValue: 5, bankAccountId: bank.id, origin: 'pedido_compra',
      })).expect(201);
      const row = await db.financial_Payable.findUnique({ where: { id: res.body.id } });
      expect(row.status).toBe('aberta');
      expect(row.paidAt).toBeNull();
      expect(row.bankAccountId).toBeNull();
      expect(row.origin).toBe('manual');
      expect(row.accrualDate).toBe('2026-12');
      expect(row.dueDate.toISOString()).toBe('2026-12-10T12:00:00.000Z');
      expect(row.companyId).toBe(company.id);
      expect(row.createdByUserId).toBe(userId);
    });

    it('recusa conta de receita, fornecedor de outra empresa e dados faltando', async () => {
      const { company, receita } = await cenario();
      const other = await makeCompany();
      const alheio = await testDb().financial_Supplier.create({ data: { companyId: other.id, name: 'De outra empresa' } });
      await criar(company.id, nova({ chartAccountId: receita.id })).expect(400);
      await criar(company.id, nova({ supplierId: alheio.id })).expect(400);
      await criar(company.id, nova({ value: 0 })).expect(400);
      await criar(company.id, nova({ dueDate: '2026-02-31' })).expect(400);
      await criar(company.id, nova({ description: '' })).expect(400);
    });

    it('sem permissão de criar, não lança; outra empresa não enxerga', async () => {
      const { company } = await cenario();
      await api().post('/financial-payables').set(auth(company.id, ['list_financeiro'])).send(nova()).expect(403);
      const { body } = await criar(company.id, nova()).expect(201);
      const other = await makeCompany();
      const list = await api().get('/financial-payables').set(auth(other.id)).expect(200);
      expect(list.body.total).toBe(0);
      await api().patch(`/financial-payables/settle/${body.id}`).set(auth(other.id)).send({}).expect(404);
    });
  });

  describe('parcelas', () => {
    it('divide o valor, põe os centavos na última e respeita mês curto', async () => {
      const { db, company, supplier } = await cenario();
      const res = await api().post('/financial-payables/installments').set(auth(company.id))
        .send(nova({ supplierId: supplier.id, dueDate: '2026-12-31', count: 3 })).expect(201);
      expect(res.body.count).toBe(3);
      const rows = await db.financial_Payable.findMany({ where: { groupKey: res.body.groupKey }, orderBy: { installmentNumber: 'asc' } });
      expect(rows.map((r) => Number(r.value))).toEqual([333.33, 333.33, 333.34]);
      expect(rows.map((r) => r.dueDate.toISOString().slice(0, 10))).toEqual(['2026-12-31', '2027-01-31', '2027-02-28']);
      expect(rows.map((r) => r.accrualDate)).toEqual(['2026-12', '2027-01', '2027-02']);
      expect(rows.every((r) => r.installmentTotal === 3 && r.supplierId === supplier.id && r.status === 'aberta')).toBe(true);
    });

    it('repete o mesmo valor (despesa fixa) e valida a quantidade', async () => {
      const { db, company } = await cenario();
      const res = await api().post('/financial-payables/installments').set(auth(company.id))
        .send(nova({ description: 'Aluguel', value: 2500, count: 4, mode: 'repetir' })).expect(201);
      const rows = await db.financial_Payable.findMany({ where: { groupKey: res.body.groupKey } });
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => Number(r.value) === 2500)).toBe(true);
      await api().post('/financial-payables/installments').set(auth(company.id)).send(nova({ count: 1 })).expect(400);
      await api().post('/financial-payables/installments').set(auth(company.id)).send(nova({ count: 61 })).expect(400);
      // nada fica pela metade quando um dado é inválido
      await api().post('/financial-payables/installments').set(auth(company.id)).send(nova({ value: 0.02, count: 3 })).expect(400);
      expect(await db.financial_Payable.count()).toBe(4);
    });
  });

  describe('baixa e estorno', () => {
    it('baixa com conta de saída reduz o saldo; estorno devolve', async () => {
      const { db, company, bank } = await cenario();
      const { body } = await criar(company.id, nova()).expect(201);
      const saldo = async () => (await api().get('/financial/bank-balances').set(auth(company.id)).expect(200)).body.find((b: any) => b.id === bank.id);
      expect((await saldo()).balance).toBe(1000);

      const paid = await api().patch(`/financial-payables/settle/${body.id}`).set(auth(company.id))
        .send({ paidAt: '2026-11-10', paidValue: 990.5, paymentMethod: 'pix', bankAccountId: bank.id }).expect(200);
      expect(paid.body.status).toBe('paga');
      const row = await db.financial_Payable.findUnique({ where: { id: body.id } });
      expect(Number(row.paidValue)).toBe(990.5);
      expect(row.bankAccountId).toBe(bank.id);
      expect(row.settledByUserId).toBe(userId);
      expect(row.paymentMethod).toBe('pix');
      expect((await saldo()).balance).toBe(9.5);
      expect((await saldo()).paid).toBe(990.5);

      // já paga: não baixa de novo, não muda valor, não exclui
      await api().patch(`/financial-payables/settle/${body.id}`).set(auth(company.id)).send({}).expect(409);
      await api().put(`/financial-payables/${body.id}`).set(auth(company.id)).send({ value: 5 }).expect(400);
      await api().patch(`/financial-payables/inactive/${body.id}`).set(auth(company.id)).expect(409);

      await api().patch(`/financial-payables/unsettle/${body.id}`).set(auth(company.id)).send({ reason: 'lançado na conta errada' }).expect(200);
      const back = await db.financial_Payable.findUnique({ where: { id: body.id } });
      expect(back.status).toBe('aberta');
      expect(back.paidAt).toBeNull();
      expect(back.bankAccountId).toBeNull();
      expect((await saldo()).balance).toBe(1000);
      const events = await db.flow_Event.findMany({ where: { entity: 'financial_payable', entityId: body.id }, orderBy: { id: 'asc' } });
      expect(events.map((e) => e.type)).toEqual(['baixa', 'estorno']);
      await api().patch(`/financial-payables/unsettle/${body.id}`).set(auth(company.id)).send({}).expect(409);
    });

    it('recusa data futura, conta bancária de outra empresa e valor inválido', async () => {
      const { company } = await cenario();
      const { body } = await criar(company.id, nova()).expect(201);
      const other = await makeCompany();
      const alheia = await testDb().financial_BankAccount.create({ data: { companyId: other.id, name: 'Alheia' } });
      await api().patch(`/financial-payables/settle/${body.id}`).set(auth(company.id)).send({ paidAt: '2099-01-01' }).expect(400);
      await api().patch(`/financial-payables/settle/${body.id}`).set(auth(company.id)).send({ bankAccountId: alheia.id }).expect(400);
      await api().patch(`/financial-payables/settle/${body.id}`).set(auth(company.id)).send({ paidValue: -1 }).expect(400);
      await api().patch(`/financial-payables/settle/${body.id}`).set(auth(company.id, ['list_financeiro'])).send({}).expect(403);
    });
  });

  describe('resumo e plano de contas', () => {
    it('separa atrasadas, as que vencem depois e as pagas', async () => {
      const { company } = await cenario();
      await criar(company.id, nova({ dueDate: '2020-01-10', value: 100 })).expect(201);
      await criar(company.id, nova({ dueDate: '2020-02-10', value: 50 })).expect(201);
      await criar(company.id, nova({ dueDate: '2099-01-10', value: 300 })).expect(201);
      const paga = (await criar(company.id, nova({ dueDate: '2020-03-10', value: 70 })).expect(201)).body;
      await api().patch(`/financial-payables/settle/${paga.id}`).set(auth(company.id)).send({}).expect(200);

      const { body } = await api().get('/financial/payables-summary').set(auth(company.id)).expect(200);
      expect(body.overdue).toEqual({ count: 2, total: 150 });
      expect(body.later).toEqual({ count: 1, total: 300 });
      expect(body.dueToday.count).toBe(0);
      expect(body.paid).toEqual({ count: 1, total: 70 });
      const mes = await api().get('/financial/payables-summary?month=2020-01').set(auth(company.id)).expect(200);
      expect(mes.body.paid.count).toBe(0);

      // a listagem filtra as atrasadas pelo vencimento
      const list = await api().get(`/financial-payables?status=aberta&lt-dueDate=${body.today}`).set(auth(company.id)).expect(200);
      expect(list.body.total).toBe(2);
    });

    it('a despesa aparece no total da conta do plano de contas', async () => {
      const { company, despesa } = await cenario();
      await criar(company.id, nova({ chartAccountId: despesa.id, value: 420 })).expect(201);
      const accounts = (await api().get('/financial/chart-accounts').set(auth(company.id)).expect(200)).body as Array<{ id: number; total: number; entries: number }>;
      const account = accounts.find((a) => a.id === despesa.id);
      expect(account.total).toBe(420);
      expect(account.entries).toBe(1);
    });
  });
});
