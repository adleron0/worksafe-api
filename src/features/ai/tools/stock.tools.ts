import { brl, iso, isDate, money, positiveInt, text, todayBr } from './actors';
import type { ToolDeps } from './tool.deps';
import { ToolContext, ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Suprimentos (compras e estoque) para o bot de Suprimentos e o MCP. Tudo vai
 * pelas rotas da tela (deps.api.call), em nome da pessoa: as regras do livro
 * de estoque (saldo nunca negativo, peça liberada, custo médio), da esteira do
 * pedido de compra (aprovar exige a permissão, comprar gera as contas a pagar,
 * receber dá entrada no estoque) e de quem vê custo valem iguais aqui.
 * O prisma só aparece para achar ids (local, item, funcionário, peça) e
 * montar o cartão de confirmação.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });
const list = (description: string, items: Record<string, unknown>) => ({ type: 'array', description, items });

const has = (ctx: ToolContext, permission: string) => ctx.permissions.includes(permission);
const qty = (value: unknown) => Math.round(Number(value ?? 0) * 1000) / 1000;
const brDate = (value: string | null | undefined) => (value ? value.split('-').reverse().join('/') : '?');

const L = {
  item: (id: number) => `/suprimentos/estoque/itens/${id}`,
  items: '/suprimentos/estoque/itens',
  movements: '/suprimentos/estoque/movimentacoes',
  reorder: '/suprimentos/compras/reposicao',
  purchase: (id: number) => `/suprimentos/pedidos-de-compra/${id}`,
  ppe: '/suprimentos/estoque/epi',
  dues: '/suprimentos/equipamentos/vencimentos',
  unit: (id: number) => `/suprimentos/equipamentos/${id}`,
  inspections: '/suprimentos/equipamentos/inspecoes',
  rental: (id: number) => `/suprimentos/locacoes/${id}`,
};

const MOVE_TYPES: Record<string, { label: string; permission: string; out: boolean }> = {
  entrada_avulsa: { label: 'Entrada avulsa', permission: 'movimentar_estoque', out: false },
  transferencia: { label: 'Transferência', permission: 'movimentar_estoque', out: true },
  consumo_interno: { label: 'Consumo interno', permission: 'movimentar_estoque', out: true },
  venda: { label: 'Venda', permission: 'movimentar_estoque', out: true },
  ajuste: { label: 'Ajuste de saldo', permission: 'ajuste_estoque', out: false },
  saldo_inicial: { label: 'Saldo inicial', permission: 'ajuste_estoque', out: false },
};
const PURCHASE_LABEL: Record<string, string> = { solicitado: 'Solicitado', aprovado: 'Aprovado', comprado: 'Comprado', recebido: 'Recebido', recusado: 'Recusado', cancelado: 'Cancelado' };
const PURCHASE_GROUPS = ['material', 'locacao', 'terceiros', 'outros'];
const PAY_METHODS = ['transferencia', 'pix', 'boleto', 'cartaoCredito', 'dinheiro', 'outro'];
const PPE_REASONS: Record<string, string> = { admissao: 'Admissão', troca_desgaste: 'Troca por desgaste', troca_dano: 'Troca por dano', perda: 'Perda', troca_periodica: 'Troca periódica', outro: 'Outro' };
const INSPECTION_KINDS: Record<string, string> = { pre_uso: 'Pré-uso', periodica: 'Periódica', extraordinaria: 'Extraordinária', recebimento: 'Recebimento' };
const INSPECTION_RESULTS: Record<string, string> = { aprovado: 'Aprovado', aprovado_ressalva: 'Aprovado com ressalva', reprovado: 'Reprovado' };

// ------------------------------------------------------------------ busca de ids

async function locationOf(ctx: ToolContext, deps: ToolDeps, id: unknown, label = 'Local') {
  const row = await deps.prisma.stock_Location.findFirst({ where: { id: positiveInt(id) ?? 0, companyId: ctx.companyId, inactiveAt: null }, select: { id: true, name: true } });
  if (!row) {
    const options = await deps.prisma.stock_Location.findMany({ where: { companyId: ctx.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true }, take: 20 });
    throw new ToolRefusal(`${label} não encontrado. Locais: ${options.map((o) => `${o.id} = ${o.name}`).join('; ') || 'nenhum cadastrado'}`);
  }
  return row;
}

async function itemOf(ctx: ToolContext, deps: ToolDeps, id: unknown) {
  const row = await deps.prisma.stock_Item.findFirst({
    where: { id: positiveInt(id) ?? 0, companyId: ctx.companyId },
    select: { id: true, code: true, name: true, unit: true, tracking: true, isPpe: true, caNumber: true, caExpiry: true, lastCost: true, inactiveAt: true },
  });
  if (!row) throw new ToolRefusal(`Item ${id} não encontrado (veja o id em buscar_item_estoque)`);
  if (row.inactiveAt) throw new ToolRefusal(`${row.name} está inativo`);
  return row;
}

/** Saldo de um item (e lote) num local. */
async function balanceAt(deps: ToolDeps, companyId: number, itemId: number, locationId: number, lotId?: number | null) {
  const out = await deps.prisma.stock_Balance.aggregate({
    where: { companyId, itemId, holderType: 'local', holderId: locationId, ...(lotId ? { lotId } : {}) }, _sum: { quantity: true },
  });
  return qty(out._sum.quantity);
}

/** Peça pela etiqueta (ou id): precisa estar no local para sair dele. */
async function unitOf(ctx: ToolContext, deps: ToolDeps, raw: { pecaId?: unknown; etiqueta?: unknown }) {
  const tag = text(raw.etiqueta, 40).toUpperCase();
  const row = await deps.prisma.stock_Unit.findFirst({
    where: { companyId: ctx.companyId, ...(positiveInt(raw.pecaId) ? { id: positiveInt(raw.pecaId)! } : { tag }) },
    select: { id: true, tag: true, itemId: true, status: true, holderType: true, holderId: true, lotId: true },
  });
  if (!row) throw new ToolRefusal(`Peça ${tag || raw.pecaId} não encontrada`);
  return row;
}

interface LineInput { itemId?: unknown; quantidade?: unknown; custoUnitario?: unknown; lote?: unknown; validade?: unknown; etiqueta?: unknown; pecaId?: unknown }

/**
 * Valida as linhas de uma saída/entrada a partir de um local e devolve as linhas
 * no formato da rota + o texto do cartão. Saída confere o saldo do local.
 */
