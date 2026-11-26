import { brl, isDate, positiveInt, text } from './actors';
import { ToolContext, ToolDefinition, ToolRefusal } from './tool.types';
import type { ToolDeps } from './tool.deps';

/**
 * Financeiro pelo assistente: relatórios, contas a pagar e a receber,
 * categorização, plano de contas, centros de custo, fornecedores, contas
 * bancárias, recorrências e transferências. As ferramentas chamam as mesmas
 * rotas da tela (InternalApiService), com as permissões da pessoa.
 * Baixa, estorno, transferência e exclusão em lote mexem em dinheiro: só com
 * confirmação no cartão.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const num = (description: string) => ({ type: 'number', description });
const date = (description: string) => ({ type: 'string', description: `${description} (AAAA-MM-DD)` });
const ids = (description: string) => ({ type: 'array', items: { type: 'integer' }, description });

const LIST = ['list_financeiro'];
const CREATE = ['create_financeiro'];
const UPDATE = ['update_financeiro'];
const INACTIVE = ['inactive_financeiro'];

const PAYABLE_METHODS = ['transferencia', 'pix', 'boleto', 'cartaoCredito', 'dinheiro', 'outro'];
const DRE_GROUPS = ['receita_bruta', 'deducoes_impostos', 'custo_servico', 'despesa_operacional', 'outras_receitas', 'resultado_financeiro'];

/** Tira campos pesados ou técnicos das respostas antes de irem para o modelo. */
const HEAVY = new Set(['requestData', 'responseData', 'errorData', 'key', 'externalId', 'billUrl', 'pixUrl', 'pixNumber', 'billNumber', 'barcode', 'pixCode', 'company', 'companyId']);
function slim(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => slim(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (!HEAVY.has(key)) out[key] = slim(item, depth + 1);
    return out;
  }
  return value;
}

const api = (deps: ToolDeps) => deps.api;
const need = (value: unknown, label: string) => {
  const id = positiveInt(value);
  if (!id) throw new ToolRefusal(`Informe ${label}`);
  return id;
};
/** Monta o corpo só com o que veio (para PUT parcial). */
function pick(input: Record<string, any>, map: Record<string, string>) {
  const body: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(map)) if (input[from] !== undefined) body[to] = input[from] === '' ? null : input[from];
  return body;
}

const LEDGER_FILTERS = {
  busca: str('Texto: descrição, fornecedor/cliente, documento'),
  vencimentoDe: date('Vencimento a partir de'), vencimentoAte: date('Vencimento até'),
  pagamentoDe: date('Pago/recebido a partir de'), pagamentoAte: date('Pago/recebido até'),
  competenciaDe: str('Competência a partir de (AAAA-MM)'), competenciaAte: str('Competência até (AAAA-MM)'),
  contaId: int('Conta do plano de contas (inclui as filhas)'), centroId: int('Centro de custo'), contaBancariaId: int('Conta bancária'),
  formaPagamento: str('Forma de pagamento'), valorMin: num('Valor mínimo'), valorMax: num('Valor máximo'),
  pagina: int('Página, começando em 0'),
  empresaId: int('Só deste CNPJ do grupo (empresas_do_grupo); vazio = o grupo todo'),
};
const ledgerQuery = (input: Record<string, any>) => ({
  q: input.busca, dueFrom: input.vencimentoDe, dueTo: input.vencimentoAte, paidFrom: input.pagamentoDe, paidTo: input.pagamentoAte,
  accrualFrom: input.competenciaDe, accrualTo: input.competenciaAte, chartAccountId: input.contaId, costCenterId: input.centroId,
  bankAccountId: input.contaBancariaId, paymentMethod: input.formaPagamento, minValue: input.valorMin, maxValue: input.valorMax,
  page: input.pagina ?? 0, limit: 40, view: input.visao, entityId: input.empresaId,
});

const PAYABLE_FIELDS = {
  descricao: str('Descrição'), valor: num('Valor em reais'), vencimento: date('Vencimento'), competencia: str('Competência (AAAA-MM)'),
  fornecedorId: int('Fornecedor'), contaId: int('Conta do plano de contas (despesa)'), centroId: int('Centro de custo'),
  formaPagamento: str('Forma de pagamento', { enum: PAYABLE_METHODS }), documento: str('Número do documento (NF, boleto)'),
  observacoes: str('Observações'), osId: int('Ordem de serviço ligada'),
  empresaId: int('CNPJ do grupo que paga (empresas_do_grupo); vazio = o da OS ou o padrão'),
};
const PAYABLE_MAP = {
  descricao: 'description', valor: 'value', vencimento: 'dueDate', competencia: 'accrualDate', fornecedorId: 'supplierId', contaId: 'chartAccountId',
  centroId: 'costCenterId', formaPagamento: 'paymentMethod', documento: 'documentNumber', observacoes: 'observations', osId: 'serviceOrderId',
  empresaId: 'entityId',
};
const RECEIVABLE_FIELDS = {
  descricao: str('Descrição'), valor: num('Valor em reais'), vencimento: date('Vencimento'), competencia: str('Competência (AAAA-MM)'),
  clienteId: int('Cliente'), contaId: int('Conta do plano de contas (receita)'), centroId: int('Centro de custo'),
  formaPagamento: str('Forma de pagamento', { enum: ['pix', 'boleto', 'cartaoCredito', 'transferencia', 'dinheiro', 'outro'] }),
  notaFiscal: str('Número da nota fiscal'), observacoes: str('Observações'),
  empresaId: int('CNPJ do grupo que recebe (empresas_do_grupo); vazio = o padrão'),
};
const RECEIVABLE_MAP = {
  descricao: 'description', valor: 'value', vencimento: 'dueDate', competencia: 'accrualDate', clienteId: 'customerId', contaId: 'chartAccountId',
  centroId: 'costCenterId', formaPagamento: 'paymentMethod', notaFiscal: 'invoiceNumber', observacoes: 'observations',
  empresaId: 'entityId',
};

