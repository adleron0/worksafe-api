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
 * Financeiro pelo assistente: as ferramentas chamam as mesmas rotas da tela
 * (com as permissões da pessoa) para cadastrar, categorizar e consultar; a
 * baixa só acontece com a confirmação.
 */
describe('Financeiro pelo assistente (e2e)', () => {
  const ALL = ['usar_mcp', 'list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro', 'activate_financeiro'];
  let jwt: JwtService;
  let catalog: ToolCatalogService;
  let userId = 0;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    catalog = app.get(ToolCatalogService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions: string[] = ALL) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  async function cenario(permissions = ALL) {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const ctx: ToolContext = { userId, companyId: company.id, permissions, origin: 'mcp' };
    const call = async (tool: string, input: Record<string, unknown> = {}) => {
      const out = await catalog.call(ctx, tool, input, null);
      return { ...out, data: JSON.parse(out.content) };
    };
    return { company, call, db: testDb() };
  }
  /** Primeira conta de despesa que aceita lançamento, na árvore devolvida. */
  function leaf(tree: any, nature: string): any {
    const nodes = Array.isArray(tree) ? tree : tree?.rows ?? tree?.accounts ?? tree?.tree ?? [];
    for (const node of nodes) {
      if (node.nature === nature && node.acceptsEntries) return node;
      const inner = leaf(node.children ?? [], nature);
      if (inner) return inner;
    }
    return null;
  }

  it('cadastros, despesa categorizada, parcelas, categorização em lote e consultas', async () => {
    const { company, call, db } = await cenario();
    const plano = await call('fin_plano_de_contas');
    expect(plano.status).toBe('ok');
    const despesa = leaf(plano.data, 'despesa');
    const receita = leaf(plano.data, 'receita');
    expect(despesa && receita).toBeTruthy();

    const fornecedor = await call('fin_salvar_fornecedor', { nome: 'Cordas & Cia', documento: '11222333000181', fornece: 'Cordas e mosquetões', pix: 'financeiro@cordas.local' });
    expect(fornecedor.status).toBe('ok');
    const centro = await call('fin_salvar_centro_de_custo', { nome: 'Obras', codigo: 'OBR' });
    const outroCentro = await call('fin_salvar_centro_de_custo', { nome: 'Centro de treinamento', codigo: 'CT' });
    const novaConta = await call('fin_salvar_conta_do_plano', { nome: 'Equipamentos de altura', contaPaiId: despesa.parentId ?? despesa.id });
    expect(novaConta.status).toBe('ok');
    const editada = await call('fin_salvar_conta_do_plano', { id: novaConta.data.id, nome: 'EPIs e equipamentos de altura' });
    expect(editada.data.name).toBe('EPIs e equipamentos de altura');

    const single = await call('fin_cadastrar_despesa', {
      descricao: 'Compra de cordas', valor: 1250.5, vencimento: '2026-12-10', fornecedorId: fornecedor.data.id, contaId: despesa.id, centroId: centro.data.id, formaPagamento: 'pix', documento: 'NF 123',
    });
    expect(single.status).toBe('ok');
    const parcelada = await call('fin_cadastrar_despesa', { descricao: 'Mosquetões', valor: 900, vencimento: '2026-12-15', parcelas: 3, fornecedorId: fornecedor.data.id });
    expect(parcelada.data).toMatchObject({ count: 3 });
    const payables = await db.financial_Payable.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } });
    expect(payables).toHaveLength(4);
    expect(payables[0]).toMatchObject({ description: 'Compra de cordas', supplierId: fornecedor.data.id, chartAccountId: despesa.id, costCenterId: centro.data.id, status: 'aberta' });
    expect(payables.slice(1).map((row) => Number(row.value))).toEqual([300, 300, 300]);

    // parcelas sem categoria: categoriza as três de uma vez
    const lote = await call('fin_categorizar', { tipo: 'pagar', ids: payables.slice(1).map((row) => row.id), contaId: despesa.id, centroId: outroCentro.data.id });
    expect(lote.data).toMatchObject({ categorizados: 3, falharam: [] });
    expect(await db.financial_Payable.count({ where: { companyId: company.id, costCenterId: outroCentro.data.id } })).toBe(3);
    // receita não vai em conta de despesa: a regra da tela recusa
    expect((await call('fin_editar_conta_a_pagar', { id: payables[0].id, contaId: receita.id })).status).toBe('refused');
    const edit = await call('fin_editar_conta_a_pagar', { id: payables[1].id, aplicarEm: 'todas', vencimento: '2026-12-20', valor: 320 });
    expect(edit.status).toBe('ok');

    const lista = await call('fin_contas_a_pagar', { visao: 'abertas', fornecedorId: fornecedor.data.id });
    expect(lista.status).toBe('ok');
    expect(JSON.stringify(lista.data)).toContain('Compra de cordas');

    const rank = await db.dOM_Ranks.create({ data: { name: 'Bronze', companyId: company.id } });
    const state = await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } });
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } });
    const cliente = await db.customer.create({ data: { name: 'Indústria Alfa', corporateName: 'Indústria Alfa SA', cnpj: '11222333000199', companyId: company.id, rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id } });
    expect((await call('fin_cadastrar_conta_a_receber', { descricao: 'Sem cliente', valor: 10, vencimento: '2026-12-05' })).status).toBe('refused');
    const receber = await call('fin_cadastrar_conta_a_receber', { descricao: 'Treinamento in company', valor: 4800, vencimento: '2026-12-05', contaId: receita.id, clienteId: cliente.id });
    expect(receber.status).toBe('ok');
    expect(await db.financialRecords.findFirst({ where: { companyId: company.id } })).toMatchObject({ gateway: 'manual', status: 'waiting' });

    const banco = await call('fin_salvar_conta_bancaria', { nome: 'Banco do Brasil', tipo: 'corrente', saldoInicial: 10000, dataSaldoInicial: '2026-11-01' });
    expect(banco.status).toBe('ok');
    expect((await call('fin_resumo')).status).toBe('ok');
    expect((await call('fin_fluxo_de_caixa', { de: '2026-11-01', ate: '2026-12-31', agrupar: 'mes' })).status).toBe('ok');
    expect((await call('fin_dre', { de: '2026-11', ate: '2026-12' })).status).toBe('ok');
    expect((await call('fin_cadastros', { tipo: 'fornecedores', busca: 'cordas' })).content).toContain('Cordas & Cia');

    // centro com lançamentos: a regra da tela não deixa inativar; um sem uso, sim
    const emUso = await call('fin_ativar_inativar', { tipo: 'centro_de_custo', id: centro.data.id, ativo: false });
    expect(emUso.status).toBe('refused');
    const livre = await call('fin_salvar_centro_de_custo', { nome: 'Projeto piloto' });
    expect(livre.status).toBe('ok');
    // nome repetido: a regra da tela recusa
    expect((await call('fin_salvar_centro_de_custo', { nome: 'Projeto piloto' })).status).toBe('refused');
    expect((await call('fin_ativar_inativar', { tipo: 'centro_de_custo', id: livre.data.id, ativo: false })).status).toBe('ok');
    expect((await db.financial_CostCenter.findUnique({ where: { id: livre.data.id } }))!.inactiveAt).not.toBeNull();
    expect((await call('fin_ativar_inativar', { tipo: 'centro_de_custo', id: livre.data.id, ativo: true })).status).toBe('ok');
  });

  it('baixa só com confirmação, e o estorno também', async () => {
    const { company, call, db } = await cenario();
    await call('fin_plano_de_contas');
    const banco = await call('fin_salvar_conta_bancaria', { nome: 'Caixa', tipo: 'caixa' });
    await call('fin_cadastrar_despesa', { descricao: 'Aluguel do CT', valor: 3000, vencimento: '2026-11-10' });
    const payable = await db.financial_Payable.findFirstOrThrow({ where: { companyId: company.id } });

    const pending = await call('fin_dar_baixa', { tipo: 'pagar', ids: [payable.id], contaBancariaId: banco.data.id, data: '2026-11-10' });
    expect(pending.status).toBe('pending');
    expect(pending.data.resumo).toContain('PAGAMENTO');
    expect((await db.financial_Payable.findUniqueOrThrow({ where: { id: payable.id } })).status).toBe('aberta');
    await request(httpServer()).post(`/ai/actions/${pending.pendingActionId}/confirm`).set(auth(company.id)).expect(200);
    expect(await db.financial_Payable.findUniqueOrThrow({ where: { id: payable.id } })).toMatchObject({ status: 'paga', bankAccountId: banco.data.id });
    // já paga: não prepara de novo
    expect((await call('fin_dar_baixa', { tipo: 'pagar', ids: [payable.id] })).status).toBe('refused');

    const estorno = await call('fin_estornar_baixa', { tipo: 'pagar', id: payable.id, motivo: 'Lançado errado' });
    await request(httpServer()).post(`/ai/actions/${estorno.pendingActionId}/confirm`).set(auth(company.id)).expect(200);
    expect((await db.financial_Payable.findUniqueOrThrow({ where: { id: payable.id } })).status).toBe('aberta');
  });

  it('respeita as permissões: quem só consulta não cadastra', async () => {
    const { call } = await cenario(['usar_mcp', 'list_financeiro']);
    expect((await call('fin_resumo')).status).toBe('ok');
    expect((await call('fin_cadastrar_despesa', { descricao: 'x', valor: 1, vencimento: '2026-12-01' })).status).toBe('denied');
    expect((await call('fin_salvar_fornecedor', { nome: 'X' })).status).toBe('denied');
    expect((await call('fin_dar_baixa', { tipo: 'pagar', ids: [1] })).status).toBe('denied');
  });
});
