import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Resumo da tela inicial (GET /dashboard).
 *
 * O que não pode quebrar: cada seção só chega para quem tem a permissão da
 * área (ninguém recebe número do financeiro sem `list_financeiro`); os números
 * batem com o financeiro (caixa de hoje, projetado em 30 dias, vencidos por
 * faixa, meta); e o comercial respeita o "só as minhas".
 */
describe('Resumo da tela inicial (e2e)', () => {
  const TODAY = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const day = (offset: number) => new Date(new Date(`${TODAY}T00:00:00Z`).getTime() + offset * 86400000);
  let jwt: JwtService;
  let cnpj = 0;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, sub: number, permissions: string[]) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub, companyId, permissions, profile: 'admin' }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());

  async function makeCustomer(companyId: number, name: string) {
    const db = testDb();
    const rank = await db.dOM_Ranks.create({ data: { name: `R${++cnpj}`, companyId } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    return db.customer.create({ data: {
      name, corporateName: `${name} SA`, cnpj: String(11222333000100 + cnpj), companyId,
      rankId: rank.id, phone: '8133334444', email: 'compras@cliente.local', stateId: state.id, cityId: city.id,
    } });
  }

  let proposalSeq = 0;
  async function makeProposal(companyId: number, customerId: number, data: { status: string; total: number; sellerId?: number; sentAt?: Date; decidedAt?: Date; title?: string }) {
    const seq = ++proposalSeq;
    return testDb().commercial_Proposal.create({ data: {
      companyId, customerId, number: `PC-T-${seq}`, year: 2026, sequence: seq, title: data.title ?? `Proposta ${seq}`,
      referenceDate: day(-30), snapshot: {}, status: data.status as never, total: data.total, sellerId: data.sellerId ?? null,
      sentAt: data.sentAt ?? null, decidedAt: data.decidedAt ?? null,
    } });
  }

  it('sem permissão de área, só vem o calendário do mês; cada permissão libera só a sua seção', async () => {
    const company = await makeCompany();
    const user = await makeSeller(company.id);

    const none = (await api().get('/dashboard').set(auth(company.id, user.id, [])).expect(200)).body;
    expect(none.today).toBe(TODAY);
    expect(none.monthDay).toBe(Number(TODAY.slice(8, 10)));
    for (const key of ['finance', 'commercial', 'operations', 'team', 'training', 'week', 'stock']) expect(none[key]).toBeUndefined();

    const fin = (await api().get('/dashboard').set(auth(company.id, user.id, ['list_financeiro'])).expect(200)).body;
    expect(fin.finance).toBeDefined();
    expect(fin.commercial).toBeUndefined();
    expect(fin.operations).toBeUndefined();
    expect(fin.week).toEqual([]);

    const com = (await api().get('/dashboard').set(auth(company.id, user.id, ['list_comercial'])).expect(200)).body;
    expect(com.commercial).toBeDefined();
    expect(com.finance).toBeUndefined();

    const estoque = (await api().get('/dashboard').set(auth(company.id, user.id, ['list_itens_estoque'])).expect(200)).body;
    expect(estoque.stock).toMatchObject({ low: 0, inspections: 0, calibrations: 0, value: null, link: '/suprimentos/estoque' });
    expect(estoque.finance).toBeUndefined();
  });

  it('financeiro: caixa de hoje, projetado em 30 dias, vencidos por faixa e meta do mês', async () => {
    const company = await makeCompany({ monthlyRevenueGoal: 9000 });
    const user = await makeSeller(company.id);
    const alfa = await makeCustomer(company.id, 'Construtora Alfa');
    const db = testDb();
    await db.financial_BankAccount.create({ data: { companyId: company.id, name: 'Conta principal', openingBalance: 10000, openingBalanceDate: day(-400) } });
    const month = TODAY.slice(0, 7);
    // vencida há 40 dias (faixa "mais de 30") e uma a vencer em 10 dias
    await db.financialRecords.create({ data: { companyId: company.id, customerId: alfa.id, accrualDate: month, gateway: 'manual', paymentMethod: 'boleto', status: 'waiting', value: 800, dueDate: day(-40), description: 'Parcela atrasada' } });
    await db.financialRecords.create({ data: { companyId: company.id, customerId: alfa.id, accrualDate: month, gateway: 'manual', paymentMethod: 'pix', status: 'waiting', value: 2000, dueDate: day(10), description: 'Parcela 2' } });
    await db.financial_Payable.create({ data: { companyId: company.id, description: 'Aluguel', value: 500, dueDate: day(5), accrualDate: month, status: 'aberta' } });

    const { finance } = (await api().get('/dashboard').set(auth(company.id, user.id, ['list_financeiro'])).expect(200)).body;
    expect(finance.cash.today).toBe(10000);
    expect(finance.cash.in30).toBe(2000);
    expect(finance.cash.out30).toBe(500);
    expect(finance.cash.projected30).toBe(11500);
    expect(finance.overdue.total).toBe(800);
    expect(finance.overdue.buckets).toEqual({ upTo15: 0, upTo30: 0, over30: 800 });
    expect(finance.overdue.items[0]).toMatchObject({ customer: 'Construtora Alfa', days: 40, value: 800 });
    // receita do mês por competência (as duas contas a receber são deste mês)
    expect(finance.goal).toMatchObject({ target: 9000, achieved: 2800 });
    expect(finance.profit.value).toBe(2300);
    // o gráfico tem o realizado até hoje e o projetado daqui para a frente
    const now = finance.cashFlow.points.find((p: any) => p.label === 'hoje');
    expect(now).toMatchObject({ real: 10000, projected: 10000 });
    expect(finance.cashFlow.points[finance.cashFlow.points.length - 1].real).toBeNull();
  });

  it('comercial: carteira ponderada pela conversão, funil, paradas e "só as minhas"', async () => {
    const company = await makeCompany();
    const ana = await makeSeller(company.id);
    const bruno = await makeSeller(company.id);
    const alfa = await makeCustomer(company.id, 'Petro Sul');
    // em aberto: uma enviada há 12 dias (parada) e uma vista ontem
    const tank = await makeProposal(company.id, alfa.id, { status: 'enviada', total: 1000, sellerId: ana.id, sentAt: day(-12), title: 'Resgate em tanque' });
    // um contato registrado há 9 dias: a proposta continua parada, contando desde ele
    await testDb().commercial_Activity.create({ data: { companyId: company.id, customerId: alfa.id, proposalId: tank.id, type: 'ligacao', subject: 'Cobrar retorno', doneAt: day(-9) } });
    await makeProposal(company.id, alfa.id, { status: 'visualizada', total: 3000, sellerId: bruno.id, sentAt: day(-3) });
    // decididas nos últimos 90 dias: 1 aceita e 1 recusada = 50% de conversão
    await makeProposal(company.id, alfa.id, { status: 'aceita', total: 5000, sellerId: ana.id, sentAt: day(-20), decidedAt: day(-10) });
    await makeProposal(company.id, alfa.id, { status: 'recusada', total: 7000, sellerId: bruno.id, sentAt: day(-20), decidedAt: day(-5) });

    const all = (await api().get('/dashboard').set(auth(company.id, ana.id, ['list_comercial', 'all_propostas'])).expect(200)).body.commercial;
    expect(all.open).toBe(4000);
    expect(all.openCount).toBe(2);
    expect(all.conversion).toBe(0.5);
    expect(all.weighted).toBe(2000);
    expect(all.avgDaysToAccept).toBe(10);
    expect(all.stalled.map((p: any) => p.title)).toEqual(['Resgate em tanque']);
    expect(all.stalled[0]).toMatchObject({ customer: 'Petro Sul', days: 9, value: 1000 });
    expect(all.funnel.map((f: any) => [f.key, f.count])).toEqual([['enviada', 1], ['visualizada', 1], ['aceita', Number(day(-10).toISOString().slice(0, 7) === TODAY.slice(0, 7))]]);

    // sem "ver todas", a Ana só enxerga as propostas dela
    const mine = (await api().get('/dashboard').set(auth(company.id, ana.id, ['list_comercial'])).expect(200)).body.commercial;
    expect(mine.open).toBe(1000);
    expect(mine.conversion).toBe(1);
  });

  it('a esteira mostra as ações dos bots esperando confirmação só para quem usa bots', async () => {
    const company = await makeCompany();
    const user = await makeSeller(company.id);
    const without = (await api().get('/my-pipeline').set(auth(company.id, user.id, [])).expect(200)).body;
    expect(without.blocks.find((b: any) => b.key === 'bots_acoes')).toBeUndefined();
    const withBots = (await api().get('/my-pipeline').set(auth(company.id, user.id, ['usar_bots'])).expect(200)).body;
    expect(withBots.blocks.find((b: any) => b.key === 'bots_acoes')).toMatchObject({ count: 0, link: '/bots/acoes' });
  });
});