async function stockLines(ctx: ToolContext, deps: ToolDeps, raws: LineInput[], locationId: number, mode: 'in' | 'out' | 'delta') {
  if (!Array.isArray(raws) || !raws.length) throw new ToolRefusal('Informe pelo menos um item');
  if (raws.length > 50) throw new ToolRefusal('No máximo 50 itens por lançamento');
  const lines: Record<string, unknown>[] = [];
  const shown: string[] = [];
  for (const [index, raw] of raws.entries()) {
    // peça por etiqueta sem itemId: acha o item pela peça
    const unit = mode === 'out' && (raw.etiqueta || raw.pecaId) ? await unitOf(ctx, deps, raw) : null;
    const item = await itemOf(ctx, deps, raw.itemId ?? unit?.itemId);
    const n = index + 1;
    if (mode === 'out' && item.tracking === 'unidade') {
      if (!unit || unit.itemId !== item.id) throw new ToolRefusal(`${item.name} é controlado por peça: informe a etiqueta de cada peça (uma linha por peça)`);
      if (unit.holderType !== 'local' || unit.holderId !== locationId) throw new ToolRefusal(`A peça ${unit.tag} não está neste local`);
      lines.push({ itemId: item.id, unitId: unit.id, quantity: 1 });
      shown.push(`${item.name} — peça ${unit.tag}`);
      continue;
    }
    const quantity = qty(raw.quantidade);
    if (mode === 'delta') {
      if (!quantity) throw new ToolRefusal(`Linha ${n} (${item.name}): informe a diferença (+ entra, − sai)`);
      if (item.tracking === 'unidade') throw new ToolRefusal(`${item.name}: peça rastreada não se ajusta por quantidade`);
    } else if (!(quantity > 0)) throw new ToolRefusal(`Linha ${n} (${item.name}): informe a quantidade`);
    const line: Record<string, unknown> = { itemId: item.id, quantity };
    let lotLabel = '';
    if (item.tracking === 'lote') {
      const number = text(raw.lote, 60);
      if (!number) throw new ToolRefusal(`${item.name} é controlado por lote: informe o número do lote`);
      if (mode === 'in' || (mode === 'delta' && quantity > 0)) {
        line.lotNumber = number;
        if (raw.validade) {
          if (!isDate(raw.validade)) throw new ToolRefusal(`Validade do lote de ${item.name}: use AAAA-MM-DD`);
          line.expiresAt = raw.validade;
        }
      } else {
        const lot = await deps.prisma.stock_Lot.findFirst({ where: { itemId: item.id, number }, select: { id: true } });
        if (!lot) throw new ToolRefusal(`Lote ${number} de ${item.name} não encontrado`);
        line.lotId = lot.id;
      }
      lotLabel = ` (lote ${number})`;
    }
    if (mode === 'out' || (mode === 'delta' && quantity < 0)) {
      const available = await balanceAt(deps, ctx.companyId, item.id, locationId, (line.lotId as number) ?? null);
      if (available < Math.abs(quantity)) throw new ToolRefusal(`${item.name}${lotLabel}: só há ${available} ${item.unit} neste local`);
    }
    if (mode === 'in' && raw.custoUnitario !== undefined && raw.custoUnitario !== null && raw.custoUnitario !== '') {
      const cost = Number(raw.custoUnitario);
      if (!(cost >= 0)) throw new ToolRefusal(`Linha ${n}: custo inválido`);
      line.unitCost = cost;
    }
    lines.push(line);
    shown.push(`${mode === 'delta' && quantity > 0 ? '+' : ''}${quantity} ${item.unit} ${item.name}${lotLabel}${line.unitCost !== undefined ? ` a ${brl(line.unitCost)}` : ''}${item.tracking === 'unidade' && mode === 'in' ? ' (as peças ganham etiqueta automática)' : ''}`);
  }
  return { lines, shown };
}

async function purchaseOf(ctx: ToolContext, deps: ToolDeps, input: Record<string, any>) {
  let id = positiveInt(input.pedidoId);
  const number = text(input.numero, 30).toUpperCase();
  if (!id && number) {
    const row = await deps.prisma.purchase_Order.findFirst({ where: { companyId: ctx.companyId, number, inactiveAt: null }, select: { id: true } });
    id = row?.id ?? null;
  }
  if (!id) throw new ToolRefusal('Pedido de compra não encontrado (veja o id em listar_pedidos_de_compra)');
  return deps.api.call<any>(ctx, 'GET', `purchase-orders/${id}`);
}

const purchaseLine = (p: any) => ({
  id: p.id, numero: p.number, titulo: p.title, situacao: p.statusLabel ?? PURCHASE_LABEL[p.status] ?? p.status,
  fornecedor: p.supplier?.name ?? null, total: money(p.total), link: L.purchase(p.id),
});

// ------------------------------------------------------------------ ferramentas

