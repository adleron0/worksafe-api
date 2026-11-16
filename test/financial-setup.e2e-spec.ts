import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Implantação do financeiro: data inicial da empresa e saldo inicial das
 * contas. Antes da data nada mexe no saldo; Contas Bancárias, Fluxo de caixa e
 * Conciliação contam igual, e a conciliação confere o saldo do extrato.
 */
describe('Financeiro — implantação: data e saldo inicial (e2e)', () => {
  const ALL = ['list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro', 'activate_financeiro'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => { const app = await bootTestApp(); jwt = app.get(JwtService); });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions = ALL) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());
  const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const plus = (days: number) => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const bank = (await api().post('/financial-bank-accounts').set(auth(company.id)).send({ name: 'Itaú', type: 'corrente' }).expect(201)).body;
    const caixa = (await api().post('/financial-bank-accounts').set(auth(company.id)).send({ name: 'Caixa', type: 'caixa' }).expect(201)).body;
    return { db: testDb(), company, bank, caixa };
  }
  const paidPayable = async (companyId: number, value: number, paidAt: string, bankAccountId?: number) => {
    const p = (await api().post('/financial-payables').set(auth(companyId)).send({ description: `Conta ${value}`, value, dueDate: paidAt }).expect(201)).body;
    await api().patch(`/financial-payables/settle/${p.id}`).set(auth(companyId)).send({ paidAt, ...(bankAccountId ? { bankAccountId } : {}) }).expect(200);
    return p;
  };
  const balanceOf = async (companyId: number, id: number) =>
    ((await api().get('/financial/bank-balances').set(auth(companyId)).expect(200)).body as any[]).find((b) => b.id === id);

  it('sugere o 1º dia do mês anterior, grava data e saldos e a conta nova nasce com a data', async () => {
    const { company, bank, caixa } = await cenario();
    const first = (await api().get('/financial/setup').set(auth(company.id)).expect(200)).body;
    const t = today();
    const expected = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
    expect(first.startDate).toBeNull();
    expect(first.suggestedStartDate).toBe(expected);
    expect(first.accounts.map((a: any) => a.name).sort()).toEqual(['Caixa', 'Itaú']);

    await api().put('/financial/setup').set(auth(company.id, ['list_financeiro'])).send({ startDate: plus(-20), accounts: [] }).expect(403);
    await api().put('/financial/setup').set(auth(company.id)).send({ startDate: plus(2), accounts: [] }).expect(400);
    const saved = (await api().put('/financial/setup').set(auth(company.id)).send({
      startDate: plus(-20), accounts: [{ id: bank.id, openingBalance: 5000.5 }, { id: caixa.id, openingBalance: '' }],
    }).expect(200)).body;
    expect(saved.startDate).toBe(plus(-20));
    expect(saved.accounts.find((a: any) => a.id === bank.id)).toMatchObject({ openingBalance: 5000.5, openingBalanceDate: plus(-20), start: plus(-20), balance: 5000.5 });

    const nova = (await api().post('/financial-bank-accounts').set(auth(company.id)).send({ name: 'Nubank', type: 'corrente', openingBalance: 10 }).expect(201)).body;
    expect(nova.openingBalanceDate.slice(0, 10)).toBe(plus(-20));
    const propria = (await api().post('/financial-bank-accounts').set(auth(company.id)).send({ name: 'Inter', type: 'corrente', openingBalanceDate: plus(-3) }).expect(201)).body;
    expect(propria.openingBalanceDate.slice(0, 10)).toBe(plus(-3));
  });

  it('o que foi pago antes da data não mexe no saldo, no fluxo de caixa nem fora de conta', async () => {
    const { company, bank, caixa } = await cenario();
    await api().put('/financial/setup').set(auth(company.id)).send({ startDate: plus(-20), accounts: [{ id: bank.id, openingBalance: 1000 }, { id: caixa.id, openingBalance: 0 }] }).expect(200);
    await paidPayable(company.id, 300, plus(-25), bank.id); // antes: já está no saldo inicial
    await paidPayable(company.id, 200, plus(-5), bank.id);
    await paidPayable(company.id, 70, plus(-25)); // sem conta, antes da data
    await paidPayable(company.id, 30, plus(-4)); // sem conta, depois
    await api().post('/financial/transfers').set(auth(company.id)).send({ fromBankAccountId: bank.id, toBankAccountId: caixa.id, value: 100, date: plus(-2) }).expect(201);

    expect((await balanceOf(company.id, bank.id)).balance).toBe(700);
    expect((await balanceOf(company.id, caixa.id)).balance).toBe(100);

    const setup = (await api().get('/financial/setup').set(auth(company.id)).expect(200)).body;
    expect(setup.before.paid.count).toBe(2);
    expect(setup.progress.paidSince).toBe(2);

    // por conta: o fluxo começa no saldo do fim da véspera e bate com Contas Bancárias
    const flow = (await api().get('/financial/reports/cash-flow').query({ from: plus(-30), to: today(), group: 'day', bankAccountId: bank.id }).set(auth(company.id)).expect(200)).body;
    expect(flow.opening).toBe(0); // a conta ainda não existia
    expect(flow.totals.realizedOut).toBe(200);
    expect(flow.totals.transfers).toBe(-100);
    expect(flow.closing).toBe(700);
    const startRow = flow.rows.find((r: any) => r.key === plus(-20));
    expect(startRow.opening).toBe(1000);

    const inside = (await api().get('/financial/reports/cash-flow').query({ from: plus(-10), to: today(), group: 'day', bankAccountId: bank.id }).set(auth(company.id)).expect(200)).body;
    expect(inside.opening).toBe(1000);

    // empresa toda: o que saiu sem conta conta só a partir da data inicial
    const all = (await api().get('/financial/reports/cash-flow').query({ from: plus(-10), to: today(), group: 'day' }).set(auth(company.id)).expect(200)).body;
    expect(all.opening).toBe(1000);
    expect(all.totals.realizedOut).toBe(230);
    expect(all.totals.transfers).toBe(0);
    expect(all.closing).toBe(770);
  });

  it('conciliação: ignora o que é anterior à data, lança entrada sem par e confere o saldo do extrato', async () => {
    const { db, company, bank } = await cenario();
    await api().put('/financial/setup').set(auth(company.id)).send({ startDate: plus(-10), accounts: [{ id: bank.id, openingBalance: 2000 }] }).expect(200);
    const p = (await api().post('/financial-payables').set(auth(company.id)).send({ description: 'Energia', value: 389.9, dueDate: plus(-3) }).expect(201)).body;
    const d = (n: number) => plus(n).replace(/-/g, '');
    const ofx = `OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>341<ACCTID>12345</BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${d(-12)}<TRNAMT>-500.00<FITID>B0<MEMO>ALUGUEL</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${d(-3)}<TRNAMT>-389.90<FITID>B1<MEMO>PAG CELPE</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>${d(-2)}<TRNAMT>12.34<FITID>B2<MEMO>REND PAGO APLIC</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>1622.44<DTASOF>${d(-1)}</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const preview = (await api().post('/financial/reconciliation/preview').set(auth(company.id)).send({ bankAccountId: bank.id, content: ofx }).expect(201)).body;
    expect(preview.start).toBe(plus(-10));
    expect(preview.totals).toMatchObject({ lines: 3, beforeStart: 1, suggested: 1, unmatched: 1 });
    expect(preview.items[0].status).toBe('antes_inicio');
    expect(preview.balance).toEqual({ date: plus(-1), statement: 1622.44, system: 2000, opening: 2000 });

    const [l0, l1, l2] = preview.items;
    const applied = (await api().post('/financial/reconciliation/apply').set(auth(company.id)).send({
      bankAccountId: bank.id,
      items: [
        { ...l0, action: 'criar', description: 'Aluguel antigo' },
        { ...l1, action: 'baixar', type: 'payable', targetId: p.id },
        { ...l2, action: 'criar', description: 'Rendimento da aplicação' },
      ],
    }).expect(201)).body;
    expect(applied.applied).toBe(2);
    expect(applied.errors[0]).toMatchObject({ fitId: 'B0' });
    const income = await db.financialRecords.findFirst({ where: { companyId: company.id, description: 'Rendimento da aplicação' } });
    expect(income).toMatchObject({ status: 'received', gateway: 'manual', bankAccountId: bank.id });
    expect(Number(income!.receivedValue)).toBe(12.34);

    const again = (await api().post('/financial/reconciliation/preview').set(auth(company.id)).send({ bankAccountId: bank.id, content: ofx }).expect(201)).body;
    expect(again.totals).toMatchObject({ reconciled: 2, beforeStart: 1 });
    expect(again.balance.system).toBe(1622.44);
    expect(again.balance.statement).toBe(1622.44);
  });
});
