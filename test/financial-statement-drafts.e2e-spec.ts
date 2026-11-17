import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { ToolContext } from 'src/features/ai/tools/tool.types';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Extrato lido pelo assistente (PDF) ou mandado pelo MCP: vira rascunho com a
 * conferência da soma, recebe a classificação sugerida e é lançado pela mesma
 * conciliação do OFX, com uma confirmação só. Reenviar não lança duas vezes.
 */
describe('Financeiro — extrato lido pelo assistente (e2e)', () => {
  const FIN = ['list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro', 'activate_financeiro'];
  const ALL = ['usar_mcp', ...FIN, 'importar_extrato_bots'];
  let jwt: JwtService;
  let catalog: ToolCatalogService;
  let userId = 0;

  beforeAll(async () => { const app = await bootTestApp(); jwt = app.get(JwtService); catalog = app.get(ToolCatalogService); });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());
  const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const plus = (days: number) => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  function leaf(tree: any, nature: string): any {
    const nodes = Array.isArray(tree) ? tree : tree?.rows ?? tree?.accounts ?? tree?.tree ?? [];
    for (const node of nodes) {
      if (node.nature === nature && node.acceptsEntries) return node;
      const inner = leaf(node.children ?? [], nature);
      if (inner) return inner;
    }
    return null;
  }

  async function cenario(permissions = ALL) {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const ctx: ToolContext = { userId, companyId: company.id, permissions, origin: 'mcp' };
    const call = async (tool: string, input: Record<string, unknown> = {}) => {
      const out = await catalog.call(ctx, tool, input, null);
      return { ...out, data: JSON.parse(out.content) };
    };
    const bank = (await api().post('/financial-bank-accounts').set(auth(company.id)).send({ name: 'Itaú', type: 'corrente', openingBalance: 1000, openingBalanceDate: plus(-30) }).expect(201)).body;
    return { company, call, bank, db: testDb() };
  }
  // extrato: uma linha antes do saldo inicial, a conta de energia (já lançada), duas tarifas iguais no mesmo dia e um PIX recebido
  const linhas = () => [
    { data: plus(-31), valor: -10, historico: 'COMPRA ANTIGA' },
    { data: plus(-20), valor: -150, historico: 'PAG CONTA ENERGIA' },
    { data: plus(-15), valor: -12.5, historico: 'TARIFA PACOTE' },
    { data: plus(-15), valor: -12.5, historico: 'Tarifa  pacote' },
    { data: plus(-5), valor: 500, historico: 'PIX RECEBIDO CLIENTE X' },
  ];

  it('confere a soma, classifica, lança com uma confirmação e não duplica ao reenviar', async () => {
    const { company, call, bank, db } = await cenario();
    const energia = (await api().post('/financial-payables').set(auth(company.id)).send({ description: 'Energia', value: 150, dueDate: plus(-10) }).expect(201)).body;

    const situacao = await call('fin_situacao_inicial');
    expect(situacao.status).toBe('ok');
    expect(situacao.data.etapa).toBe('pedir_extratos');
    expect(situacao.data.contas[0]).toMatchObject({ id: bank.id, saldoInicial: 1000, dataSaldoInicial: plus(-30), extratoConciliadoAte: null });

    // leitura errada: saldo final não bate
    const errado = await call('fin_ler_extrato', { contaBancariaId: bank.id, saldoInicial: 1010, saldoFinal: 1300, lancamentos: linhas(), arquivo: 'extrato.pdf' });
    expect(errado.status).toBe('ok');
    expect(errado.data.conferencia).toMatchObject({ confere: false, diferenca: 25 });
    expect(errado.data.proximoPasso).toContain(`substituiRascunhoId=${errado.data.rascunhoId}`);
    const bloqueado = await call('fin_lancar_extrato', { rascunhoId: errado.data.rascunhoId });
    expect(bloqueado.status).toBe('refused');
    await api().post(`/financial/statement-drafts/${errado.data.rascunhoId}/apply`).set(auth(company.id)).send({}).expect(400);

    // releitura: substitui o rascunho anterior
    const certo = await call('fin_ler_extrato', { contaBancariaId: bank.id, saldoInicial: 1010, saldoFinal: 1325, lancamentos: linhas(), substituiRascunhoId: errado.data.rascunhoId });
    expect(certo.data.conferencia).toMatchObject({ confere: true, diferenca: 0, entradas: 500, saidas: -185 });
    expect(certo.data.totais).toMatchObject({ linhas: 5, antesDoSaldoInicial: 1, comPar: 1, semPar: 3 });
    expect((await db.financial_StatementDraft.findUnique({ where: { id: errado.data.rascunhoId } }))!.status).toBe('descartado');
    const energiaLinha = certo.data.linhasParaDecidir.find((linha: any) => linha.linha === 2);
    expect(energiaLinha.proposta).toMatchObject({ acao: 'baixar' });
    const draftRow = await db.financial_StatementDraft.findUnique({ where: { id: certo.data.rascunhoId } });
    const fits = (draftRow!.lines as any[]).map((line) => line.fitId);
    expect(new Set(fits).size).toBe(5); // as duas tarifas iguais têm identificadores diferentes

    const plano = await call('fin_plano_de_contas');
    const despesa = leaf(plano.data, 'despesa');
    const receita = leaf(plano.data, 'receita');
    const sugerido = await call('fin_sugerir_classificacao_extrato', {
      rascunhoId: certo.data.rascunhoId,
      linhas: [
        { linha: 3, acao: 'criar', contaDoPlanoId: despesa.id, descricao: 'Tarifa bancária' },
        { linha: 4, acao: 'criar', contaDoPlanoId: despesa.id, descricao: 'Tarifa bancária' },
        { linha: 5, acao: 'criar', contaDoPlanoId: receita.id, descricao: 'Recebimento cliente X' },
      ],
    });
    expect(sugerido.status).toBe('ok');
    expect(sugerido.data.alteradas).toBe(3);

    const pending = await call('fin_lancar_extrato', { rascunhoId: certo.data.rascunhoId });
    expect(pending.status).toBe('pending');
    expect(pending.data.resumo).toContain('Lançar 4 linha(s)');
    const confirmed = (await api().post(`/ai/actions/${pending.pendingActionId}/confirm`).set(auth(company.id)).expect(200)).body;
    expect(confirmed.result.message).toContain('4 linha(s) lançada(s)');

    expect((await db.financial_Payable.findUnique({ where: { id: energia.id } }))).toMatchObject({ status: 'paga', bankAccountId: bank.id });
    const tarifas = await db.financial_Payable.findMany({ where: { companyId: company.id, description: 'Tarifa bancária' } });
    expect(tarifas).toHaveLength(2);
    expect(tarifas.every((tarifa) => tarifa.status === 'paga' && tarifa.chartAccountId === despesa.id)).toBe(true);
    const pix = await db.financialRecords.findFirst({ where: { companyId: company.id, description: 'Recebimento cliente X' } });
    expect(pix).toMatchObject({ status: 'received', chartAccountId: receita.id, bankAccountId: bank.id });

    const view = (await api().get(`/financial/statement-drafts/${certo.data.rascunhoId}`).set(auth(company.id)).expect(200)).body;
    expect(view.status).toBe('lancado');
    expect(view.balance.system).toBe(1325);
    expect((await call('fin_situacao_inicial')).data.contas[0].extratoConciliadoAte).toBe(plus(-5));

    // o mesmo extrato de novo (com o histórico escrito diferente): tudo já conciliado
    const again = (await api().post('/financial/statement-drafts').set(auth(company.id)).send({
      bankAccountId: bank.id, openingBalance: 1010, closingBalance: 1325, source: 'mcp',
      lines: linhas().map((linha) => ({ date: linha.data, amount: linha.valor, memo: linha.historico.toLowerCase() })),
    }).expect(201)).body;
    expect(again.totals).toMatchObject({ reconciled: 4, beforeStart: 1 });
    await api().post(`/financial/statement-drafts/${again.id}/apply`).set(auth(company.id)).send({}).expect(400);
  });

  it('valida as linhas e respeita as permissões', async () => {
    const { company, bank } = await cenario();
    const base = { bankAccountId: bank.id, openingBalance: 0, closingBalance: -5, lines: [{ date: plus(-1), amount: -5, memo: 'x' }] };
    await api().post('/financial/statement-drafts').set(auth(company.id, ['list_financeiro'])).send(base).expect(403);
    await api().post('/financial/statement-drafts').set(auth(company.id)).send({ ...base, lines: [{ date: '15/11/2026', amount: -5 }] }).expect(400);
    await api().post('/financial/statement-drafts').set(auth(company.id)).send({ ...base, lines: [{ date: plus(-1), amount: 0 }] }).expect(400);
    await api().post('/financial/statement-drafts').set(auth(company.id)).send({ ...base, closingBalance: undefined }).expect(400);
    const outra = await makeCompany();
    await api().post('/financial/statement-drafts').set(auth(outra.id)).send(base).expect(400); // conta de outra empresa

    const semPermissao = await cenario(['usar_mcp', ...FIN]);
    const negado = await semPermissao.call('fin_ler_extrato', { contaBancariaId: semPermissao.bank.id, saldoInicial: 0, saldoFinal: -5, lancamentos: [{ data: plus(-1), valor: -5, historico: 'x' }] });
    expect(negado.status).toBe('denied');
  });
});
