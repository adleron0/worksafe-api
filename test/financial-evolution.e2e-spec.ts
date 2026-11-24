import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Evolução do financeiro: listas filtradas com totais, exportação, lote,
 * juros/multa/desconto, parcelas em grupo, recorrência, relatórios,
 * transferências e conciliação de extrato.
 */
describe('Financeiro — filtros, lote, recorrência, relatórios e conciliação (e2e)', () => {
  const ALL = ['list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro', 'activate_financeiro'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => { const app = await bootTestApp(); jwt = app.get(JwtService); });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions: ALL, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());
  const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const plus = (days: number) => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const accounts = (await api().get('/financial/chart-accounts').set(auth(company.id)).expect(200)).body as Array<{ id: number; code: string; nature: string; acceptsEntries: boolean; level: number; dreGroup: string | null }>;
    const despesas = accounts.filter((a) => a.nature === 'despesa' && a.acceptsEntries);
    const receita = accounts.find((a) => a.nature === 'receita' && a.acceptsEntries && a.level === 3)!;
    const bank = (await api().post('/financial-bank-accounts').set(auth(company.id)).send({ name: 'Conta principal', type: 'corrente', openingBalance: 1000 }).expect(201)).body;
    const caixa = (await api().post('/financial-bank-accounts').set(auth(company.id)).send({ name: 'Caixa', type: 'caixa', openingBalance: 0 }).expect(201)).body;
    const supplier = (await api().post('/financial-suppliers').set(auth(company.id)).send({ name: 'Andaimes Recife', document: '11.222.333/0001-81' }).expect(201)).body;
    const other = (await api().post('/financial-suppliers').set(auth(company.id)).send({ name: 'Posto Boa Viagem' }).expect(201)).body;
    await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } as any }).catch(() => null);
    const rank = await db.dOM_Ranks.findFirst();
    const state = await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } as any });
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } as any });
    const customer = await db.customer.create({
      data: { name: 'Indústria Alfa', corporateName: 'Indústria Alfa SA', cnpj: '11222333000181', companyId: company.id, rankId: rank!.id, phone: '8133334444', email: 'fin@alfa.local', stateId: state.id, cityId: city.id } as any,
    });
    return { db, company, despesas, receita, accounts, bank, caixa, supplier, other, customer };
  }
  const payable = (companyId: number, body: Record<string, any>) => api().post('/financial-payables').set(auth(companyId)).send({ description: 'Conta', value: 100, dueDate: plus(3), ...body }).expect(201).then((r) => r.body);
  const receivable = (companyId: number, body: Record<string, any>) => api().post('/financial-records').set(auth(companyId)).send({ description: 'Serviço', value: 100, dueDate: plus(3), ...body }).expect(201).then((r) => r.body);

  describe('lista de contas a pagar', () => {
    it('filtra por busca, fornecedor, valor e conta mãe, e os cartões seguem o filtro', async () => {
      const { company, supplier, other, despesas } = await cenario();
      const pessoal = despesas[0];
      await payable(company.id, { description: 'Locação de andaimes', value: 1500, supplierId: supplier.id, dueDate: plus(-2), documentNumber: 'NF-778' });
      await payable(company.id, { description: 'Combustível', value: 300, supplierId: other.id, dueDate: today(), chartAccountId: pessoal.id });
      await payable(company.id, { description: 'Internet', value: 120, dueDate: plus(5) });
      await payable(company.id, { description: 'Aluguel', value: 2500, dueDate: plus(20) });

      const all = (await api().get('/financial/payables').set(auth(company.id)).expect(200)).body;
      expect(all.total).toBe(4);
      expect(all.summary.overdue).toEqual({ count: 1, total: 1500 });
      expect(all.summary.dueToday).toEqual({ count: 1, total: 300 });
      expect(all.summary.dueWeek).toEqual({ count: 1, total: 120 });
      expect(all.summary.later).toEqual({ count: 1, total: 2500 });

      const bySupplier = (await api().get('/financial/payables').query({ supplierId: supplier.id }).set(auth(company.id)).expect(200)).body;
      expect(bySupplier.total).toBe(1);
      expect(bySupplier.summary.dueToday.count).toBe(0);
      expect(bySupplier.summary.overdue.total).toBe(1500);

      expect((await api().get('/financial/payables').query({ q: 'nf-778' }).set(auth(company.id))).body.rows.map((r: any) => r.description)).toEqual(['Locação de andaimes']);
      expect((await api().get('/financial/payables').query({ q: 'posto' }).set(auth(company.id))).body.total).toBe(1);
      expect((await api().get('/financial/payables').query({ q: '11.222.333/0001-81' }).set(auth(company.id))).body.total).toBe(1);
      expect((await api().get('/financial/payables').query({ minValue: '200', maxValue: '1.500,00' }).set(auth(company.id))).body.total).toBe(2);
      expect((await api().get('/financial/payables').query({ view: 'atrasadas' }).set(auth(company.id))).body.total).toBe(1);
      expect((await api().get('/financial/payables').query({ dueFrom: today(), dueTo: plus(7) }).set(auth(company.id))).body.total).toBe(2);
      // conta mãe "Despesas" (raiz) pega a filha
      const root = (await api().get('/financial/chart-accounts').set(auth(company.id))).body.find((a: any) => a.code === pessoal.code.split('.')[0]);
      expect((await api().get('/financial/payables').query({ chartAccountId: root.id }).set(auth(company.id))).body.total).toBe(1);
      expect((await api().get('/financial/payables').query({ order: 'value:desc', limit: 1 }).set(auth(company.id))).body.rows[0].description).toBe('Aluguel');
      await api().get('/financial/payables').query({ dueFrom: '2026-02-31' }).set(auth(company.id)).expect(400);
    });

    it('exporta a planilha com o mesmo recorte', async () => {
      const { company } = await cenario();
      await payable(company.id, { description: 'Internet' });
      const res = await api().get('/financial/payables/export').query({ view: 'todas' }).set(auth(company.id)).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      expect((res.body as Buffer).includes(Buffer.from('Internet'))).toBe(false); // comprimido no zip
      expect(res.headers['content-disposition']).toMatch(/contas-a-pagar-.*\.xlsx/);
    });
  });

  describe('baixa', () => {
    it('separa juros, multa e desconto e calcula o valor pago', async () => {
      const { db, company, bank } = await cenario();
      const a = await payable(company.id, { value: 1000 });
      await api().patch(`/financial-payables/settle/${a.id}`).set(auth(company.id)).send({ bankAccountId: bank.id, interestValue: 12.5, fineValue: 20, discountValue: 2.5 }).expect(200);
      const row = await db.financial_Payable.findUnique({ where: { id: a.id } });
      expect(Number(row!.paidValue)).toBe(1030);
      expect(Number(row!.interestValue)).toBe(12.5);
      const b = await payable(company.id, { value: 1000 });
      await api().patch(`/financial-payables/settle/${b.id}`).set(auth(company.id)).send({ paidValue: 950 }).expect(200);
      expect(Number((await db.financial_Payable.findUnique({ where: { id: b.id } }))!.discountValue)).toBe(50);
      await api().patch(`/financial-payables/unsettle/${b.id}`).set(auth(company.id)).send({}).expect(200);
      expect((await db.financial_Payable.findUnique({ where: { id: b.id } }))!.discountValue).toBeNull();
    });

    it('baixa e exclui em lote, ignorando o que não pode', async () => {
      const { db, company, bank } = await cenario();
      const a = await payable(company.id, { value: 100 });
      const b = await payable(company.id, { value: 200 });
      const c = await payable(company.id, { value: 300 });
      await api().patch(`/financial-payables/settle/${c.id}`).set(auth(company.id)).send({}).expect(200);
      const res = (await api().post('/financial/payables/bulk-settle').set(auth(company.id)).send({ ids: [a.id, b.id, c.id], paidAt: today(), bankAccountId: bank.id, paymentMethod: 'pix' }).expect(201)).body;
      expect(res.settled).toBe(2);
      expect(res.skipped).toEqual([{ id: c.id, reason: 'Esta conta já está paga' }]);
      expect(Number((await db.financial_Payable.findUnique({ where: { id: b.id } }))!.paidValue)).toBe(200);
      const d = await payable(company.id, {});
      const archived = (await api().post('/financial/payables/bulk-archive').set(auth(company.id)).send({ ids: [a.id, d.id] }).expect(201)).body;
      expect(archived.archived).toBe(1);
      expect(archived.skipped[0].id).toBe(a.id);
    });

    it('a receber: baixa em lote, juros e trava de inativar recebido', async () => {
      const { db, company, customer, bank } = await cenario();
      const r1 = await receivable(company.id, { customerId: customer.id, value: 500 });
      const r2 = await receivable(company.id, { customerId: customer.id, value: 700, dueDate: plus(-5) });
      const list = (await api().get('/financial/receivables').set(auth(company.id)).expect(200)).body;
      expect(list.total).toBe(2);
      expect(list.summary.overdue).toEqual({ count: 1, total: 700 });
      expect((await api().get('/financial/receivables').query({ q: 'alfa' }).set(auth(company.id))).body.total).toBe(2);
      await api().patch(`/financial-records/settle/${r2.id}`).set(auth(company.id)).send({ fineValue: 14, interestValue: 7 }).expect(200);
      expect(Number((await db.financialRecords.findUnique({ where: { id: r2.id } }))!.receivedValue)).toBe(721);
      await api().patch(`/financial-records/inactive/${r2.id}`).set(auth(company.id)).expect(409);
      const bulk = (await api().post('/financial/receivables/bulk-settle').set(auth(company.id)).send({ ids: [r1.id, r2.id], bankAccountId: bank.id }).expect(201)).body;
      expect(bulk.settled).toBe(1);
      const received = (await api().get('/financial/receivables').query({ view: 'recebidas' }).set(auth(company.id))).body;
      expect(received.total).toBe(2);
      expect(received.summary.received.total).toBe(1221);
    });

    it('cartão de recebidas/pagas segue o recorte da lista (sem filtro de data: todas)', async () => {
      const { company, customer, bank } = await cenario();
      const t = today();
      const prev = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 2, 15)).toISOString().slice(0, 10);
      const [from, to] = [`${prev.slice(0, 7)}-01`, new Date(Date.UTC(Number(prev.slice(0, 4)), Number(prev.slice(5, 7)), 0)).toISOString().slice(0, 10)];
      const r = await receivable(company.id, { customerId: customer.id, value: 250, dueDate: prev });
      await api().patch(`/financial-records/settle/${r.id}`).set(auth(company.id)).send({ paidAt: prev, bankAccountId: bank.id }).expect(200);
      const p = await payable(company.id, { value: 90, dueDate: prev });
      await api().patch(`/financial-payables/settle/${p.id}`).set(auth(company.id)).send({ paidAt: prev, bankAccountId: bank.id }).expect(200);

      // sem filtro de data: o cartão mostra todas as recebidas da lista (inclusive as de meses passados)
      const plain = (await api().get('/financial/receivables').set(auth(company.id)).expect(200)).body;
      expect(plain.summary.received).toEqual({ count: 1, total: 250 });
      expect(plain.summary.paidPeriod).toBe('tudo');
      expect(plain.summary.all.count).toBe(1);
      const plainPay = (await api().get('/financial/payables').set(auth(company.id)).expect(200)).body;
      expect(plainPay.summary.paid).toEqual({ count: 1, total: 90 });
      expect(plainPay.summary.excluded.count).toBe(0);
      // vencimento no mês passado: o cartão mostra o que foi recebido nesse recorte
      const byDue = (await api().get('/financial/receivables').query({ dueFrom: from, dueTo: to }).set(auth(company.id)).expect(200)).body;
      expect(byDue.summary.received).toEqual({ count: 1, total: 250 });
      expect(byDue.summary.paidPeriod).toBe('filtro');
      const byAccrual = (await api().get('/financial/receivables').query({ accrualFrom: prev.slice(0, 7), accrualTo: prev.slice(0, 7) }).set(auth(company.id)).expect(200)).body;
      expect(byAccrual.summary.received.total).toBe(250);
      const payDue = (await api().get('/financial/payables').query({ dueFrom: from, dueTo: to }).set(auth(company.id)).expect(200)).body;
      expect(payDue.summary.paid).toEqual({ count: 1, total: 90 });
    });
  });

  it('altera esta e as próximas parcelas, sem mexer na paga', async () => {
    const { db, company, supplier } = await cenario();
    const group = (await api().post('/financial-payables/installments').set(auth(company.id)).send({ description: 'Notebook', value: 3000, dueDate: plus(1), count: 3, mode: 'dividir' }).expect(201)).body;
    await api().patch(`/financial-payables/settle/${group.ids[0]}`).set(auth(company.id)).send({}).expect(200);
    await api().put(`/financial/payables/group/${group.groupKey}`).set(auth(company.id)).send({ scope: 'proximas', fromId: group.ids[1], supplierId: supplier.id, description: 'Notebook Dell' }).expect(200);
    const rows = await db.financial_Payable.findMany({ where: { groupKey: group.groupKey }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => r.description)).toEqual(['Notebook', 'Notebook Dell', 'Notebook Dell']);
    expect(rows[0].supplierId).toBeNull();
    expect(rows[2].supplierId).toBe(supplier.id);
  });

  describe('recorrência', () => {
    it('gera 12 meses à frente, muda as futuras e encerra removendo as que não venceram', async () => {
      const { db, company, supplier, despesas } = await cenario();
      const rule = (await api().post('/financial/recurrences').set(auth(company.id)).send({
        kind: 'payable', description: 'Aluguel do galpão', value: 4200, startDate: plus(-40), supplierId: supplier.id, chartAccountId: despesas[1].id,
      }).expect(201)).body;
      const rows = await db.financial_Payable.findMany({ where: { recurrenceId: rule.id }, orderBy: { dueDate: 'asc' } });
      expect(rows.length).toBeGreaterThanOrEqual(13);
      expect(rows.every((r) => Number(r.value) === 4200 && r.supplierId === supplier.id)).toBe(true);
      // não duplica ao listar de novo
      await api().get('/financial/recurrences').set(auth(company.id)).expect(200);
      expect(await db.financial_Payable.count({ where: { recurrenceId: rule.id } })).toBe(rows.length);

      await api().put(`/financial/recurrences/${rule.id}`).set(auth(company.id)).send({ value: 4500 }).expect(200);
      const after = await db.financial_Payable.findMany({ where: { recurrenceId: rule.id }, orderBy: { dueDate: 'asc' } });
      expect(Number(after[0].value)).toBe(4200); // vencida fica como estava
      expect(Number(after[after.length - 1].value)).toBe(4500);

      const ended = (await api().patch(`/financial/recurrences/${rule.id}/end`).set(auth(company.id)).send({}).expect(200)).body;
      expect(ended.removed).toBeGreaterThan(10);
      const left = await db.financial_Payable.count({ where: { recurrenceId: rule.id, inactiveAt: null } });
      expect(left).toBe(rows.length - ended.removed);
      const list = (await api().get('/financial/payables').query({ origin: 'recorrencia', view: 'todas' }).set(auth(company.id))).body;
      expect(list.total).toBe(left);
    });

    it('a receber exige cliente e conta de receita', async () => {
      const { db, company, customer, receita, despesas } = await cenario();
      await api().post('/financial/recurrences').set(auth(company.id)).send({ kind: 'receivable', description: 'Mensalidade', value: 900, startDate: plus(2) }).expect(400);
      await api().post('/financial/recurrences').set(auth(company.id)).send({ kind: 'receivable', description: 'Mensalidade', value: 900, startDate: plus(2), customerId: customer.id, chartAccountId: despesas[0].id }).expect(400);
      const rule = (await api().post('/financial/recurrences').set(auth(company.id)).send({ kind: 'receivable', description: 'Mensalidade', value: 900, startDate: plus(2), customerId: customer.id, chartAccountId: receita.id }).expect(201)).body;
      expect(await db.financialRecords.count({ where: { recurrenceId: rule.id, gateway: 'manual', status: 'waiting' } })).toBeGreaterThanOrEqual(12);
    });
  });

  describe('relatórios', () => {
    it('fluxo de caixa: saldo inicial, realizado, previsto e atrasado à parte', async () => {
      const { company, customer, bank } = await cenario();
      const paid = await payable(company.id, { value: 200, dueDate: today() });
      await api().patch(`/financial-payables/settle/${paid.id}`).set(auth(company.id)).send({ bankAccountId: bank.id }).expect(200);
      await payable(company.id, { value: 300, dueDate: plus(2) });
      await payable(company.id, { value: 50, dueDate: plus(-3) });
      await receivable(company.id, { customerId: customer.id, value: 800, dueDate: plus(4) });
      const flow = (await api().get('/financial/reports/cash-flow').query({ from: today(), to: plus(10), group: 'day' }).set(auth(company.id)).expect(200)).body;
      expect(flow.opening).toBe(1000);
      expect(flow.totals.realizedOut).toBe(200);
      expect(flow.totals.projectedOut).toBe(300);
      expect(flow.totals.projectedIn).toBe(800);
      expect(flow.overdue.out).toBe(50);
      expect(flow.closing).toBe(1300);
      expect(flow.rows).toHaveLength(11);
    });

    it('DRE por competência com resultado financeiro', async () => {
      const { company, customer, receita, despesas, accounts } = await cenario();
      const custo = despesas.find((d) => {
        let current: any = d;
        while (current) { if (current.dreGroup) return current.dreGroup === 'custo_servico'; current = accounts.find((a: any) => a.id === current.parentId); }
        return false;
      })!;
      const month = today().slice(0, 7);
      await receivable(company.id, { customerId: customer.id, value: 10000, chartAccountId: receita.id, accrualDate: month });
      const p = await payable(company.id, { value: 2000, chartAccountId: custo.id, accrualDate: month, dueDate: today() });
      await api().patch(`/financial-payables/settle/${p.id}`).set(auth(company.id)).send({ interestValue: 40 }).expect(200);
      await payable(company.id, { value: 500, accrualDate: month });
      const dre = (await api().get('/financial/reports/dre').query({ from: month, to: month }).set(auth(company.id)).expect(200)).body;
      const line = (key: string) => dre.rows.find((r: any) => r.key === key);
      expect(line('receita_bruta').total).toBe(10000);
      expect(line('custo_servico').total).toBe(2000);
      expect(line('lucro_bruto').total).toBe(8000);
      expect(line('financeiro_despesas').total).toBe(40);
      expect(line('sem_despesa').total).toBe(500);
      expect(line('resultado').total).toBe(7460);
      await api().get('/financial/reports/dre').query({ from: month, to: month, format: 'xlsx' }).set(auth(company.id)).expect(200).expect('Content-Type', /spreadsheetml/);
    });
  });

  describe('tesouraria', () => {
    it('transferência mexe no saldo das duas contas', async () => {
      const { company, bank, caixa } = await cenario();
      await api().post('/financial/transfers').set(auth(company.id)).send({ fromBankAccountId: bank.id, toBankAccountId: bank.id, value: 10 }).expect(400);
      const t = (await api().post('/financial/transfers').set(auth(company.id)).send({ fromBankAccountId: bank.id, toBankAccountId: caixa.id, value: 250, date: today() }).expect(201)).body;
      let balances = (await api().get('/financial/bank-balances').set(auth(company.id))).body;
      expect(balances.find((b: any) => b.id === bank.id).balance).toBe(750);
      expect(balances.find((b: any) => b.id === caixa.id).balance).toBe(250);
      await api().patch(`/financial/transfers/${t.id}/inactive`).set(auth(company.id)).expect(200);
      balances = (await api().get('/financial/bank-balances').set(auth(company.id))).body;
      expect(balances.find((b: any) => b.id === bank.id).balance).toBe(1000);
    });

    it('conciliação OFX: sugere, baixa com a data do extrato e não repete', async () => {
      const { db, company, bank, customer } = await cenario();
      const p = await payable(company.id, { description: 'Energia', value: 389.9, dueDate: plus(-1) });
      const r = await receivable(company.id, { customerId: customer.id, value: 1200, dueDate: plus(-2) });
      const d = (n: number) => plus(n).replace(/-/g, '');
      const ofx = `OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>341<ACCTID>12345</BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${d(-1)}120000[-3:BRT]<TRNAMT>-389.90<FITID>A1<MEMO>PAG CELPE</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>${d(-1)}<TRNAMT>1200,00<FITID>A2<NAME>TED ALFA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${d(-1)}<TRNAMT>-45.00<FITID>A3<MEMO>TARIFA</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
      const preview = (await api().post('/financial/reconciliation/preview').set(auth(company.id)).field('bankAccountId', String(bank.id)).attach('file', Buffer.from(ofx, 'latin1'), 'extrato.ofx').expect(201)).body;
      expect(preview.totals).toMatchObject({ lines: 3, suggested: 2, unmatched: 1 });
      const [l1, l2, l3] = preview.items;
      expect(l1.candidates[0]).toMatchObject({ type: 'payable', id: p.id, mode: 'baixar' });
      expect(l2.candidates[0]).toMatchObject({ type: 'receivable', id: r.id });
      const applied = (await api().post('/financial/reconciliation/apply').set(auth(company.id)).send({
        bankAccountId: bank.id,
        items: [
          { ...l1, action: 'baixar', type: 'payable', targetId: p.id },
          { ...l2, action: 'baixar', type: 'receivable', targetId: r.id },
          { ...l3, action: 'criar', description: 'Tarifa bancária' },
        ],
      }).expect(201)).body;
      expect(applied.applied).toBe(3);
      const paid = await db.financial_Payable.findUnique({ where: { id: p.id } });
      expect(paid!.status).toBe('paga');
      expect(paid!.paidAt!.toISOString().slice(0, 10)).toBe(plus(-1));
      expect(paid!.bankAccountId).toBe(bank.id);
      expect(await db.financial_Payable.count({ where: { companyId: company.id, description: 'Tarifa bancária', status: 'paga' } })).toBe(1);
      const again = (await api().post('/financial/reconciliation/preview').set(auth(company.id)).send({ bankAccountId: bank.id, content: ofx }).expect(201)).body;
      expect(again.totals.reconciled).toBe(3);
      const repeat = (await api().post('/financial/reconciliation/apply').set(auth(company.id)).send({ bankAccountId: bank.id, items: [{ ...l3, action: 'criar' }] }).expect(201)).body;
      expect(repeat.applied).toBe(0);
      expect(repeat.errors[0].reason).toBe('Linha já conciliada');
    });
  });
});