async function describePayables(ctx: ToolContext, deps: ToolDeps, list: number[]) {
  const rows = await deps.prisma.financial_Payable.findMany({ where: { id: { in: list }, companyId: ctx.companyId }, select: { id: true, description: true, value: true, status: true, dueDate: true, supplier: { select: { name: true } } } });
  if (rows.length !== list.length) throw new ToolRefusal('Conta a pagar não encontrada');
  return rows;
}
async function describeReceivables(ctx: ToolContext, deps: ToolDeps, list: number[]) {
  const rows = await deps.prisma.financialRecords.findMany({ where: { id: { in: list }, companyId: ctx.companyId }, select: { id: true, description: true, value: true, status: true, dueDate: true, customer: { select: { name: true } }, trainee: { select: { name: true } } } });
  if (rows.length !== list.length) throw new ToolRefusal('Conta a receber não encontrada');
  return rows;
}
const line = (row: { description: string | null; value: unknown }) => `${row.description ?? 'Sem descrição'} — ${brl(row.value)}`;
const total = (rows: { value: unknown }[]) => brl(rows.reduce((sum, row) => sum + Number(row.value ?? 0), 0));

const SETTLE_FIELDS = {
  data: date('Data do pagamento (padrão: hoje; não pode ser futura)'), valor: num('Valor efetivamente pago/recebido (opcional)'),
  contaBancariaId: int('Conta bancária de saída/entrada'), formaPagamento: str('Forma de pagamento'),
  juros: num('Juros'), multa: num('Multa'), desconto: num('Desconto'), observacoes: str('Observações'),
};