export const STOCK_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------- estoque: consultas
  {
    name: 'estoque_visao_geral',
    title: 'Olhando o estoque',
    description: 'Painel do estoque: itens abaixo do mínimo, valor em estoque (se a pessoa vê custos), materiais em obras, inspeções e calibrações vencendo em 30 dias, peças fora (funcionário, locação, fornecedor), locações ativas/atrasadas e pedidos comprados esperando recebimento.',
    inputSchema: obj({}),
    permissions: ['list_itens_estoque'],
    risk: 'read',
    run: async (ctx, _input, deps) => {
      const o = await deps.api.call<any>(ctx, 'GET', 'stock/overview');
      return {
        abaixoDoMinimo: o.low, valorEmEstoque: o.value === null ? undefined : money(o.value), obrasComMaterial: o.atOrders,
        inspecoesVencendo: o.inspections, calibracoesVencendo: o.calibrations, pecasForaDoEstoque: o.outside,
        locacoesAtivas: o.rentalsActive, locacoesAtrasadas: o.rentalsLate, pedidosEsperandoRecebimento: o.pendingReceipts,
        links: { itens: L.items, reposicao: L.reorder, vencimentos: L.dues },
      };
    },
  },
  {
    name: 'buscar_item_estoque',
    title: 'Procurando no estoque',
    description: 'Procura itens do estoque por nome, código ou fabricante (ou pelo id) e devolve saldo em estoque e fora, disponível, mínimo, último custo e custo médio (se a pessoa vê custos). Com um item só (ou itemId), traz o saldo por local/posição e os lotes. Use para achar o itemId antes de movimentar, comprar ou entregar EPI.',
    inputSchema: obj({ busca: str('Nome, código ou fabricante'), itemId: int('Id do item, se já souber'), soEpi: bool('Só itens marcados como EPI') }),
    permissions: ['list_itens_estoque'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      let id = positiveInt(input.itemId);
      let found: any[] = [];
      if (!id) {
        const term = text(input.busca, 80);
        if (term.length < 2) throw new ToolRefusal('Informe ao menos 2 letras do nome ou o código');
        const out = await deps.api.call<any>(ctx, 'GET', 'stock/items', { query: { search: term, limit: 15, flag: input.soEpi ? 'epi' : undefined } });
        found = out.rows ?? [];
        if (!found.length) return { itens: [], aviso: 'Nenhum item encontrado com esse nome ou código.' };
        if (found.length === 1) id = found[0].id;
      }
      if (!id) {
        return {
          total: found.length,
          itens: found.map((row) => ({
            itemId: row.id, codigo: row.code, nome: row.name, unidade: row.unit, categoria: row.category, controle: row.tracking,
            emEstoque: row.inStock, fora: row.out, disponivel: row.available, minimo: row.minQuantity, abaixoDoMinimo: row.low,
            ultimoCusto: row.lastCost ?? undefined, epi: row.isPpe || undefined, link: L.item(row.id),
          })),
        };
      }
      const row = await deps.api.call<any>(ctx, 'GET', `stock/items/${id}`);
      return {
        itemId: row.id, codigo: row.code, nome: row.name, unidade: row.unit, categoria: row.category, controle: row.tracking, ativo: row.active,
        emEstoque: row.inStock, fora: row.out, disponivel: row.available, minimo: row.minQuantity, reposicaoPadrao: row.reorderQuantity, abaixoDoMinimo: row.low,
        ultimoCusto: row.lastCost ?? undefined, custoMedio: row.averageCost ?? undefined, ultimaCompra: row.lastPurchaseAt,
        epi: row.isPpe ? { ca: row.caNumber, validadeCa: row.caExpiry, situacaoCa: row.caState } : undefined,
        saldos: (row.balances ?? []).map((b: any) => ({ onde: b.holder, tipo: b.holderType, localId: b.holderType === 'local' ? b.holderId : undefined, lote: b.lot ?? undefined, quantidade: b.quantity })),
        lotes: (row.lots ?? []).filter((l: any) => l.quantity > 0).map((l: any) => ({ lote: l.number, validade: l.expiresAt, situacao: l.expiryState, quantidade: l.quantity })),
        link: L.item(row.id),
      };
    },
  },
  {
    name: 'itens_para_repor',
    title: 'Vendo o que repor',
    description: 'Itens abaixo do estoque mínimo com a quantidade sugerida para comprar, o último custo e o último fornecedor. Dá para mandar direto para criar_pedido_de_compra (daReposicao).',
    inputSchema: obj({}),
    permissions: ['list_itens_estoque'],
    risk: 'read',
    run: async (ctx, _input, deps) => {
      const rows = await deps.api.call<any[]>(ctx, 'GET', 'stock/reorder');
      return {
        total: rows.length,
        itens: rows.map((r) => ({
          itemId: r.id, codigo: r.code, nome: r.name, unidade: r.unit, disponivel: r.available, minimo: r.min, sugestaoCompra: r.suggested,
          ultimoCusto: r.lastCost ?? undefined, ultimoFornecedor: r.lastSupplier, ultimoFornecedorId: r.lastSupplierId ?? undefined,
        })),
        link: L.reorder,
        aviso: rows.length ? undefined : 'Nenhum item abaixo do mínimo.',
      };
    },
  },
  {
    name: 'movimentacoes_estoque',
    title: 'Consultando as movimentações',
    description: 'Movimentações do estoque (entradas, saídas para obra, transferências, entregas de EPI, ajustes...) mais recentes primeiro, com filtros por item, tipo, período ou texto.',
    inputSchema: obj({
      itemId: int('Só deste item'),
      tipo: str('Tipo', { enum: ['saldo_inicial', 'entrada_compra', 'entrada_avulsa', 'transferencia', 'saida_os', 'retorno_os', 'consumo_os', 'consumo_interno', 'entrega_epi', 'devolucao_epi', 'saida_locacao', 'retorno_locacao', 'envio_fornecedor', 'retorno_fornecedor', 'baixa', 'ajuste', 'venda', 'estorno'] }),
      de: str('Desde (AAAA-MM-DD)'), ate: str('Até (AAAA-MM-DD)'), busca: str('Número, observação ou nome do item'),
    }),
    permissions: ['list_itens_estoque'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      for (const key of ['de', 'ate']) if (input[key] && !isDate(input[key])) throw new ToolRefusal(`Data "${key}": use AAAA-MM-DD`);
      const out = await deps.api.call<any>(ctx, 'GET', 'stock/movements', {
        query: { itemId: positiveInt(input.itemId), type: input.tipo, from: input.de, to: input.ate, search: text(input.busca, 80), limit: 30 },
      });
      return {
        total: out.total,
        movimentacoes: (out.rows ?? []).map((r: any) => ({
          id: r.id, numero: r.number, tipo: r.typeLabel, data: r.date, de: r.from, para: r.to, itens: r.summary, por: r.user,
          observacao: r.note ?? undefined, estornada: r.reversed || undefined, valor: r.total === null ? undefined : money(r.total),
        })),
        link: L.movements,
      };
    },
  },

  // ---------------------------------------------------------- estoque: lançamento
  {
    name: 'registrar_movimentacao_estoque',
    title: 'Preparando a movimentação',
    description: 'Lança à mão no estoque: entrada avulsa (sem pedido), transferência entre locais, consumo interno, venda, ajuste de saldo (quantidade com sinal: +2 entra, -1 sai; exige motivo) ou saldo inicial. Para compra use receber_pedido_de_compra; para EPI, entregar_epi. Item por peça: uma linha por etiqueta na saída. Item por lote: informe o lote. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      tipo: str('Tipo do lançamento', { enum: Object.keys(MOVE_TYPES) }),
      localId: int('Local de onde sai (ou onde entra)'),
      localDestinoId: int('Transferência: local de destino'),
      itens: list('Itens', obj({
        itemId: int('Id do item (de buscar_item_estoque)'), quantidade: num('Quantidade (no ajuste, com sinal)'), custoUnitario: num('Entrada: custo unitário em reais'),
        lote: str('Número do lote (itens por lote)'), validade: str('Entrada por lote: validade AAAA-MM-DD'), etiqueta: str('Saída de item por peça: etiqueta da peça'),
      })),
      data: str('Data (AAAA-MM-DD; padrão hoje; não pode ser futura)'),
      observacao: str('Observação (no ajuste, o motivo — obrigatório)'),
    }, ['tipo', 'localId', 'itens']),
    permissions: [],
    anyPermissions: ['movimentar_estoque', 'ajuste_estoque'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const type = MOVE_TYPES[String(input.tipo)];
      if (!type) throw new ToolRefusal(`Tipo inválido: use ${Object.keys(MOVE_TYPES).join(', ')}`);
      if (!has(ctx, type.permission)) throw new ToolRefusal(`${type.label} exige a permissão ${type.permission === 'ajuste_estoque' ? 'de ajustar o estoque' : 'de movimentar o estoque'}`);
      const date = input.data ? String(input.data) : todayBr();
      if (!isDate(date) || date > todayBr()) throw new ToolRefusal('Data inválida ou no futuro');
      const note = text(input.observacao, 1000);
      if (input.tipo === 'ajuste' && !note) throw new ToolRefusal('Informe o motivo do ajuste (observacao)');
      const location = await locationOf(ctx, deps, input.localId);
      let destination: { id: number; name: string } | null = null;
      if (input.tipo === 'transferencia') {
        destination = await locationOf(ctx, deps, input.localDestinoId, 'Local de destino');
        if (destination.id === location.id) throw new ToolRefusal('O destino precisa ser outro local');
      }
      const mode = input.tipo === 'ajuste' ? 'delta' : type.out ? 'out' : 'in';
      const { lines, shown } = await stockLines(ctx, deps, input.itens, location.id, mode);
      const where = destination ? `de ${location.name} para ${destination.name}` : type.out ? `saindo de ${location.name}` : `em ${location.name}`;
      return {
        summary: `${type.label} ${where}: ${shown.length} item(ns)?`,
        details: [
          { label: 'Tipo', value: type.label },
          { label: destination ? 'Origem → destino' : 'Local', value: destination ? `${location.name} → ${destination.name}` : location.name },
          { label: 'Itens', value: shown.join('; ') },
          { label: 'Data', value: brDate(date) },
          ...(note ? [{ label: 'Observação', value: note }] : []),
        ],
        payload: { body: { type: input.tipo, date, locationId: location.id, ...(destination ? { toLocationId: destination.id } : {}), note: note || null, lines } },
      };
    },
    execute: async (ctx, payload, deps) => {
      const out = await deps.api.call<any>(ctx, 'POST', 'stock/movements', { body: payload.body });
      return { message: `Movimentação ${out.number} lançada (${out.typeLabel}, ${out.lines?.length ?? 0} linha(s)).`, link: L.movements, data: { movimentacaoId: out.id, numero: out.number } };
    },
  },

  // ---------------------------------------------------------- pedidos de compra
  {
    name: 'ver_pedido_de_compra',
    title: 'Abrindo o pedido de compra',
    description: 'Detalhe de um pedido de compra (pelo id ou número PDC-AAAA-NNNN): situação e próximas passagens possíveis, fornecedor, destino (OS, locação, turma), itens com quanto já foi recebido, total, parcelas a pagar e o orçamento da obra (se a pessoa vê).',
    inputSchema: obj({ pedidoId: int('Id do pedido'), numero: str('Número (PDC-2026-0001)') }),
    permissions: ['list_pedidos_de_compra'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const p = await purchaseOf(ctx, deps, input);
      return {
        ...purchaseLine(p), grupo: p.group, proximasSituacoes: (p.nextStatuses ?? []).map((s: string) => PURCHASE_LABEL[s] ?? s), motivo: p.statusNote ?? undefined, atrasado: p.late || undefined,
        destino: p.serviceOrder ? `OS ${p.serviceOrder.number}` : p.rental ? `Locação ${p.rental.number}` : p.courseClass ? `Turma ${p.courseClass.number}` : 'a própria empresa',
        itens: (p.items ?? []).map((i: any, index: number) => ({
          linha: index + 1, descricao: i.description, quantidade: i.quantity, unidade: i.unit, valorUnitario: money(i.unitPrice), total: money(i.total),
          itemId: i.itemId ?? undefined, recebido: i.itemId ? i.receivedQuantity ?? 0 : undefined,
        })),
        precisaAte: p.neededBy, previsaoEntrega: p.deliveryDate, compradoEm: p.purchasedAt, recebidoEm: p.receivedAt, notaFiscal: p.invoiceNumber ?? undefined,
        solicitadoPor: p.requestedBy, aprovadoPor: p.approvedBy ?? undefined,
        parcelas: (p.payables ?? []).map((x: any) => ({ valor: money(x.value), vencimento: x.dueDate, situacao: x.status })),
        orcamento: p.budget ? { grupo: p.budget.group, orcado: p.budget.budget, comprometidoOutros: p.budget.committed, sobraComEste: p.budget.remaining } : undefined,
        podeAprovar: p.canApprove,
      };
    },
  },
  {
    name: 'criar_pedido_de_compra',
    title: 'Criando o pedido de compra',
    description: 'Cria um pedido de compra na situação "Solicitado" (ainda precisa ser aprovado). Itens do estoque: mande itemId e quantidade (descrição e unidade vêm do cadastro; o valor, se faltar, é o último custo). Itens fora do estoque: descrição, quantidade e valor. Com daReposicao=true e sem itens, puxa os itens abaixo do mínimo (do fornecedor informado, se houver) com a quantidade sugerida. Destino opcional: OS, locação ou turma (um só).',
    inputSchema: obj({
      titulo: str('O que será comprado (ex.: "Reposição de EPIs")'),
      grupo: str('Grupo do gasto (padrão material)', { enum: PURCHASE_GROUPS }),
      fornecedorId: int('Fornecedor (Financeiro → fornecedores)'),
      itens: list('Itens', obj({ itemId: int('Item do estoque'), descricao: str('Descrição (item fora do estoque)'), quantidade: num('Quantidade'), unidade: str('Unidade'), valorUnitario: num('Valor unitário em reais') })),
      daReposicao: bool('Montar os itens a partir de itens_para_repor'),
      precisaAte: str('Precisa até (AAAA-MM-DD)'),
      osId: int('Ordem de serviço (obra) de destino'), locacaoId: int('Ordem de locação de destino'), turmaId: int('Turma de destino'),
      justificativa: str('Justificativa'),
    }),
    permissions: ['create_pedidos_de_compra'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const supplierId = positiveInt(input.fornecedorId);
      let raws: any[] = Array.isArray(input.itens) ? input.itens : [];
      if (!raws.length && input.daReposicao) {
        if (!has(ctx, 'list_itens_estoque')) throw new ToolRefusal('Montar pela reposição exige ver o estoque: mande os itens');
        const rows = await deps.api.call<any[]>(ctx, 'GET', 'stock/reorder');
        const pick = supplierId && rows.some((r) => r.lastSupplierId === supplierId) ? rows.filter((r) => r.lastSupplierId === supplierId) : rows;
        raws = pick.filter((r) => r.suggested > 0).map((r) => ({ itemId: r.id, quantidade: r.suggested, valorUnitario: r.lastCost ?? undefined }));
        if (!raws.length) throw new ToolRefusal('Nenhum item abaixo do mínimo para repor');
      }
      if (!raws.length) throw new ToolRefusal('Informe os itens (ou daReposicao=true)');
      const items: Record<string, unknown>[] = [];
      const noPrice: string[] = [];
      for (const raw of raws.slice(0, 100)) {
        const quantity = qty(raw.quantidade ?? 1);
        if (positiveInt(raw.itemId)) {
          const item = await itemOf(ctx, deps, raw.itemId);
          const price = raw.valorUnitario !== undefined && raw.valorUnitario !== null ? Number(raw.valorUnitario) : item.lastCost === null ? 0 : Number(item.lastCost);
          if (!(price > 0)) noPrice.push(item.name);
          items.push({ itemId: item.id, description: text(raw.descricao, 255) || item.name, unit: text(raw.unidade, 20) || item.unit, quantity, unitPrice: price });
        } else {
          items.push({ description: text(raw.descricao, 255), unit: text(raw.unidade, 20) || null, quantity, unitPrice: Number(raw.valorUnitario ?? 0) });
        }
      }
      if (noPrice.length && items.every((i) => !(Number(i.unitPrice) > 0))) throw new ToolRefusal(`Sem valor para: ${noPrice.join(', ')}. Informe o valor unitário (cotação) de cada item`);
      if (input.precisaAte && !isDate(input.precisaAte)) throw new ToolRefusal('precisaAte: use AAAA-MM-DD');
      const title = text(input.titulo, 200) || (input.daReposicao ? 'Reposição de estoque' : String(items[0].description).slice(0, 200));
      const body: Record<string, unknown> = { title, group: PURCHASE_GROUPS.includes(input.grupo) ? input.grupo : 'material', items };
      if (supplierId) body.supplierId = supplierId;
      if (input.precisaAte) body.neededBy = input.precisaAte;
      if (positiveInt(input.osId)) body.serviceOrderId = positiveInt(input.osId);
      if (positiveInt(input.locacaoId)) body.rentalId = positiveInt(input.locacaoId);
      if (positiveInt(input.turmaId)) body.classId = positiveInt(input.turmaId);
      if (text(input.justificativa)) body.justification = text(input.justificativa, 2000);
      const p = await deps.api.call<any>(ctx, 'POST', 'purchase-orders', { body });
      return {
        ...purchaseLine(p),
        itens: (p.items ?? []).map((i: any) => ({ descricao: i.description, quantidade: i.quantity, unidade: i.unit, valorUnitario: money(i.unitPrice), total: money(i.total), itemId: i.itemId ?? undefined })),
        aviso: [noPrice.length ? `Sem valor (ficou R$ 0,00): ${noPrice.join(', ')} — ajuste na tela antes de aprovar.` : '', 'O pedido nasceu "Solicitado": precisa ser aprovado (mudar_situacao_pedido_compra) por quem pode aprovar.'].filter(Boolean).join(' '),
      };
    },
  },
  {
    name: 'mudar_situacao_pedido_compra',
    title: 'Preparando a mudança do pedido',
    description: 'Passa o pedido de compra de etapa: aprovar ou recusar (de "Solicitado"; exige a permissão de aprovar), marcar como comprado (de "Aprovado"; precisa de fornecedor no pedido, número de parcelas e 1º vencimento: gera as contas a pagar), voltar para "Solicitado"/"Aprovado" ou cancelar. Recusar e cancelar exigem o motivo. Para dar entrada no estoque use receber_pedido_de_compra. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      pedidoId: int('Id do pedido'), numero: str('Ou o número (PDC-2026-0001)'),
      situacao: str('Nova situação', { enum: ['aprovado', 'recusado', 'comprado', 'solicitado', 'cancelado'] }),
      motivo: str('Motivo (obrigatório para recusar e cancelar) ou observação'),
      parcelas: int('Comprado: número de parcelas (1 a 60; padrão 1)'),
      primeiroVencimento: str('Comprado: vencimento da 1ª parcela (AAAA-MM-DD)'),
      formaPagamento: str('Comprado: forma de pagamento', { enum: PAY_METHODS }),
      dataCompra: str('Comprado: data da compra (AAAA-MM-DD; padrão hoje)'),
      previsaoEntrega: str('Comprado: previsão de entrega (AAAA-MM-DD)'),
    }, ['situacao']),
    permissions: ['list_pedidos_de_compra', 'update_pedidos_de_compra'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const p = await purchaseOf(ctx, deps, input);
      const target = String(input.situacao);
      if (!(target in PURCHASE_LABEL) || target === 'recebido') throw new ToolRefusal('Situação inválida (para receber, use receber_pedido_de_compra)');
      if (!(p.nextStatuses ?? []).includes(target)) {
        throw new ToolRefusal(`O pedido ${p.number} está "${p.statusLabel}": daqui só vai para ${(p.nextStatuses ?? []).map((s: string) => PURCHASE_LABEL[s]).join(', ') || 'nenhuma outra etapa'}`);
      }
      if (p.status === 'solicitado' && ['aprovado', 'recusado'].includes(target) && !p.canApprove) throw new ToolRefusal('Você não tem permissão para aprovar ou recusar pedidos de compra');
      const note = text(input.motivo, 500);
      if (['recusado', 'cancelado'].includes(target) && !note) throw new ToolRefusal(`Informe o motivo para ${target === 'recusado' ? 'recusar' : 'cancelar'}`);
      const body: Record<string, unknown> = { status: target, note: note || null };
      const details = [
        { label: 'Pedido', value: `${p.number} — ${p.title}` },
        { label: 'Fornecedor', value: p.supplier?.name ?? 'sem fornecedor' },
        { label: 'Total', value: brl(p.total) },
        { label: 'Etapa', value: `${p.statusLabel} → ${PURCHASE_LABEL[target]}` },
      ];
      if (target === 'comprado') {
        if (!p.supplier) throw new ToolRefusal('Escolha o fornecedor do pedido (na tela) antes de marcar como comprado');
        const count = input.parcelas === undefined ? 1 : Number(input.parcelas);
        if (!Number.isInteger(count) || count < 1 || count > 60) throw new ToolRefusal('Parcelas: de 1 a 60');
        if (!isDate(input.primeiroVencimento)) throw new ToolRefusal('Informe o vencimento da 1ª parcela (AAAA-MM-DD)');
        if (input.formaPagamento && !PAY_METHODS.includes(input.formaPagamento)) throw new ToolRefusal('Forma de pagamento inválida');
        if (input.dataCompra && (!isDate(input.dataCompra) || input.dataCompra > todayBr())) throw new ToolRefusal('Data da compra inválida ou no futuro');
        if (input.previsaoEntrega && !isDate(input.previsaoEntrega)) throw new ToolRefusal('Previsão de entrega: use AAAA-MM-DD');
        Object.assign(body, { installments: count, firstDueDate: input.primeiroVencimento, paymentMethod: input.formaPagamento ?? null, date: input.dataCompra ?? null, deliveryDate: input.previsaoEntrega ?? null });
        details.push({ label: 'Pagamento', value: `${count}x de ~${brl(Number(p.total) / count)}, 1º vencimento ${brDate(input.primeiroVencimento)}${input.formaPagamento ? ` (${input.formaPagamento})` : ''}: gera ${count} conta(s) a pagar` });
      }
      if (p.status === 'comprado' && ['aprovado', 'cancelado'].includes(target)) details.push({ label: 'Atenção', value: 'as contas a pagar da compra serão desfeitas (se alguma já foi paga, o sistema recusa)' });
      if ((p.items ?? []).some((i: any) => (i.receivedQuantity ?? 0) > 0) && ['aprovado', 'cancelado'].includes(target)) details.push({ label: 'Atenção', value: 'o que já entrou no estoque por este pedido será estornado' });
      if (note) details.push({ label: target === 'recusado' || target === 'cancelado' ? 'Motivo' : 'Observação', value: note });
      const verb: Record<string, string> = { aprovado: 'Aprovar', recusado: 'Recusar', comprado: 'Marcar como comprado', solicitado: 'Voltar para "Solicitado"', cancelado: 'Cancelar' };
      return { summary: `${verb[target]} o pedido ${p.number} (${brl(p.total)})?`, details, payload: { id: p.id, number: p.number, body } };
    },
    execute: async (ctx, payload, deps) => {
      const p = await deps.api.call<any>(ctx, 'PATCH', `purchase-orders/${payload.id}/status`, { body: payload.body });
      return { message: `Pedido ${p.number} agora está "${p.statusLabel}".`, link: L.purchase(p.id), data: { pedidoId: p.id, situacao: p.status, contasAPagar: (p.payables ?? []).length || undefined } };
    },
  },
  {
    name: 'receber_pedido_de_compra',
    title: 'Preparando o recebimento',
    description: 'Dá entrada no estoque do que chegou de um pedido COMPRADO. Sem itens, recebe tudo o que falta; com itens, só as linhas informadas (linha do pedido de ver_pedido_de_compra e quantidade). Item por lote exige o número do lote. Pedido de obra (OS) entra direto na obra; senão vai para o local informado (padrão: o primeiro local). Quando tudo chega, o pedido passa a "Recebido". Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      pedidoId: int('Id do pedido'), numero: str('Ou o número (PDC-2026-0001)'),
      localId: int('Local onde entra (pedido sem OS)'),
      itens: list('Só o que chegou (vazio = tudo o que falta)', obj({ linha: int('Linha do pedido (1, 2, ...)'), quantidade: num('Quantidade que chegou'), lote: str('Número do lote'), validade: str('Validade do lote (AAAA-MM-DD)') })),
      lotes: list('Recebendo tudo: lote de cada linha por lote', obj({ linha: int('Linha do pedido'), lote: str('Número do lote'), validade: str('Validade (AAAA-MM-DD)') })),
      notaFiscal: str('Número da nota fiscal'),
      data: str('Data do recebimento (AAAA-MM-DD; padrão hoje)'),
    }),
    permissions: ['list_pedidos_de_compra', 'update_pedidos_de_compra'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const p = await purchaseOf(ctx, deps, input);
      if (p.status !== 'comprado') throw new ToolRefusal(`O pedido ${p.number} está "${p.statusLabel}": só pedido comprado recebe itens${p.status === 'aprovado' ? ' (marque como comprado antes, com mudar_situacao_pedido_compra)' : ''}`);
      const date = input.data ? String(input.data) : todayBr();
      if (!isDate(date) || date > todayBr()) throw new ToolRefusal('Data do recebimento inválida ou no futuro');
      const items: any[] = p.items ?? [];
      const pending = items.map((item, index) => ({ item, index, left: qty(item.quantity - (item.receivedQuantity ?? 0)) })).filter((x) => x.item.itemId && x.left > 0);
      const details = [{ label: 'Pedido', value: `${p.number} — ${p.title}${p.supplier ? ` (${p.supplier.name})` : ''}` }];
      const invoice = text(input.notaFiscal, 60);
      if (invoice) details.push({ label: 'Nota fiscal', value: invoice });
      details.push({ label: 'Data', value: brDate(date) });

      // pedido sem item do estoque (serviço, frete...): só encerra
      if (!pending.length) {
        details.push({ label: 'Estoque', value: 'nada do estoque a receber: o pedido só passa a "Recebido"' });
        return { summary: `Marcar o pedido ${p.number} como recebido?`, details, payload: { id: p.id, mode: 'status', body: { status: 'recebido', date, ...(invoice ? { invoiceNumber: invoice } : {}) } } };
      }
      const trackingOf = new Map((await deps.prisma.stock_Item.findMany({ where: { id: { in: pending.map((x) => Number(x.item.itemId)) }, companyId: ctx.companyId }, select: { id: true, tracking: true } })).map((i) => [i.id, i.tracking]));
      const lotOfLine = new Map<number, any>((Array.isArray(input.lotes) ? input.lotes : []).map((l: any) => [Number(l.linha), l]));
      const chosen: Array<{ index: number; quantity: number; lot?: string; expires?: string }> = Array.isArray(input.itens) && input.itens.length
        ? input.itens.map((raw: any) => {
          const index = Number(raw.linha) - 1;
          const line = pending.find((x) => x.index === index);
          if (!line) throw new ToolRefusal(`Linha ${raw.linha}: não é item do estoque pendente neste pedido`);
          const quantity = qty(raw.quantidade ?? line.left);
          if (!(quantity > 0)) throw new ToolRefusal(`Linha ${raw.linha}: informe a quantidade`);
          if (quantity > line.left + 0.0005) throw new ToolRefusal(`Linha ${raw.linha} (${line.item.description}): chegou mais do que falta (${line.left})`);
          return { index, quantity, lot: text(raw.lote, 60) || undefined, expires: raw.validade };
        })
        : pending.map((x) => ({ index: x.index, quantity: x.left, lot: text(lotOfLine.get(x.index + 1)?.lote, 60) || undefined, expires: lotOfLine.get(x.index + 1)?.validade }));
      const lines = chosen.map((c) => {
        const item = items[c.index];
        if (trackingOf.get(Number(item.itemId)) === 'lote' && !c.lot) throw new ToolRefusal(`Linha ${c.index + 1} (${item.description}) é controlada por lote: informe o número do lote`);
        if (c.expires && !isDate(c.expires)) throw new ToolRefusal(`Linha ${c.index + 1}: validade AAAA-MM-DD`);
        return { index: c.index, quantity: c.quantity, ...(c.lot ? { lotNumber: c.lot } : {}), ...(c.expires ? { expiresAt: c.expires } : {}) };
      });
      let destination: string;
      let locationId: number | null = null;
      if (p.serviceOrder) destination = `direto na obra (OS ${p.serviceOrder.number})`;
      else if (input.localId) { const loc = await locationOf(ctx, deps, input.localId); locationId = loc.id; destination = loc.name; }
      else {
        const first = await deps.prisma.stock_Location.findFirst({ where: { companyId: ctx.companyId, inactiveAt: null }, orderBy: { id: 'asc' }, select: { name: true } });
        destination = first?.name ?? 'Almoxarifado';
      }
      details.push({ label: 'Entra em', value: destination });
      details.push({ label: 'Itens', value: lines.map((l) => `${l.quantity} ${items[l.index].unit ?? ''} ${items[l.index].description}${l.lotNumber ? ` (lote ${l.lotNumber})` : ''}`.replace(/\s+/g, ' ')).join('; ') });
      const all = lines.length === pending.length && lines.every((l) => Math.abs(l.quantity - pending.find((x) => x.index === l.index)!.left) < 0.0005);
      details.push({ label: 'Pedido', value: all ? 'tudo recebido: passa a "Recebido"' : 'recebimento parcial: continua "Comprado"' });
      return {
        summary: `Dar entrada no estoque de ${lines.length} linha(s) do pedido ${p.number}?`,
        details,
        payload: { id: p.id, mode: 'receive', body: { date, lines: lines.map((l) => ({ ...l, ...(locationId ? { locationId } : {}) })), ...(invoice ? { invoiceNumber: invoice } : {}) } },
      };
    },
    execute: async (ctx, payload, deps) => {
      const p = payload.mode === 'status'
        ? await deps.api.call<any>(ctx, 'PATCH', `purchase-orders/${payload.id}/status`, { body: payload.body })
        : await deps.api.call<any>(ctx, 'POST', `purchase-orders/${payload.id}/receive`, { body: payload.body });
      return { message: `Recebimento do pedido ${p.number} lançado: o pedido está "${p.statusLabel}".`, link: L.purchase(p.id), data: { pedidoId: p.id, situacao: p.status } };
    },
  },

  // ---------------------------------------------------------- EPI
  {
    name: 'epis_pendentes',
    title: 'Vendo os EPIs pendentes',
    description: 'Pendências de EPI: trocas vencidas ou próximas, CA vencido e desligados ainda com item. Com funcionarioId, mostra o que esse funcionário tem em mãos e o histórico de entregas.',
    inputSchema: obj({ funcionarioId: int('Só deste funcionário (ficha de EPI)') }),
    permissions: ['list_entregas_epi'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const employeeId = positiveInt(input.funcionarioId);
      if (employeeId) {
        const out = await deps.api.call<any>(ctx, 'GET', `stock/ppe/employees/${employeeId}`);
        return {
          funcionario: out.employee?.name, desligado: out.employee?.terminated || undefined,
          emMaos: (out.holding ?? []).map((h: any) => ({ item: h.item, itemId: h.itemId, quantidade: h.quantity, etiqueta: h.tag ?? undefined, ca: h.caNumber ?? undefined, situacaoCa: h.caState ?? undefined, entregueEm: h.deliveredAt, trocarEm: h.replaceAt ?? undefined })),
          ultimasEntregas: (out.history ?? []).slice(0, 10).map((m: any) => ({ numero: m.number, data: m.date, motivo: m.reasonLabel, itens: m.lines.map((l: any) => `${l.quantity} ${l.item}`).join(', '), assinado: m.signed, estornada: m.reversed || undefined })),
          link: L.ppe,
        };
      }
      const rows = await deps.api.call<any[]>(ctx, 'GET', 'stock/ppe/pending');
      return {
        total: rows.length,
        pendencias: rows.map((r) => ({ tipo: r.label, funcionarioId: r.employeeId, funcionario: r.employee, item: r.item, etiqueta: r.tag ?? undefined, quantidade: r.quantity, data: r.date ?? undefined })),
        link: L.ppe, aviso: rows.length ? undefined : 'Nenhuma pendência de EPI.',
      };
    },
  },
  {
    name: 'entregar_epi',
    title: 'Preparando a entrega de EPI',
    description: 'Registra a entrega de EPI a um funcionário, saindo de um local do estoque, com o motivo (admissão, troca, perda...). CA vencido e entrega repetida em 15 dias só avisam; desligado é recusado. A assinatura do funcionário não é colhida aqui (colha na ficha de EPI da tela). Item por peça: informe a etiqueta. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      funcionarioId: int('Id do funcionário (de listar_funcionarios)'),
      localId: int('Local de onde sai'),
      motivo: str('Motivo (padrão admissao)', { enum: Object.keys(PPE_REASONS) }),
      itens: list('EPIs entregues', obj({ itemId: int('Id do item'), quantidade: num('Quantidade'), lote: str('Lote (itens por lote)'), etiqueta: str('Etiqueta (itens por peça)') })),
      osId: int('Obra (OS) a que o custo vai, se for para uma obra'),
      data: str('Data (AAAA-MM-DD; padrão hoje)'),
      observacao: str('Observação'),
    }, ['funcionarioId', 'localId', 'itens']),
    permissions: ['create_entregas_epi'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const employee = await deps.prisma.hr_Employee.findFirst({ where: { id: positiveInt(input.funcionarioId) ?? 0, companyId: ctx.companyId }, select: { id: true, name: true, terminationDate: true, inactiveAt: true } });
      if (!employee) throw new ToolRefusal('Funcionário não encontrado (veja o id em listar_funcionarios)');
      if (employee.inactiveAt) throw new ToolRefusal(`${employee.name} está inativo`);
      if (employee.terminationDate && iso(employee.terminationDate)! <= todayBr()) throw new ToolRefusal(`${employee.name} está desligado: não recebe EPI`);
      const reason = input.motivo ? String(input.motivo) : 'admissao';
      if (!PPE_REASONS[reason]) throw new ToolRefusal('Motivo inválido');
      const date = input.data ? String(input.data) : todayBr();
      if (!isDate(date) || date > todayBr()) throw new ToolRefusal('Data inválida ou no futuro');
      const location = await locationOf(ctx, deps, input.localId);
      const { lines, shown } = await stockLines(ctx, deps, input.itens, location.id, 'out');
      const items = await deps.prisma.stock_Item.findMany({ where: { id: { in: lines.map((l) => Number(l.itemId)) } }, select: { name: true, isPpe: true, caNumber: true, caExpiry: true } });
      const warnings = [
        ...items.filter((i) => !i.isPpe).map((i) => `${i.name} não está marcado como EPI`),
        ...items.filter((i) => i.caExpiry && iso(i.caExpiry)! < date).map((i) => `CA ${i.caNumber ?? ''} de ${i.name} vencido`),
      ];
      let orderLabel: string | null = null;
      if (positiveInt(input.osId)) {
        const order = await deps.prisma.service_Order.findFirst({ where: { id: positiveInt(input.osId)!, companyId: ctx.companyId }, select: { id: true, number: true } });
        if (!order) throw new ToolRefusal('Ordem de serviço não encontrada');
        orderLabel = order.number;
      }
      const note = text(input.observacao, 1000);
      return {
        summary: `Entregar ${shown.length} EPI(s) a ${employee.name} (${PPE_REASONS[reason].toLowerCase()})?`,
        details: [
          { label: 'Funcionário', value: employee.name },
          { label: 'Sai de', value: location.name },
          { label: 'Itens', value: shown.join('; ') },
          { label: 'Motivo', value: PPE_REASONS[reason] },
          { label: 'Data', value: brDate(date) },
          ...(orderLabel ? [{ label: 'Custo na obra', value: orderLabel }] : []),
          ...(warnings.length ? [{ label: 'Atenção', value: warnings.join('; ') }] : []),
          { label: 'Assinatura', value: 'não colhida aqui: peça a assinatura na ficha de EPI' },
          ...(note ? [{ label: 'Observação', value: note }] : []),
        ],
        payload: { employeeName: employee.name, body: { employeeId: employee.id, locationId: location.id, reason, date, lines, ...(orderLabel ? { serviceOrderId: positiveInt(input.osId) } : {}), ...(note ? { note } : {}) } },
      };
    },
    execute: async (ctx, payload, deps) => {
      const out = await deps.api.call<any>(ctx, 'POST', 'stock/ppe/deliveries', { body: payload.body });
      const warnings: string[] = out.warnings ?? [];
      return {
        message: `Entrega ${out.number} registrada para ${payload.employeeName}.${warnings.length ? ` Avisos: ${warnings.join('; ')}.` : ''} Falta a assinatura na ficha de EPI.`,
        link: L.ppe, data: { movimentacaoId: out.movementId, numero: out.number },
      };
    },
  },

  // ---------------------------------------------------------- equipamentos
  {
    name: 'equipamentos_vencendo',
    title: 'Vendo os vencimentos',
    description: 'Vencimentos de equipamentos e materiais: inspeções e calibrações das peças, fim de vida útil, validade de lotes com saldo e CA de EPI. Vencidos primeiro. Padrão: o que vence em 30 dias (ou já venceu).',
    inputSchema: obj({ dias: int('Horizonte em dias (padrão 30, máx. 365)'), tipo: str('Só um tipo', { enum: ['inspecao', 'calibracao', 'vida_util', 'validade_lote', 'ca'] }) }),
    permissions: ['list_equipamentos'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const out = await deps.api.call<any>(ctx, 'GET', 'stock/dues', { query: { days: positiveInt(input.dias), type: input.tipo } });
      const rows: any[] = out.rows ?? [];
      return {
        vencidos: out.counts?.vencido ?? 0, aVencer: out.counts?.a_vencer ?? 0,
        itens: rows.slice(0, 60).map((r) => ({ tipo: r.label, situacao: r.state === 'vencido' ? 'vencido' : 'a vencer', data: r.date ?? 'sem data', oQue: r.target, onde: r.where || undefined, pecaId: r.unitId ?? undefined, itemId: r.itemId ?? undefined, link: r.unitId ? L.unit(r.unitId) : L.item(r.itemId) })),
        mais: rows.length > 60 ? rows.length - 60 : undefined, link: L.dues,
      };
    },
  },
  {
    name: 'registrar_inspecao',
    title: 'Preparando a inspeção',
    description: 'Registra a inspeção de uma peça (pela etiqueta) ou de um lote: tipo (periódica, pré-uso, extraordinária, recebimento), resultado (aprovado, aprovado com ressalva, reprovado) e o que foi visto (obrigatório se não aprovado). Se o item tem roteiro com perguntas obrigatórias, mande as respostas (chave → "ok"/"nok"/texto) ou tudoOk=true quando a pessoa disse que tudo estava OK; sem isso a ferramenta devolve as perguntas. Reprovado bloqueia a peça. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      etiqueta: str('Etiqueta da peça'), pecaId: int('Ou o id da peça'), lote: str('Ou o número do lote'), itemId: int('Item do lote (com lote)'),
      tipo: str('Tipo (padrão periodica)', { enum: Object.keys(INSPECTION_KINDS) }),
      resultado: str('Resultado', { enum: Object.keys(INSPECTION_RESULTS) }),
      observacoes: str('O que foi encontrado (obrigatório se não aprovado)'),
      respostas: { type: 'object', description: 'Respostas do roteiro: { chave: "ok" | "nok" | texto }', additionalProperties: true },
      tudoOk: bool('Marca "ok" em todas as perguntas ok/não ok do roteiro'),
      data: str('Data (AAAA-MM-DD; padrão hoje)'),
      proximaInspecao: str('Próxima inspeção (AAAA-MM-DD; padrão: pelo intervalo do item)'),
      inspetorFuncionarioId: int('Funcionário que inspecionou'),
    }, ['resultado']),
    permissions: ['inspecoes_equipamentos'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const kind = input.tipo ? String(input.tipo) : 'periodica';
      if (!INSPECTION_KINDS[kind]) throw new ToolRefusal('Tipo de inspeção inválido');
      const result = String(input.resultado ?? '');
      if (!INSPECTION_RESULTS[result]) throw new ToolRefusal('Informe o resultado: aprovado, aprovado_ressalva ou reprovado');
      const date = input.data ? String(input.data) : todayBr();
      if (!isDate(date) || date > todayBr()) throw new ToolRefusal('Data inválida ou no futuro');
      if (input.proximaInspecao && !isDate(input.proximaInspecao)) throw new ToolRefusal('Próxima inspeção: use AAAA-MM-DD');
      const notes = text(input.observacoes, 1000);
      if (result !== 'aprovado' && !notes) throw new ToolRefusal('Conte o que foi encontrado (observacoes)');

      let target: { unitId?: number; lotId?: number; label: string; templateId: number | null };
      if (input.etiqueta || input.pecaId) {
        const unit = await unitOf(ctx, deps, input);
        if (unit.status === 'baixado') throw new ToolRefusal(`A peça ${unit.tag} está baixada: não é inspecionada`);
        const item = await deps.prisma.stock_Item.findUnique({ where: { id: unit.itemId }, select: { name: true, inspectionTemplateId: true } });
        target = { unitId: unit.id, label: `${unit.tag} · ${item?.name ?? ''}`, templateId: item?.inspectionTemplateId ?? null };
      } else if (input.lote) {
        const lot = await deps.prisma.stock_Lot.findFirst({
          where: { companyId: ctx.companyId, number: text(input.lote, 60), ...(positiveInt(input.itemId) ? { itemId: positiveInt(input.itemId)! } : {}) },
          select: { id: true, number: true, item: { select: { name: true, inspectionTemplateId: true } } },
        });
        if (!lot) throw new ToolRefusal(`Lote ${input.lote} não encontrado${positiveInt(input.itemId) ? '' : ' (informe também o itemId)'}`);
        target = { lotId: lot.id, label: `Lote ${lot.number} · ${lot.item.name}`, templateId: lot.item.inspectionTemplateId };
      } else throw new ToolRefusal('Informe a etiqueta da peça ou o número do lote');

      const answers: Record<string, unknown> = input.respostas && typeof input.respostas === 'object' ? { ...input.respostas } : {};
      const template = target.templateId ? await deps.prisma.stock_InspectionTemplate.findFirst({ where: { id: target.templateId, companyId: ctx.companyId }, select: { name: true, items: true } }) : null;
      const questions = ((template?.items as any[]) ?? []);
      if (input.tudoOk === true) for (const q of questions) if (q.kind === 'ok_nok' && answers[q.key] === undefined) answers[q.key] = 'ok';
      const missing = questions.filter((q) => q.required && (answers[q.key] === undefined || answers[q.key] === null || answers[q.key] === ''));
      if (missing.length) {
        throw new ToolRefusal(`O roteiro "${template!.name}" pede respostas para: ${missing.map((q) => `${q.key} = ${q.label}${q.kind === 'ok_nok' ? ' (ok/nok)' : ''}`).join('; ')}. Pergunte à pessoa e mande em respostas (ou tudoOk=true se ela disse que estava tudo OK).`);
      }
      const nok = questions.filter((q) => q.kind === 'ok_nok' && answers[q.key] === 'nok');
      if (result === 'aprovado' && nok.length) throw new ToolRefusal(`Há item "não OK" (${nok.map((q) => q.label).join('; ')}): o resultado não pode ser "aprovado"`);
      let inspector: string | null = null;
      if (positiveInt(input.inspetorFuncionarioId)) {
        const row = await deps.prisma.hr_Employee.findFirst({ where: { id: positiveInt(input.inspetorFuncionarioId)!, companyId: ctx.companyId }, select: { name: true } });
        if (!row) throw new ToolRefusal('Inspetor não encontrado');
        inspector = row.name;
      }
      return {
        summary: `Registrar inspeção ${INSPECTION_KINDS[kind].toLowerCase()} de ${target.label}: ${INSPECTION_RESULTS[result].toLowerCase()}?`,
        details: [
          { label: 'Equipamento', value: target.label },
          { label: 'Inspeção', value: `${INSPECTION_KINDS[kind]} em ${brDate(date)}` },
          { label: 'Resultado', value: INSPECTION_RESULTS[result] + (result === 'reprovado' ? ' (a peça/lote fica bloqueado)' : '') },
          ...(questions.length ? [{ label: 'Roteiro', value: `${template!.name}: ${nok.length ? `${nok.length} item(ns) não OK` : 'todos os itens OK'}${input.tudoOk ? ' (marcados como OK a pedido)' : ''}` }] : []),
          ...(inspector ? [{ label: 'Inspetor', value: inspector }] : []),
          ...(input.proximaInspecao ? [{ label: 'Próxima', value: brDate(input.proximaInspecao) }] : []),
          ...(notes ? [{ label: 'Observações', value: notes }] : []),
        ],
        payload: {
          label: target.label,
          body: {
            ...(target.unitId ? { unitId: target.unitId } : { lotId: target.lotId }), kind, result, date, answers, notes: notes || null,
            ...(input.proximaInspecao ? { nextDueAt: input.proximaInspecao } : {}), ...(positiveInt(input.inspetorFuncionarioId) ? { inspectorEmployeeId: positiveInt(input.inspetorFuncionarioId) } : {}),
          },
        },
      };
    },
    execute: async (ctx, payload, deps) => {
      const out = await deps.api.call<any>(ctx, 'POST', 'stock/inspections', { body: payload.body });
      const unitId = payload.body.unitId as number | undefined;
      return {
        message: `Inspeção de ${payload.label} registrada: ${INSPECTION_RESULTS[out.result] ?? out.result}${out.nextDueAt ? `, próxima em ${brDate(out.nextDueAt)}` : ''}.`,
        link: unitId ? L.unit(unitId) : L.inspections, data: { inspecaoId: out.id, proxima: out.nextDueAt },
      };
    },
  },

  // ---------------------------------------------------------- locações
  {
    name: 'listar_locacoes',
    title: 'Consultando as locações',
    description: 'Ordens de locação (equipamento próprio alugado a clientes) por etapa: a entregar, ativa, a devolver, atrasada, devolvida, encerrada. Devolve cliente, período, devolução prevista, atraso, valor por período e o que falta faturar, mais o resumo por etapa.',
    inputSchema: obj({ etapa: str('Etapa', { enum: ['a_entregar', 'ativa', 'a_devolver', 'atrasada', 'devolvida', 'encerrada', 'cancelada'] }), busca: str('Número da OL ou nome do cliente') }),
    permissions: ['list_locacoes'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const out = await deps.api.call<any>(ctx, 'GET', 'stock/rentals', { query: { stage: input.etapa, search: text(input.busca, 80), limit: 40 } });
      return {
        resumo: out.summary,
        locacoes: (out.rows ?? []).map((r: any) => ({
          id: r.id, numero: r.number, cliente: r.customer, etapa: r.stageLabel, inicio: r.startDate, devolucaoPrevista: r.expectedEnd, devolvidaEm: r.returnedAt ?? undefined,
          atrasada: r.late || undefined, itens: r.summary, valorPorPeriodo: money(r.ratePerPeriod), faturado: money(r.billed), aFaturar: r.toBill || undefined, link: L.rental(r.id),
        })),
      };
    },
  },
  {
    name: 'ver_locacao',
    title: 'Abrindo a locação',
    description: 'Detalhe de uma ordem de locação: cliente, etapa, datas (início, devolução prevista, entregue, devolvida), itens com quanto foi entregue e devolvido, cobranças/medições, caução e próximos lembretes.',
    inputSchema: obj({ locacaoId: int('Id da OL (de listar_locacoes)') }, ['locacaoId']),
    permissions: ['list_locacoes'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.locacaoId);
      if (!id) throw new ToolRefusal('Informe o id da locação');
      const r = await deps.api.call<any>(ctx, 'GET', `stock/rentals/${id}`);
      return {
        id: r.id, numero: r.number, cliente: r.customer?.name, etapa: r.stageLabel, atrasada: r.late || undefined, contrato: r.contract?.number ?? undefined, os: r.serviceOrder?.number ?? undefined,
        inicio: r.startDate, devolucaoPrevista: r.expectedEnd, entregueEm: r.deliveredAt, devolvidaEm: r.returnedAt, periodo: r.periodLabel, enderecoEntrega: r.deliveryAddress ?? undefined,
        itens: (r.lines ?? []).map((l: any) => ({ item: l.item, etiqueta: l.tag ?? undefined, quantidade: l.quantity, entregue: l.deliveredQuantity, devolvido: l.returnedQuantity, valorPorPeriodo: money(l.rate), estado: l.condition ?? undefined })),
        valorPorPeriodo: money(r.ratePerPeriod), proximoPeriodo: r.nextPeriod ?? undefined, aMedir: r.fromContract ? money(r.pendingValue) : undefined,
        cobrancas: (r.charges ?? []).map((c: any) => ({ tipo: c.kindLabel, de: c.periodStart, ate: c.periodEnd, valor: money(c.value), situacao: c.recordStatus ?? undefined })),
        medicoes: (r.measurements ?? []).map((m: any) => ({ bm: m.label, de: m.periodStart, ate: m.periodEnd, valor: money(m.value), situacao: m.recordStatus ?? undefined })),
        caucao: r.deposit === null ? undefined : money(r.deposit),
        lembretes: (r.reminders ?? []).map((x: any) => ({ assunto: x.subject, data: x.dueDate })),
        link: L.rental(r.id),
      };
    },
  },
];
