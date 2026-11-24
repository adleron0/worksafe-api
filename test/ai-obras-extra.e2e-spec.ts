import './setup/env'; // precisa ser o primeiro import

import { WORKS_TOOLS } from 'src/features/ai/tools/works.tools';
import { ToolDeps } from 'src/features/ai/tools/tool.deps';
import { ToolContext, ToolDefinition, ToolRefusal } from 'src/features/ai/tools/tool.types';
import { bootTestApp, shutdownTestApp } from './setup/app';
import { testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Ferramentas de obras (Bruno, e leituras para Financeiro e Comercial). O
 * catálogo ainda não registra WORKS_TOOLS: o teste chama run/prepare/execute
 * direto, com o ToolDeps do app; as escritas vão pelas rotas da tela.
 *
 * O banco de teste é compartilhado com outra suíte rodando ao mesmo tempo:
 * nada de resetDb; cada teste cria a própria empresa com nomes únicos.
 */
describe('Obras: OS da proposta, avanço, A faturar, diário e medição (e2e)', () => {
  const PERMS = [
    'list_comercial', 'create_comercial', 'update_comercial', 'view_custos_comercial', 'all_propostas',
    'list_financeiro', 'create_financeiro', 'update_financeiro',
    'list_ordens_de_servico', 'update_ordens_de_servico', 'all_ordens_de_servico', 'update_rdo',
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
    const found = WORKS_TOOLS.find((t) => t.name === name);
    if (!found) throw new Error(`ferramenta ${name} não existe`);
    return found;
  };
  const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

  const SERIES = [
    { description: 'Mobilização', percent: 0.3, dueRule: 'dias_apos_aceite', dueDays: 5 },
    { description: 'Metade da obra', percent: 0.5, dueRule: 'percentual_obra', workPercent: 50 },
    { description: 'Final', percent: 0.2, dueRule: 'percentual_obra', workPercent: 100 },
  ];

  /** Empresa, usuário, cliente e uma proposta de serviço aceita (a OS nasce no aceite). */
  async function cenario(extra: Record<string, unknown> = { installments: SERIES, depositRate: 0.05, depositReleaseDays: 30 }) {
    const n = ++seq;
    const db = testDb();
    const company = await makeCompany({ cnpj: String(50000000000000 + Math.floor(Math.random() * 9e12)), comercial_name: `Obras ${uniq} ${n}` });
    const user = await makeSeller(company.id, { name: `Bruno Coordenador ${uniq}`, email: `obras-${uniq}-${n}@teste.local`, cpf: String(10000000000 + Math.floor(Math.random() * 8e10)) });
    const ctx: ToolContext = { userId: user.id, companyId: company.id, permissions: PERMS, origin: 'bots' };
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    const customer = await db.customer.create({ data: {
      name: `Indústria ${uniq} ${n}`, corporateName: `Indústria ${uniq} SA`, cnpj: String(30000000000000 + Math.floor(Math.random() * 9e12)), companyId: company.id,
      rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id,
    } });
    const options = await deps.api.call<any>(ctx, 'GET', 'commercial/proposals/options');
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id;
    const created = await deps.api.call<any>(ctx, 'POST', 'commercial/proposals', { body: {
      kind: 'servico', customerId: customer.id, title: 'Pintura da esfera', contactName: 'Maria Souza', workDays: 22, contingencyRate: 0,
      commission: { rate: 0.02, base: 'faturado' },
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 1 }] }],
      schedule: { unit: 'dia', steps: [{ title: 'Jateamento', start: 1, duration: 10 }, { title: 'Pintura', start: 11, duration: 10 }] },
      ...extra,
    } });
    await deps.api.call(ctx, 'PATCH', `commercial/proposals/status/${created.id}`, { body: { status: 'enviada' } });
    await deps.api.call(ctx, 'PATCH', `commercial/proposals/status/${created.id}`, { body: { status: 'aceita' } });
    const contract = await db.commercial_Contract.findFirstOrThrow({ where: { proposalId: created.id } });
    const order = await db.service_Order.findUniqueOrThrow({ where: { contractId: contract.id } });
    const rdo = (date: string, progress: Array<{ step: number; title: string; percent: number }>, extraRdo: Record<string, unknown> = {}) => db.service_DailyReport.create({ data: {
      companyId: company.id, orderId: order.id, date: new Date(`${date}T00:00:00.000Z`), status: 'fechado', weather: 'bom',
      crew: [{ name: 'João', role: 'Alpinista N1', hours: 8, overtime: 1 }, { name: 'Pedro', role: 'Alpinista N1', hours: 8, overtime: 0 }],
      activities: 'Jateamento do costado norte', progress, occurrences: [], photos: [], ...extraRdo,
    } as any });
    const run = (name: string, input: Record<string, unknown> = {}, c = ctx) => tool(name).run!(c, input, deps) as Promise<any>;
    const sensitive = async (name: string, input: Record<string, unknown>, c = ctx) => {
      const prepared = await tool(name).prepare!(c, input, deps);
      const result = await tool(name).execute!(c, prepared.payload, deps);
      return { prepared, result };
    };
    return { db, company, user, ctx, customer, proposal: created, total: created.calc.totals.total as number, contract, order, rdo, run, sensitive };
  }

  it('declara riscos e permissões coerentes, sem repetir ferramentas que já existem', () => {
    const names = WORKS_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const existing of ['listar_os', 'ver_os', 'resultado_obras', 'quem_esta_livre', 'escalar_equipe_os', 'mover_os', 'listar_rdos', 'ver_rdo', 'rdos_pendentes', 'resumo_diario_de_obra', 'devolver_rdo', 'cobrar_rdo']) {
      expect(names).not.toContain(existing);
    }
    for (const t of WORKS_TOOLS) {
      if (t.risk === 'sensitive') { expect(t.prepare).toBeTruthy(); expect(t.execute).toBeTruthy(); expect(t.run).toBeUndefined(); } else expect(t.run).toBeTruthy();
      expect(t.permissions.length).toBeGreaterThan(0);
    }
    expect(tool('informar_pedido_do_cliente').risk).toBe('sensitive');
    expect(tool('atualizar_os').risk).toBe('draft');
    expect(tool('a_faturar').permissions).toEqual(['list_financeiro']);
  });

  it('OS da proposta nasce "A liberar"; o pedido do cliente no clique libera; atualizar_os muda datas e responsável', async () => {
    const { db, ctx, user, proposal, contract, order, run, sensitive } = await cenario();

    const found = await run('os_da_proposta', { numeroProposta: proposal.number });
    expect(found.venda).toMatchObject({ id: contract.id, tipo: 'serviço', pedidoDoCliente: null, link: `/comercial/contratos/${contract.id}` });
    expect(found.os).toMatchObject({ id: order.id, numero: order.number, etapa: 'A liberar', link: `/servicos/ordens-de-servico/${order.id}` });
    expect(found.falta).toContain('pedido de compra do cliente');

    // nada muda antes do clique
    const card = await tool('informar_pedido_do_cliente').prepare!(ctx, { osId: order.id, numero: 'PC-4512', data: '2026-11-20' }, deps);
    expect(card.summary).toContain('PC-4512');
    expect(card.details!.find((d) => d.label === 'Efeito')!.value).toContain('"A mobilizar"');
    expect((await db.service_Order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('a_liberar');

    const { result } = await sensitive('informar_pedido_do_cliente', { propostaId: proposal.id, numero: 'PC-4512', data: '2026-11-20' });
    expect(result.message).toContain('A mobilizar');
    expect(result.link).toBe(`/servicos/ordens-de-servico/${order.id}`);
    const fresh = await db.commercial_Contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(fresh.customerOrderNumber).toBe('PC-4512');
    expect(fresh.customerOrderDate?.toISOString().slice(0, 10)).toBe('2026-11-20');
    expect((await db.service_Order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('a_mobilizar');

    // escrita (draft): datas, responsável pelo nome e observações, pela rota da tela
    const updated = await run('atualizar_os', { numeroOs: order.number, inicioPrevisto: '2026-12-01', fimPrevisto: '2026-12-20', responsavel: 'bruno coordenador', observacoes: 'Levar andaime extra' });
    expect(updated.mensagem).toContain('responsável: Bruno Coordenador');
    expect(updated.os).toMatchObject({ etapa: 'A mobilizar', inicioPrevisto: '01/12/2026', fimPrevisto: '20/12/2026', responsavel: user.name });
    const row = await db.service_Order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.responsibleUserId).toBe(user.id);
    expect(row.notes).toBe('Levar andaime extra');

    const after = await run('os_da_proposta', { contratoId: contract.id });
    expect(after.os).toMatchObject({ etapa: 'A mobilizar', responsavel: user.name, inicioPrevisto: '01/12/2026' });
    expect(after.falta).toContain('mover_os');
  });

  it('recusas: término antes do início, nada a mudar, pedido com data futura e A faturar sem permissão do financeiro', async () => {
    const { ctx, order, proposal, run } = await cenario();
    await expect(run('atualizar_os', { osId: order.id, inicioPrevisto: '2026-12-10', fimPrevisto: '2026-12-01' })).rejects.toThrow('término previsto não pode ser antes');
    await expect(run('atualizar_os', { osId: order.id })).rejects.toThrow('Diga o que mudar');
    await expect(run('atualizar_os', { osId: order.id, inicioPrevisto: '10/12/2026' })).rejects.toThrow('AAAA-MM-DD');
    await expect(tool('informar_pedido_do_cliente').prepare!(ctx, { propostaId: proposal.id, numero: 'PC-1', data: '2099-01-01' }, deps)).rejects.toThrow('futura');
    await expect(run('os_da_proposta', { numeroProposta: 'PR-0000-9999' })).rejects.toBeInstanceOf(ToolRefusal);
    // a rota do A faturar pede list_financeiro: sem ela, recusa (não erro)
    await expect(run('a_faturar', {}, { ...ctx, permissions: ['list_ordens_de_servico'] })).rejects.toBeInstanceOf(ToolRefusal);
  });

  it('avanço pelo RDO fechado libera a parcela dos 50%; A faturar e estatísticas do diário enxergam', async () => {
    const { ctx, contract, order, total, rdo, run } = await cenario();
    await rdo('2026-11-02', [{ step: 0, title: 'Jateamento', percent: 80 }, { step: 1, title: 'Pintura', percent: 10 }], { weather: 'chuva', weatherEnd: 'impraticavel', occurrences: [{ type: 'paralisacao', description: 'Chuva forte', hoursLost: 3 }] });
    await rdo('2026-11-05', [{ step: 0, title: 'Jateamento', percent: 100 }, { step: 1, title: 'Pintura', percent: 20 }]);

    const avanco = await run('avanco_da_obra', { osId: order.id });
    expect(avanco.os).toMatchObject({ id: order.id, numero: order.number, link: `/servicos/ordens-de-servico/${order.id}` });
    expect(avanco.avanco.feito).toBe(60);
    expect(avanco.avanco.etapas).toEqual([{ etapa: 'Jateamento', percentual: 100 }, { etapa: 'Pintura', percentual: 20 }]);
    expect(avanco.venda).toMatchObject({ id: contract.id, modo: 'parcelas', avancoPeloRdoFechado: '60%' });
    expect(avanco.parcelas.map((p: any) => [p.parcela, p.marcoAtingido])).toEqual([['1/3', undefined], ['2/3', true], ['3/3', false]]);
    expect(avanco.parcelas[1]).toMatchObject({ vence: 'ao atingir 50% da obra', atingidoEm: '05/11/2026', valor: r2(total * 0.5), caucao: r2(r2(total * 0.5) * 0.05), faturada: false });
    expect(avanco.podemSerFaturadas).toEqual(['1/3', '2/3']);
    expect(avanco.caucao).toMatchObject({ percentual: '5%', liberaDiasAposConclusao: 30, retidaAteAgora: 0 });

    // quem não vê o comercial recebe só o avanço físico
    const operacao = await run('avanco_da_obra', { osId: order.id }, { ...ctx, permissions: ['list_ordens_de_servico', 'all_ordens_de_servico'] });
    expect(operacao.avanco.feito).toBe(60);
    expect(typeof operacao.parcelas).toBe('string');
    expect(operacao.venda).toBeUndefined();

    const fila = await run('a_faturar', { busca: contract.number });
    expect(fila.etapa).toBe('liberada');
    expect(fila.itens.map((i: any) => i.o_que)).toEqual(['parcela 1/3 · Mobilização', 'parcela 2/3 · Metade da obra']);
    expect(fila.resumo.aguardando).toEqual({ quantidade: 1, total: r2(total - r2(total * 0.3) - r2(total * 0.5)) });
    expect(fila.link).toBe('/financeiro/faturar');
    const esperando = await run('a_faturar', { busca: contract.number, etapa: 'aguardando' });
    expect(esperando.itens[0].esperando).toBe('a obra chegar a 100% (agora em 60%)');

    const stats = await run('estatisticas_diario', { de: '2026-11-01', ate: '2026-11-30', osId: order.id });
    expect(stats).toMatchObject({ rdos: 2, dias: 2, diasParados: 1, horasPerdidas: 3, link: '/servicos/estatisticas-do-diario' });
    expect(stats.clima.naEntrada).toEqual({ bom: 1, chuva: 1 });
    expect(stats.clima.naSaida).toMatchObject({ 'impraticável': 1 });
    expect(stats.ocorrencias).toEqual([{ tipo: 'paralisação', vezes: 1, horasPerdidas: 3 }]);
    expect(stats.porFuncao[0]).toMatchObject({ funcao: 'Alpinista N1', presencas: 4 });
    expect(stats.diasComMaisHorasPerdidas).toEqual([{ dia: '02/11/2026', horasPerdidas: 3, pessoas: 2 }]);
  });

  it('registrar_medicao monta o BM em rascunho pelo RDO e recusa venda por parcelas', async () => {
    const parcelas = await cenario();
    await expect(parcelas.run('registrar_medicao', { contratoId: parcelas.contract.id })).rejects.toThrow('faturada por parcelas');

    const { db, contract, order, total, rdo, run } = await cenario({ measurement: { mode: 'medicao', mobilization: { rate: 0.3 }, depositRate: 0.05, depositReleaseDays: 30 } });
    await rdo('2026-11-03', [{ step: 0, title: 'Jateamento', percent: 60 }, { step: 1, title: 'Pintura', percent: 20 }]);
    const mob = r2(total * 0.3), half = r2((total - mob) / 2);

    const avanco = await run('avanco_da_obra', { osId: order.id });
    expect(avanco.venda.modo).toBe('medição de obra (boletins)');
    expect(avanco.proximoBoletim.frentes.map((f: any) => [f.frenteId, f.sugerido])).toEqual([[1, 100], [2, 60], [3, 20]]);

    const bm = await run('registrar_medicao', { osId: order.id, inicioDoPeriodo: '2026-11-01', fimDoPeriodo: '2026-11-10' });
    // mobilização inteira + 60% do jateamento + 20% da pintura (as duas frentes por %), caução de 5% sobre a nota
    const nota = r2(mob + r2(half * 0.6) + r2(r2(total - mob - half) * 0.2)), dep = r2(nota * 0.05);
    expect(bm.boletim).toMatchObject({ numero: 'BM-01', periodo: '01/11/2026 a 10/11/2026', nota, caucao: dep, aReceber: r2(nota - dep) });
    expect(bm.link).toBe(`/comercial/contratos/${contract.id}`);
    expect((await db.commercial_Measurement.findFirstOrThrow({ where: { contractId: contract.id } })).status).toBe('rascunho');

    // um boletim em aberto por venda: a rota recusa o segundo
    await expect(run('registrar_medicao', { contratoId: contract.id })).rejects.toThrow('boletim em aberto');
  });
});