export const FINANCE_TOOLS: ToolDefinition[] = [
  // ================================================================ consultas
  {
    name: 'empresas_do_grupo',
    title: 'Vendo os CNPJs do grupo',
    description: 'Os CNPJs do grupo (ex.: WorkSafe Treinamentos, WorkSafe Serviços): id, nome, CNPJ, frentes que atende (treinamento, servico, locacao) e qual é o padrão. Use o id como empresaId nas consultas e lançamentos por CNPJ.',
    inputSchema: obj({}),
    permissions: LIST, risk: 'read',
    run: async (ctx, _input, deps) => {
      const rows = (await api(deps).call(ctx, 'GET', 'company-entities')) as Array<Record<string, any>>;
      return rows.map((e) => ({ id: e.id, nome: e.tradeName, razaoSocial: e.corporateName, cnpj: e.cnpj, frentes: e.kinds, padrao: e.isDefault }));
    },
  },
  {
    name: 'fin_resumo',
    title: 'Montando o resumo financeiro',
    description: 'Visão geral do financeiro: saldo de cada conta bancária e os cartões de contas a pagar e a receber (vencidas, hoje, na semana, depois, pagas/recebidas).',
    inputSchema: obj({}),
    permissions: LIST, risk: 'read',
    run: async (ctx, _input, deps) => {
      const [saldos, pagar, receber] = await Promise.all([
        api(deps).call(ctx, 'GET', 'financial/bank-balances'),
        api(deps).call(ctx, 'GET', 'financial/payables', { query: { limit: 1 } }),
        api(deps).call(ctx, 'GET', 'financial/receivables', { query: { limit: 1 } }),
      ]);
      return slim({ saldosBancarios: saldos, contasAPagar: pagar?.summary ?? pagar?.cards, contasAReceber: receber?.summary ?? receber?.cards });
    },
  },
  {
    name: 'fin_contas_a_pagar',
    title: 'Consultando contas a pagar',
    description: 'Lista contas a pagar com filtros e os totais. Visões: abertas (padrão), atrasadas, hoje, semana, depois, pagas, todas, excluidas.',
    inputSchema: obj({ visao: str('Visão', { enum: ['abertas', 'atrasadas', 'hoje', 'semana', 'depois', 'pagas', 'todas', 'excluidas'] }), fornecedorId: int('Fornecedor'), osId: int('Ordem de serviço'), ...LEDGER_FILTERS }),
    permissions: LIST, risk: 'read',
    run: async (ctx, input, deps) => slim(await api(deps).call(ctx, 'GET', 'financial/payables', { query: { ...ledgerQuery(input), supplierId: input.fornecedorId, serviceOrderId: input.osId } })),
  },
  {
    name: 'fin_contas_a_receber',
    title: 'Consultando contas a receber',
    description: 'Lista contas a receber com filtros e os totais. Visões: abertas (padrão), atrasadas, hoje, semana, depois, recebidas, canceladas, todas, excluidas.',
    inputSchema: obj({ visao: str('Visão', { enum: ['abertas', 'atrasadas', 'hoje', 'semana', 'depois', 'recebidas', 'canceladas', 'todas', 'excluidas'] }), clienteId: int('Cliente'), ...LEDGER_FILTERS }),
    permissions: LIST, risk: 'read',
    run: async (ctx, input, deps) => slim(await api(deps).call(ctx, 'GET', 'financial/receivables', { query: { ...ledgerQuery(input), customerId: input.clienteId } })),
  },
  {
    name: 'fin_fluxo_de_caixa',
    title: 'Montando o fluxo de caixa',
    description: 'Relatório de fluxo de caixa no período (realizado e previsto): entradas, saídas e saldo, por dia, semana ou mês. Sem datas: do início do mês até 90 dias.',
    inputSchema: obj({ de: date('Início'), ate: date('Fim'), agrupar: str('Agrupar por', { enum: ['dia', 'semana', 'mes'] }), contaBancariaId: int('Só desta conta bancária'), empresaId: int('Só deste CNPJ do grupo (vazio = o grupo todo)') }),
    permissions: LIST, risk: 'read',
    run: async (ctx, input, deps) => slim(await api(deps).call(ctx, 'GET', 'financial/reports/cash-flow', { query: { from: input.de, to: input.ate, group: ({ dia: 'day', semana: 'week', mes: 'month' } as Record<string, string>)[input.agrupar] ?? undefined, bankAccountId: input.contaBancariaId, entityId: input.empresaId } })),
  },
  {
    name: 'fin_dre',
    title: 'Montando a DRE',
    description: 'DRE (demonstração do resultado) do período: receita bruta, deduções, custos, despesas, resultado financeiro e lucro, pelo plano de contas.',
    inputSchema: obj({ de: str('Mês inicial (AAAA-MM)'), ate: str('Mês final (AAAA-MM); no máximo 24 meses'), base: str('competencia (padrão) ou caixa', { enum: ['competencia', 'caixa'] }), empresaId: int('Só deste CNPJ do grupo (vazio = o consolidado do grupo)') }),
    permissions: LIST, risk: 'read',
    run: async (ctx, input, deps) => slim(await api(deps).call(ctx, 'GET', 'financial/reports/dre', { query: { from: input.de, to: input.ate, basis: input.base, entityId: input.empresaId } })),
  },
  {
    name: 'fin_plano_de_contas',
    title: 'Abrindo o plano de contas',
    description: 'Plano de contas em árvore (receitas e despesas), com id, código, natureza, grupo da DRE e se aceita lançamentos. Use para categorizar.',
    inputSchema: obj({ mes: str('Mês para os totais (AAAA-MM), opcional'), incluirInativas: { type: 'boolean', description: 'Incluir contas inativas' } }),
    permissions: LIST, risk: 'read',
    run: async (ctx, input, deps) => slim(await api(deps).call(ctx, 'GET', 'financial/chart-accounts', { query: { month: input.mes, includeInactive: input.incluirInativas ? 'true' : undefined } })),
  },
  {
    name: 'fin_cadastros',
    title: 'Consultando cadastros do financeiro',
    description: 'Lista centros de custo, fornecedores ou contas bancárias (com id), com busca por nome.',
    inputSchema: obj({ tipo: str('Qual cadastro', { enum: ['centros_de_custo', 'fornecedores', 'contas_bancarias'] }), busca: str('Parte do nome'), incluirInativos: { type: 'boolean', description: 'Incluir inativos' } }, ['tipo']),
    permissions: LIST, risk: 'read',
    run: async (ctx, input, deps) => {
      const path = { centros_de_custo: 'financial-cost-centers', fornecedores: 'financial-suppliers', contas_bancarias: 'financial-bank-accounts' }[input.tipo as 'fornecedores'];
      if (!path) throw new ToolRefusal('Escolha o tipo de cadastro');
      return slim(await api(deps).call(ctx, 'GET', path, { query: { 'like-name': text(input.busca, 80) || undefined, 'null-inactiveAt': input.incluirInativos ? undefined : 'true', limit: 200, 'order-name': 'asc' } }));
    },
  },
  {
    name: 'fin_recorrencias',
    title: 'Consultando lançamentos recorrentes',
    description: 'Lançamentos recorrentes (aluguel, assinaturas, mensalidades) a pagar ou a receber.',
    inputSchema: obj({ tipo: str('payable (a pagar) ou receivable (a receber)', { enum: ['payable', 'receivable'] }) }),
    permissions: LIST, risk: 'read',
    run: async (ctx, input, deps) => slim(await api(deps).call(ctx, 'GET', 'financial/recurrences', { query: { kind: input.tipo } })),
  },
  {
    name: 'fin_transferencias',
    title: 'Consultando transferências',
    description: 'Transferências entre contas bancárias no período.',
    inputSchema: obj({ de: date('Início'), ate: date('Fim') }),
    permissions: LIST, risk: 'read',
    run: async (ctx, input, deps) => slim(await api(deps).call(ctx, 'GET', 'financial/transfers', { query: { from: input.de, to: input.ate } })),
  },
  {
    name: 'fin_classificacao_padrao',
    title: 'Consultando a classificação padrão',
    description: 'Conta do plano e centro de custo usados automaticamente por origem (inscrições de turma, contratos etc.).',
    inputSchema: obj({}),
    permissions: LIST, risk: 'read',
    run: async (ctx, _input, deps) => slim(await api(deps).call(ctx, 'GET', 'financial/classification-defaults')),
  },

  // ================================================================ lançamentos
  {
    name: 'fin_cadastrar_despesa',
    title: 'Cadastrando a despesa',
    description: 'Cadastra uma conta a pagar (despesa) em aberto. Com parcelas >= 2: "dividir" reparte o valor; "repetir" repete o valor todo mês. Não paga nada: a baixa é outra ação. Categorize com contaId/centroId (veja fin_plano_de_contas e fin_cadastros).',
    inputSchema: obj({ ...PAYABLE_FIELDS, parcelas: int('Número de parcelas (2 a 60), opcional'), modoParcelas: str('dividir ou repetir', { enum: ['dividir', 'repetir'] }) }, ['descricao', 'valor', 'vencimento']),
    permissions: CREATE, risk: 'draft',
    run: async (ctx, input, deps) => {
      const body = pick(input, PAYABLE_MAP);
      const count = Number(input.parcelas) || 1;
      if (count >= 2) return slim(await api(deps).call(ctx, 'POST', 'financial-payables/installments', { body: { ...body, count, mode: input.modoParcelas === 'repetir' ? 'repetir' : 'dividir' } }));
      return slim(await api(deps).call(ctx, 'POST', 'financial-payables', { body }));
    },
  },
  {
    name: 'fin_editar_conta_a_pagar',
    title: 'Editando a conta a pagar',
    description: 'Altera uma conta a pagar em aberto (descrição, valor, vencimento, fornecedor, categoria, centro...). Em parcelamento, aplicarEm "proximas" ou "todas" altera as parcelas em aberto junto.',
    inputSchema: obj({ id: int('Id da conta a pagar'), aplicarEm: str('Só esta (padrão), próximas parcelas ou todas', { enum: ['esta', 'proximas', 'todas'] }), ...PAYABLE_FIELDS }, ['id']),
    permissions: UPDATE, risk: 'draft',
    run: async (ctx, input, deps) => {
      const id = need(input.id, 'o id da conta a pagar');
      const body = pick(input, PAYABLE_MAP);
      if (!Object.keys(body).length) throw new ToolRefusal('Nada para alterar');
      if (input.aplicarEm === 'proximas' || input.aplicarEm === 'todas') {
        const row = await deps.prisma.financial_Payable.findFirst({ where: { id, companyId: ctx.companyId }, select: { groupKey: true } });
        if (!row?.groupKey) throw new ToolRefusal('Esta conta não é parcelada');
        return slim(await api(deps).call(ctx, 'PUT', `financial/payables/group/${row.groupKey}`, { body: { ...body, fromId: id, scope: input.aplicarEm } }));
      }
      return slim(await api(deps).call(ctx, 'PUT', `financial-payables/${id}`, { body }));
    },
  },
  {
    name: 'fin_cadastrar_conta_a_receber',
    title: 'Lançando a conta a receber',
    description: 'Lança uma conta a receber manual (fora do checkout de turmas), em aberto, de um cliente cadastrado (ache o id com buscar_clientes). Receber é outra ação.',
    inputSchema: obj(RECEIVABLE_FIELDS, ['descricao', 'valor', 'vencimento', 'clienteId']),
    permissions: CREATE, risk: 'draft',
    run: async (ctx, input, deps) => slim(await api(deps).call(ctx, 'POST', 'financial-records', { body: pick(input, RECEIVABLE_MAP) })),
  },
  {
    name: 'fin_editar_conta_a_receber',
    title: 'Editando a conta a receber',
    description: 'Altera uma conta a receber (descrição, vencimento, cliente, categoria, centro de custo, nota fiscal...).',
    inputSchema: obj({ id: int('Id da conta a receber'), ...RECEIVABLE_FIELDS }, ['id']),
    permissions: UPDATE, risk: 'draft',
    run: async (ctx, input, deps) => {
      const body = pick(input, RECEIVABLE_MAP);
      if (!Object.keys(body).length) throw new ToolRefusal('Nada para alterar');
      return slim(await api(deps).call(ctx, 'PUT', `financial-records/${need(input.id, 'o id da conta a receber')}`, { body }));
    },
  },
  {
    name: 'fin_categorizar',
    title: 'Categorizando lançamentos',
    description: 'Põe conta do plano e/ou centro de custo em vários lançamentos de uma vez (contas a pagar ou a receber). Use para organizar o que está sem categoria.',
    inputSchema: obj({ tipo: str('pagar ou receber', { enum: ['pagar', 'receber'] }), ids: ids('Ids dos lançamentos'), contaId: int('Conta do plano de contas'), centroId: int('Centro de custo') }, ['tipo', 'ids']),
    permissions: UPDATE, risk: 'draft',
    run: async (ctx, input, deps) => {
      const list = [...new Set((Array.isArray(input.ids) ? input.ids : []).map(Number).filter((id) => id > 0))].slice(0, 100);
      if (!list.length) throw new ToolRefusal('Informe os lançamentos');
      const body = pick(input, { contaId: 'chartAccountId', centroId: 'costCenterId' });
      if (!Object.keys(body).length) throw new ToolRefusal('Informe a conta do plano e/ou o centro de custo');
      const path = input.tipo === 'receber' ? 'financial-records' : 'financial-payables';
      const done: number[] = [];
      const failed: { id: number; motivo: string }[] = [];
      for (const id of list) {
        try { await api(deps).call(ctx, 'PUT', `${path}/${id}`, { body }); done.push(id); } catch (error) { failed.push({ id, motivo: (error as Error).message }); }
      }
      return { categorizados: done.length, falharam: failed };
    },
  },

  // ================================================================ cadastros
  {
    name: 'fin_salvar_conta_do_plano',
    title: 'Salvando a conta do plano',
    description: 'Cria (sem id) ou edita (com id) uma conta do plano de contas. Nova conta vai debaixo de contaPaiId (herda a natureza). grupoDre define onde entra na DRE.',
    inputSchema: obj({ id: int('Id para editar'), nome: str('Nome'), contaPaiId: int('Conta pai (para criar)'), grupoDre: str('Grupo da DRE', { enum: DRE_GROUPS }) }),
    permissions: [], anyPermissions: ['create_financeiro', 'update_financeiro'], risk: 'draft',
    run: async (ctx, input, deps) => {
      if (positiveInt(input.id)) {
        if (!ctx.permissions.includes('update_financeiro')) throw new ToolRefusal('Sem permissão para editar o plano de contas');
        return slim(await api(deps).call(ctx, 'PUT', `financial/chart-accounts/${input.id}`, { body: pick(input, { nome: 'name', grupoDre: 'dreGroup' }) }));
      }
      if (!ctx.permissions.includes('create_financeiro')) throw new ToolRefusal('Sem permissão para criar contas no plano');
      return slim(await api(deps).call(ctx, 'POST', 'financial/chart-accounts', { body: { name: input.nome, parentId: input.contaPaiId, dreGroup: input.grupoDre } }));
    },
  },
  {
    name: 'fin_mover_conta_do_plano',
    title: 'Movendo a conta do plano',
    description: 'Move uma conta do plano para debaixo de outra conta pai.',
    inputSchema: obj({ id: int('Conta a mover'), novaContaPaiId: int('Nova conta pai') }, ['id', 'novaContaPaiId']),
    permissions: UPDATE, risk: 'draft',
    run: async (ctx, input, deps) => slim(await api(deps).call(ctx, 'PATCH', `financial/chart-accounts/move/${need(input.id, 'a conta')}`, { body: { parentId: input.novaContaPaiId } })),
  },
  {
    name: 'fin_ativar_inativar',
    title: 'Ativando ou inativando o cadastro',
    description: 'Inativa ou reativa uma conta do plano, centro de custo, fornecedor ou conta bancária. Inativar não apaga o histórico.',
    inputSchema: obj({ tipo: str('Cadastro', { enum: ['conta_do_plano', 'centro_de_custo', 'fornecedor', 'conta_bancaria'] }), id: int('Id'), ativo: { type: 'boolean', description: 'true reativa, false inativa' } }, ['tipo', 'id', 'ativo']),
    permissions: [], anyPermissions: ['inactive_financeiro', 'activate_financeiro'], risk: 'draft',
    run: async (ctx, input, deps) => {
      const id = need(input.id, 'o id');
      const needed = input.ativo ? 'activate_financeiro' : 'inactive_financeiro';
      if (!ctx.permissions.includes(needed)) throw new ToolRefusal(`Sem a permissão ${needed}`);
      const base = { conta_do_plano: 'financial/chart-accounts', centro_de_custo: 'financial-cost-centers', fornecedor: 'financial-suppliers', conta_bancaria: 'financial-bank-accounts' }[input.tipo as 'fornecedor'];
      if (!base) throw new ToolRefusal('Escolha o tipo de cadastro');
      return slim(await api(deps).call(ctx, 'PATCH', `${base}/${input.ativo ? 'active' : 'inactive'}/${id}`));
    },
  },
  {
    name: 'fin_salvar_centro_de_custo',
    title: 'Salvando o centro de custo',
    description: 'Cria (sem id) ou edita (com id) um centro de custo.',
    inputSchema: obj({ id: int('Id para editar'), nome: str('Nome'), codigo: str('Código'), descricao: str('Descrição') }),
    permissions: [], anyPermissions: ['create_financeiro', 'update_financeiro'], risk: 'draft',
    run: async (ctx, input, deps) => {
      const body = pick(input, { nome: 'name', codigo: 'code', descricao: 'description' });
      return slim(positiveInt(input.id)
        ? await api(deps).call(ctx, 'PUT', `financial-cost-centers/${input.id}`, { body })
        : await api(deps).call(ctx, 'POST', 'financial-cost-centers', { body }));
    },
  },
  {
    name: 'fin_salvar_fornecedor',
    title: 'Salvando o fornecedor',
    description: 'Cria (sem id) ou edita (com id) um fornecedor: nome, razão social, CNPJ/CPF, o que fornece, contato, endereço, PIX e dados bancários.',
    inputSchema: obj({
      id: int('Id para editar'), nome: str('Nome fantasia'), razaoSocial: str('Razão social'), documento: str('CNPJ ou CPF'), fornece: str('O que fornece'),
      contato: str('Nome do contato'), email: str('E-mail'), telefone: str('Telefone'), pix: str('Chave PIX'), banco: str('Banco'), agencia: str('Agência'), conta: str('Conta'), observacoes: str('Observações'),
      telefone2: str('Telefone 2'), ie: str('Inscrição estadual'), cep: str('CEP'), rua: str('Rua'), numero: str('Número'), complemento: str('Complemento'), bairro: str('Bairro'), cidade: str('Cidade'), uf: str('UF (2 letras)'),
    }),
    permissions: [], anyPermissions: ['create_financeiro', 'update_financeiro'], risk: 'draft',
    run: async (ctx, input, deps) => {
      const body = pick(input, { telefone2: 'phone2', ie: 'stateRegistration', cep: 'zipcode', rua: 'street', numero: 'number', complemento: 'complement', bairro: 'neighborhood', cidade: 'city', uf: 'state', nome: 'name', razaoSocial: 'legalName', documento: 'document', fornece: 'supplies', contato: 'contactName', email: 'email', telefone: 'phone', pix: 'pixKey', banco: 'bankName', agencia: 'agency', conta: 'account', observacoes: 'notes' });
      return slim(positiveInt(input.id)
        ? await api(deps).call(ctx, 'PUT', `financial-suppliers/${input.id}`, { body })
        : await api(deps).call(ctx, 'POST', 'financial-suppliers', { body }));
    },
  },
  {
    name: 'fin_salvar_conta_bancaria',
    title: 'Salvando a conta bancária',
    description: 'Cria (sem id) ou edita (com id) uma conta bancária ou caixa: nome, tipo, banco, agência, conta, saldo inicial e data.',
    inputSchema: obj({
      id: int('Id para editar'), nome: str('Nome'), tipo: str('Tipo', { enum: ['corrente', 'poupanca', 'caixa'] }), banco: str('Nome do banco'), codigoBanco: str('Código do banco'),
      agencia: str('Agência'), conta: str('Conta'), pix: str('Chave PIX'), saldoInicial: num('Saldo inicial'), dataSaldoInicial: date('Data do saldo inicial'), padrao: { type: 'boolean', description: 'Conta padrão' },
    }),
    permissions: [], anyPermissions: ['create_financeiro', 'update_financeiro'], risk: 'draft',
    run: async (ctx, input, deps) => {
      const body = pick(input, { nome: 'name', tipo: 'type', banco: 'bankName', codigoBanco: 'bankCode', agencia: 'agency', conta: 'account', pix: 'pixKey', saldoInicial: 'openingBalance', dataSaldoInicial: 'openingBalanceDate', padrao: 'isDefault' });
      return slim(positiveInt(input.id)
        ? await api(deps).call(ctx, 'PUT', `financial-bank-accounts/${input.id}`, { body })
        : await api(deps).call(ctx, 'POST', 'financial-bank-accounts', { body }));
    },
  },
  {
    name: 'fin_salvar_recorrencia',
    title: 'Salvando o lançamento recorrente',
    description: 'Cria (sem id) ou edita (com id) um lançamento recorrente mensal (ex.: aluguel, internet, mensalidade). Editar muda as ocorrências em aberto daqui para frente.',
    inputSchema: obj({
      id: int('Id para editar'), tipo: str('payable (a pagar) ou receivable (a receber)', { enum: ['payable', 'receivable'] }), descricao: str('Descrição'), valor: num('Valor mensal'),
      primeiroVencimento: date('Primeiro vencimento'), dataFinal: date('Último mês (opcional)'), fornecedorId: int('Fornecedor (a pagar)'), clienteId: int('Cliente (a receber)'),
      contaId: int('Conta do plano'), centroId: int('Centro de custo'), formaPagamento: str('Forma de pagamento'), observacoes: str('Observações'),
    }),
    permissions: [], anyPermissions: ['create_financeiro', 'update_financeiro'], risk: 'draft',
    run: async (ctx, input, deps) => {
      const body = pick(input, { tipo: 'kind', descricao: 'description', valor: 'value', primeiroVencimento: 'startDate', dataFinal: 'endDate', fornecedorId: 'supplierId', clienteId: 'customerId', contaId: 'chartAccountId', centroId: 'costCenterId', formaPagamento: 'paymentMethod', observacoes: 'observations' });
      return slim(positiveInt(input.id)
        ? await api(deps).call(ctx, 'PUT', `financial/recurrences/${input.id}`, { body })
        : await api(deps).call(ctx, 'POST', 'financial/recurrences', { body }));
    },
  },
  {
    name: 'fin_encerrar_recorrencia',
    title: 'Encerrando o lançamento recorrente',
    description: 'Encerra um lançamento recorrente: não gera mais ocorrências (as em aberto futuras saem).',
    inputSchema: obj({ id: int('Id do lançamento recorrente'), ultimoMes: date('Encerrar a partir de (opcional)') }, ['id']),
    permissions: INACTIVE, risk: 'draft',
    run: async (ctx, input, deps) => slim(await api(deps).call(ctx, 'PATCH', `financial/recurrences/${need(input.id, 'o id')}/end`, { body: { endDate: input.ultimoMes } })),
  },
  {
    name: 'fin_definir_classificacao_padrao',
    title: 'Definindo a classificação padrão',
    description: 'Define a conta do plano e o centro de custo usados automaticamente para uma origem (veja fin_classificacao_padrao). aplicarNasInscricoes reclassifica as inscrições sem categoria.',
    inputSchema: obj({ origem: str('Origem (de fin_classificacao_padrao)'), contaId: int('Conta do plano'), centroId: int('Centro de custo'), aplicarNasInscricoes: { type: 'boolean', description: 'Aplicar nas inscrições já lançadas sem categoria' } }, ['origem']),
    permissions: UPDATE, risk: 'draft',
    run: async (ctx, input, deps) => {
      const origin = text(input.origem, 40);
      if (!origin) throw new ToolRefusal('Informe a origem');
      const saved = await api(deps).call(ctx, 'PUT', `financial/classification-defaults/${encodeURIComponent(origin)}`, { body: { chartAccountId: input.contaId ?? null, costCenterId: input.centroId ?? null } });
      const applied = input.aplicarNasInscricoes ? await api(deps).call(ctx, 'POST', 'financial/classification-defaults/apply') : undefined;
      return slim({ salvo: saved, aplicado: applied });
    },
  },

  // ================================================================ dinheiro (com confirmação)
  {
    name: 'fin_dar_baixa',
    title: 'Preparando a baixa',
    description: 'Registra o pagamento (contas a pagar) ou o recebimento (contas a receber) de um ou vários lançamentos em aberto. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({ tipo: str('pagar ou receber', { enum: ['pagar', 'receber'] }), ids: ids('Ids dos lançamentos'), ...SETTLE_FIELDS }, ['tipo', 'ids']),
    permissions: UPDATE, risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const list = [...new Set((Array.isArray(input.ids) ? input.ids : []).map(Number).filter((id) => id > 0))].slice(0, 100);
      if (!list.length) throw new ToolRefusal('Informe os lançamentos');
      if (input.data && (!isDate(input.data) || input.data > new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10))) throw new ToolRefusal('Data inválida ou futura');
      if (input.valor !== undefined && list.length > 1) throw new ToolRefusal('Valor pago só vale para um lançamento por vez');
      const pagar = input.tipo !== 'receber';
      const rows = pagar ? await describePayables(ctx, deps, list) : await describeReceivables(ctx, deps, list);
      const closed = rows.filter((row: any) => (pagar ? row.status !== 'aberta' : row.status === 'received'));
      if (closed.length) throw new ToolRefusal(`Já baixado: ${closed.map((row: any) => row.id).join(', ')}`);
      const details = rows.slice(0, 8).map((row: any) => ({ label: `#${row.id}`, value: line(row) }));
      if (rows.length > 8) details.push({ label: '…', value: `mais ${rows.length - 8}` });
      if (input.contaBancariaId) {
        const bank = await deps.prisma.financial_BankAccount.findFirst({ where: { id: Number(input.contaBancariaId), companyId: ctx.companyId }, select: { name: true } });
        if (!bank) throw new ToolRefusal('Conta bancária não encontrada');
        details.push({ label: 'Conta', value: bank.name });
      }
      if (input.data) details.push({ label: 'Data', value: String(input.data).split('-').reverse().join('/') });
      return {
        summary: `${pagar ? 'Registrar o PAGAMENTO' : 'Registrar o RECEBIMENTO'} de ${rows.length} lançamento(s), total ${total(rows)}?`,
        details,
        payload: { tipo: pagar ? 'pagar' : 'receber', ids: list, paidAt: input.data, value: input.valor, bankAccountId: input.contaBancariaId, paymentMethod: input.formaPagamento, interestValue: input.juros, fineValue: input.multa, discountValue: input.desconto, observations: input.observacoes },
      };
    },
    execute: async (ctx, payload, deps) => {
      const pagar = payload.tipo === 'pagar';
      const extras = { paidAt: payload.paidAt, bankAccountId: payload.bankAccountId, paymentMethod: payload.paymentMethod, interestValue: payload.interestValue, fineValue: payload.fineValue, discountValue: payload.discountValue, observations: payload.observations };
      if (payload.ids.length === 1) {
        await api(deps).call(ctx, 'PATCH', `${pagar ? 'financial-payables' : 'financial-records'}/settle/${payload.ids[0]}`, { body: { ...extras, ...(payload.value !== undefined ? (pagar ? { paidValue: payload.value } : { receivedValue: payload.value }) : {}) } });
      } else {
        await api(deps).call(ctx, 'POST', `financial/${pagar ? 'payables' : 'receivables'}/bulk-settle`, { body: { ids: payload.ids, ...extras } });
      }
      return { message: `${payload.ids.length} lançamento(s) ${pagar ? 'pagos' : 'recebidos'}.`, link: pagar ? '/financeiro/pagar' : '/financeiro/receber' };
    },
  },
  {
    name: 'fin_estornar_baixa',
    title: 'Preparando o estorno',
    description: 'Desfaz a baixa (pagamento ou recebimento) de um lançamento: ele volta a ficar em aberto. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({ tipo: str('pagar ou receber', { enum: ['pagar', 'receber'] }), id: int('Id do lançamento'), motivo: str('Motivo') }, ['tipo', 'id']),
    permissions: UPDATE, risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const id = need(input.id, 'o id');
      const pagar = input.tipo !== 'receber';
      const [row] = pagar ? await describePayables(ctx, deps, [id]) : await describeReceivables(ctx, deps, [id]);
      return { summary: `Estornar a baixa de "${line(row as any)}"? Ele volta a ficar em aberto.`, details: input.motivo ? [{ label: 'Motivo', value: text(input.motivo, 200) }] : [], payload: { tipo: pagar ? 'pagar' : 'receber', id, motivo: text(input.motivo, 500) } };
    },
    execute: async (ctx, payload, deps) => {
      await api(deps).call(ctx, 'PATCH', `${payload.tipo === 'pagar' ? 'financial-payables' : 'financial-records'}/unsettle/${payload.id}`, { body: { observations: payload.motivo || undefined } });
      return { message: 'Baixa estornada: o lançamento voltou a ficar em aberto.', link: payload.tipo === 'pagar' ? '/financeiro/pagar' : '/financeiro/receber' };
    },
  },
  {
    name: 'fin_transferir_entre_contas',
    title: 'Preparando a transferência',
    description: 'Registra uma transferência entre duas contas bancárias da empresa (não envia dinheiro: registra o que foi feito no banco). Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({ deContaId: int('Conta de origem'), paraContaId: int('Conta de destino'), valor: num('Valor'), data: date('Data'), descricao: str('Descrição') }, ['deContaId', 'paraContaId', 'valor', 'data']),
    permissions: CREATE, risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const banks = await deps.prisma.financial_BankAccount.findMany({ where: { id: { in: [Number(input.deContaId), Number(input.paraContaId)] }, companyId: ctx.companyId }, select: { id: true, name: true } });
      const from = banks.find((bank) => bank.id === Number(input.deContaId));
      const to = banks.find((bank) => bank.id === Number(input.paraContaId));
      if (!from || !to || from.id === to.id) throw new ToolRefusal('Escolha duas contas bancárias diferentes da empresa');
      if (!(Number(input.valor) > 0) || !isDate(input.data)) throw new ToolRefusal('Informe valor e data');
      return { summary: `Registrar transferência de ${brl(input.valor)} de "${from.name}" para "${to.name}"?`, details: [{ label: 'Data', value: String(input.data).split('-').reverse().join('/') }, ...(input.descricao ? [{ label: 'Descrição', value: text(input.descricao, 200) }] : [])], payload: { fromBankAccountId: from.id, toBankAccountId: to.id, value: Number(input.valor), date: input.data, description: text(input.descricao, 200) } };
    },
    execute: async (ctx, payload, deps) => {
      await api(deps).call(ctx, 'POST', 'financial/transfers', { body: payload });
      return { message: `Transferência de ${brl(payload.value)} registrada.`, link: '/financeiro/contas-bancarias' };
    },
  },
  {
    name: 'fin_excluir_lancamentos',
    title: 'Preparando a exclusão',
    description: 'Exclui (arquiva) lançamentos em aberto, a pagar ou a receber. Fica em "excluídas" e pode ser restaurado na tela. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({ tipo: str('pagar ou receber', { enum: ['pagar', 'receber'] }), ids: ids('Ids dos lançamentos'), motivo: str('Motivo') }, ['tipo', 'ids']),
    permissions: INACTIVE, risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const list = [...new Set((Array.isArray(input.ids) ? input.ids : []).map(Number).filter((id) => id > 0))].slice(0, 100);
      if (!list.length) throw new ToolRefusal('Informe os lançamentos');
      const pagar = input.tipo !== 'receber';
      const rows = pagar ? await describePayables(ctx, deps, list) : await describeReceivables(ctx, deps, list);
      return { summary: `Excluir ${rows.length} lançamento(s) ${pagar ? 'a pagar' : 'a receber'}, total ${total(rows)}?`, details: rows.slice(0, 8).map((row: any) => ({ label: `#${row.id}`, value: line(row) })), payload: { tipo: pagar ? 'pagar' : 'receber', ids: list, reason: text(input.motivo, 300) } };
    },
    execute: async (ctx, payload, deps) => {
      await api(deps).call(ctx, 'POST', `financial/${payload.tipo === 'pagar' ? 'payables' : 'receivables'}/bulk-archive`, { body: { ids: payload.ids, reason: payload.reason } });
      return { message: `${payload.ids.length} lançamento(s) excluído(s).`, link: payload.tipo === 'pagar' ? '/financeiro/pagar' : '/financeiro/receber' };
    },
  },
];
