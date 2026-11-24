import './setup/env'; // precisa ser o primeiro import

import { STOCK_TOOLS } from 'src/features/ai/tools/stock.tools';
import { ToolDeps } from 'src/features/ai/tools/tool.deps';
import { ToolContext, ToolDefinition, ToolRefusal } from 'src/features/ai/tools/tool.types';
import { bootTestApp, shutdownTestApp } from './setup/app';
import { testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Ferramentas do bot de Suprimentos (compras e estoque). O catálogo ainda não
 * registra STOCK_TOOLS, então o teste chama run/prepare/execute direto, com o
 * ToolDeps do app: as chamadas vão pelas rotas da tela (deps.api.call).
 *
 * O banco de teste é compartilhado com outra suíte rodando ao mesmo tempo:
 * nada de resetDb; cada teste cria a própria empresa com nomes únicos.
 */
describe('Suprimentos: ferramentas de compras e estoque (e2e)', () => {
  const PERMS = [
    'list_itens_estoque', 'movimentar_estoque', 'ajuste_estoque', 'custos_estoque',
    'list_pedidos_de_compra', 'create_pedidos_de_compra', 'update_pedidos_de_compra', 'approve_pedidos_de_compra',
    'list_entregas_epi', 'create_entregas_epi', 'view_entregas_epi', 'list_equipamentos', 'inspecoes_equipamentos', 'list_locacoes',
  ];
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  let seq = 0;
  let deps: ToolDeps;

  beforeAll(async () => {
    const app = await bootTestApp();
    deps = app.get(ToolDeps, { strict: false });
  });
  afterAll(async () => { await shutdownTestApp(); });

  const tool = (name: string): ToolDefinition => {
    const found = STOCK_TOOLS.find((t) => t.name === name);
    if (!found) throw new Error(`ferramenta ${name} não existe`);
    return found;
  };

  async function cenario(permissions = PERMS) {
    const n = ++seq;
    const db = testDb();
    const company = await makeCompany({ cnpj: String(70000000000000 + Math.floor(Math.random() * 9e12)), comercial_name: `Sup ${uniq} ${n}` });
    const user = await makeSeller(company.id, { email: `sup-${uniq}-${n}@teste.local`, cpf: String(10000000000 + Math.floor(Math.random() * 8e10)) });
    const ctx: ToolContext = { userId: user.id, companyId: company.id, permissions, origin: 'bots' };
    const location = await db.stock_Location.create({ data: { companyId: company.id, name: `Almox ${uniq}`, kind: 'almoxarifado' } });
    const other = await db.stock_Location.create({ data: { companyId: company.id, name: `Obra Base ${uniq}`, kind: 'almoxarifado' } });
    const supplier = await db.financial_Supplier.create({ data: { companyId: company.id, name: `Fornecedor ${uniq}` } });
    const luva = await db.stock_Item.create({ data: { companyId: company.id, code: `LUV-${n}`, name: `Luva vaqueta ${uniq}`, unit: 'par', tracking: 'quantidade', minQuantity: 10, isPpe: true, caNumber: '12345', lastSupplierId: supplier.id } as any });
    const run = (name: string, input: Record<string, unknown> = {}, c = ctx) => tool(name).run!(c, input, deps) as Promise<any>;
    const sensitive = async (name: string, input: Record<string, unknown>, c = ctx) => {
      const prepared = await tool(name).prepare!(c, input, deps);
      const result = await tool(name).execute!(c, prepared.payload, deps);
      return { prepared, result };
    };
    return { db, company, ctx, location, other, supplier, luva, run, sensitive };
  }

  it('declara riscos e permissões coerentes', () => {
    const names = STOCK_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('listar_pedidos_de_compra'); // já existe em read.tools
    for (const t of STOCK_TOOLS) {
      if (t.risk === 'sensitive') { expect(t.prepare).toBeTruthy(); expect(t.execute).toBeTruthy(); expect(t.run).toBeUndefined(); } else expect(t.run).toBeTruthy();
      expect(t.permissions.length + (t.anyPermissions?.length ?? 0)).toBeGreaterThan(0);
    }
    expect(tool('criar_pedido_de_compra').risk).toBe('draft');
    expect(tool('receber_pedido_de_compra').risk).toBe('sensitive');
  });

  it('entrada avulsa no clique, depois consultas de saldo, reposição, painel e movimentações', async () => {
    const { db, location, luva, run, sensitive } = await cenario();
    const prepared = await tool('registrar_movimentacao_estoque').prepare!((await cenarioCtx()), { tipo: 'entrada_avulsa', localId: location.id, itens: [{ itemId: luva.id, quantidade: 4, custoUnitario: 5 }] }, deps).catch((e) => e);
    // o ctx de outra empresa não acha o local desta: recusa
    expect(prepared).toBeInstanceOf(ToolRefusal);

    const { prepared: card, result } = await sensitive('registrar_movimentacao_estoque', { tipo: 'entrada_avulsa', localId: location.id, itens: [{ itemId: luva.id, quantidade: 4, custoUnitario: 5 }], observacao: 'compra no balcão' });
    expect(card.summary).toContain('Entrada avulsa');
    expect(card.details!.find((d) => d.label === 'Itens')!.value).toContain('4 par');
    expect(result.message).toContain('lançada');
    expect(result.link).toBe('/suprimentos/estoque/movimentacoes');
    const balance = await db.stock_Balance.findFirstOrThrow({ where: { itemId: luva.id, holderType: 'local', holderId: location.id } });
    expect(Number(balance.quantity)).toBe(4);

    const found = await run('buscar_item_estoque', { busca: 'vaqueta' });
    expect(found).toMatchObject({ itemId: luva.id, emEstoque: 4, disponivel: 4, minimo: 10, abaixoDoMinimo: true, ultimoCusto: 5, link: `/suprimentos/estoque/itens/${luva.id}` });
    expect(found.saldos).toEqual([expect.objectContaining({ onde: location.name, localId: location.id, quantidade: 4 })]);

    const repor = await run('itens_para_repor');
    expect(repor.itens).toEqual([expect.objectContaining({ itemId: luva.id, disponivel: 4, minimo: 10, sugestaoCompra: 16, ultimoCusto: 5 })]);

    const painel = await run('estoque_visao_geral');
    expect(painel).toMatchObject({ abaixoDoMinimo: 1, valorEmEstoque: 20 });

    const movs = await run('movimentacoes_estoque', { itemId: luva.id });
    expect(movs.total).toBe(1);
    expect(movs.movimentacoes[0]).toMatchObject({ tipo: 'Entrada avulsa', para: location.name, valor: 20 });
  });

  /** Contexto de uma empresa à parte (para conferir o isolamento). */
  async function cenarioCtx(): Promise<ToolContext> {
    const company = await makeCompany({ cnpj: String(60000000000000 + Math.floor(Math.random() * 9e12)), comercial_name: `Outra ${uniq}` });
    return { userId: 0, companyId: company.id, permissions: PERMS, origin: 'bots' };
  }

  it('recusa saída maior que o saldo, ajuste sem motivo e tipo sem permissão', async () => {
    const { ctx, location, other, luva, sensitive } = await cenario();
    await sensitive('registrar_movimentacao_estoque', { tipo: 'entrada_avulsa', localId: location.id, itens: [{ itemId: luva.id, quantidade: 2 }] });
    const prepare = (input: Record<string, unknown>, c = ctx) => tool('registrar_movimentacao_estoque').prepare!(c, input, deps);
    await expect(prepare({ tipo: 'transferencia', localId: location.id, localDestinoId: other.id, itens: [{ itemId: luva.id, quantidade: 5 }] })).rejects.toThrow('só há 2 par');
    await expect(prepare({ tipo: 'ajuste', localId: location.id, itens: [{ itemId: luva.id, quantidade: -1 }] })).rejects.toThrow('motivo');
    await expect(prepare({ tipo: 'ajuste', localId: location.id, itens: [{ itemId: luva.id, quantidade: -1 }], observacao: 'perda' }, { ...ctx, permissions: ['movimentar_estoque'] })).rejects.toThrow(ToolRefusal);

    // transferência válida anda pela rota
    const { result } = await sensitive('registrar_movimentacao_estoque', { tipo: 'transferencia', localId: location.id, localDestinoId: other.id, itens: [{ itemId: luva.id, quantidade: 2 }] });
    expect(result.message).toContain('Transferência');
  });

  it('pedido de compra: rascunho pela reposição, aprovar, comprar e receber no estoque (cada passo no clique)', async () => {
    const { db, ctx, location, supplier, luva, run, sensitive } = await cenario();
    await db.stock_Item.update({ where: { id: luva.id }, data: { lastCost: 7.5 } });

    // sem saldo e mínimo 10: a sugestão é 2 × mínimo − disponível = 20
    const draft = await run('criar_pedido_de_compra', { daReposicao: true, fornecedorId: supplier.id });
    expect(draft).toMatchObject({ situacao: 'Solicitado', fornecedor: supplier.name, total: 150 });
    expect(draft.itens).toEqual([expect.objectContaining({ itemId: luva.id, quantidade: 20, valorUnitario: 7.5 })]);
    expect(draft.link).toBe(`/suprimentos/pedidos-de-compra/${draft.id}`);

    const ver = await run('ver_pedido_de_compra', { numero: draft.numero });
    expect(ver).toMatchObject({ id: draft.id, destino: 'a própria empresa', podeAprovar: true });
    expect(ver.proximasSituacoes).toEqual(['Aprovado', 'Recusado', 'Cancelado']);

    // sem a permissão de aprovar: recusa antes do cartão
    await expect(tool('mudar_situacao_pedido_compra').prepare!({ ...ctx, permissions: PERMS.filter((p) => p !== 'approve_pedidos_de_compra') }, { pedidoId: draft.id, situacao: 'aprovado' }, deps)).rejects.toThrow('permissão para aprovar');
    // receber antes de comprar: recusa explicando o caminho
    await expect(tool('receber_pedido_de_compra').prepare!(ctx, { pedidoId: draft.id }, deps)).rejects.toThrow('só pedido comprado');

    const aprovado = await sensitive('mudar_situacao_pedido_compra', { pedidoId: draft.id, situacao: 'aprovado' });
    expect(aprovado.prepared.summary).toContain('Aprovar o pedido');
    expect(aprovado.result.data).toMatchObject({ situacao: 'aprovado' });

    await expect(tool('mudar_situacao_pedido_compra').prepare!(ctx, { pedidoId: draft.id, situacao: 'comprado' }, deps)).rejects.toThrow('vencimento');
    const comprado = await sensitive('mudar_situacao_pedido_compra', { pedidoId: draft.id, situacao: 'comprado', parcelas: 2, primeiroVencimento: '2027-01-10', formaPagamento: 'boleto' });
    expect(comprado.prepared.details!.find((d) => d.label === 'Pagamento')!.value).toContain('2 conta(s) a pagar');
    expect(comprado.result.data).toMatchObject({ situacao: 'comprado', contasAPagar: 2 });
    expect(await db.financial_Payable.count({ where: { purchaseOrderId: draft.id, inactiveAt: null } })).toBe(2);

    // nada entra no estoque antes do clique
    const card = await tool('receber_pedido_de_compra').prepare!(ctx, { pedidoId: draft.id, localId: location.id, notaFiscal: 'NF 991' }, deps);
    expect(card.details!.find((d) => d.label === 'Entra em')!.value).toBe(location.name);
    expect(card.details!.find((d) => d.label === 'Pedido' && d.value.includes('tudo'))).toBeTruthy();
    expect(await db.stock_Balance.count({ where: { itemId: luva.id } })).toBe(0);
    const received = await tool('receber_pedido_de_compra').execute!(ctx, card.payload, deps);
    expect(received.data).toMatchObject({ situacao: 'recebido' });
    const balance = await db.stock_Balance.findFirstOrThrow({ where: { itemId: luva.id, holderType: 'local', holderId: location.id } });
    expect(Number(balance.quantity)).toBe(20);
    const order = await db.purchase_Order.findUniqueOrThrow({ where: { id: draft.id } });
    expect(order).toMatchObject({ status: 'recebido', invoiceNumber: 'NF 991' });
  });

  it('EPI: entrega no clique, ficha do funcionário e recusa para desligado', async () => {
    const { db, ctx, company, location, luva, run, sensitive } = await cenario();
    await sensitive('registrar_movimentacao_estoque', { tipo: 'entrada_avulsa', localId: location.id, itens: [{ itemId: luva.id, quantidade: 5, custoUnitario: 6 }] });
    const ana = await db.hr_Employee.create({ data: { companyId: company.id, name: `Ana ${uniq}`, admissionDate: new Date('2025-01-02T00:00:00Z') } });
    const saiu = await db.hr_Employee.create({ data: { companyId: company.id, name: `Beto ${uniq}`, terminationDate: new Date('2025-06-01T00:00:00Z') } });

    await expect(tool('entregar_epi').prepare!(ctx, { funcionarioId: saiu.id, localId: location.id, itens: [{ itemId: luva.id, quantidade: 1 }] }, deps)).rejects.toThrow('desligado');

    const { prepared, result } = await sensitive('entregar_epi', { funcionarioId: ana.id, localId: location.id, motivo: 'admissao', itens: [{ itemId: luva.id, quantidade: 2 }] });
    expect(prepared.summary).toContain(`a Ana ${uniq}`);
    expect(prepared.details!.find((d) => d.label === 'Assinatura')).toBeTruthy();
    expect(result.message).toContain('registrada');
    const ficha = await run('epis_pendentes', { funcionarioId: ana.id });
    expect(ficha.emMaos).toEqual([expect.objectContaining({ itemId: luva.id, quantidade: 2 })]);
    expect((await run('epis_pendentes')).total).toBe(0);
  });

  it('inspeção de peça pela etiqueta, vencimentos e locações', async () => {
    const { db, ctx, company, location, run, sensitive } = await cenario();
    const corda = await db.stock_Item.create({ data: { companyId: company.id, code: `CRD-${seq}`, name: `Corda 11mm ${uniq}`, unit: 'un', tracking: 'unidade', requiresInspection: true, inspectionIntervalDays: 180 } as any });
    await sensitive('registrar_movimentacao_estoque', { tipo: 'entrada_avulsa', localId: location.id, itens: [{ itemId: corda.id, quantidade: 1, custoUnitario: 900 }] });
    const unit = await db.stock_Unit.findFirstOrThrow({ where: { itemId: corda.id } });

    const vencendo = await run('equipamentos_vencendo');
    expect(vencendo.itens.some((r: any) => r.pecaId === unit.id && r.tipo === 'Inspeção')).toBe(true);

    await expect(tool('registrar_inspecao').prepare!(ctx, { etiqueta: unit.tag, resultado: 'reprovado' }, deps)).rejects.toThrow('o que foi encontrado');
    const { result } = await sensitive('registrar_inspecao', { etiqueta: unit.tag.toLowerCase(), resultado: 'aprovado', tipo: 'periodica' });
    expect(result.link).toBe(`/suprimentos/equipamentos/${unit.id}`);
    const after = await db.stock_Unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.nextInspectionAt).toBeTruthy();

    const locacoes = await run('listar_locacoes');
    expect(locacoes.locacoes).toEqual([]);
  });
});
