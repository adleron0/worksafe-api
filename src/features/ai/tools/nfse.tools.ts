import { brl, positiveInt, text } from './actors';
import { ToolContext, ToolDefinition, ToolRefusal } from './tool.types';
import type { ToolDeps } from './tool.deps';

/**
 * Notas fiscais de serviço (NFS-e Nacional) pelo assistente: consultar, ver o
 * que falta notar, simular, preparar rascunho e — com confirmação no cartão —
 * emitir, cancelar e reenviar. As ferramentas chamam as rotas da área fiscal
 * (as mesmas da tela), com as permissões da pessoa. Emitir nota nunca sai
 * sozinho: nem no modo automático.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const num = (description: string) => ({ type: 'number', description });
const ids = (description: string) => ({ type: 'array', items: { type: 'integer' }, description });

const VIEW = ['view_nfse'];
const EMIT = ['emitir_nfse'];
const CANCEL = ['cancelar_nfse'];
const STATUS = ['rascunho', 'emitindo', 'autorizada', 'rejeitada', 'cancelada', 'substituida'];
const api = (deps: ToolDeps) => deps.api;
const link = (id: number) => `/financeiro/notas/${id}`;

/** O que a nota cobre: uma origem do sistema (parcela, boletim, OL, contrato, inscrições) ou avulsa. */
const NOTE_INPUT = {
  origem: str('De onde a nota nasce: parcela, boletim (medição de obra), locacao (OL do contrato), contrato (inteiro, saldo ou valor livre), inscricoes (turma aberta paga) ou avulsa', { enum: ['parcela', 'boletim', 'locacao', 'contrato', 'inscricoes', 'avulsa'] }),
  contratoId: int('Contrato (parcela, boletim, locação ou contrato)'),
  parcelaIds: ids('Parcelas do contrato (origem parcela)'),
  boletimId: int('Boletim de medição de obra (origem boletim)'),
  olId: int('Ordem de locação do contrato (origem locacao)'),
  modo: str('Nota do contrato: total, saldo ou livre', { enum: ['total', 'saldo', 'livre'] }),
  inscricaoIds: ids('Inscrições pagas de turma aberta (origem inscricoes): uma pessoa física ou várias da mesma empresa'),
  clienteId: int('Cliente tomador (avulsa)'),
  empresaId: int('CNPJ do grupo que emite (empresas_do_grupo). Vazio = o da origem (contrato, turma) ou o padrão'),
  servicoFiscalId: int('Serviço fiscal (avulsa; nas outras origens vem sugerido)'),
  valor: num('Valor do serviço (avulsa ou contrato em valor livre)'),
  descricao: str('Discriminação do serviço (opcional: vem sugerida)'),
  competencia: str('Competência (AAAA-MM-DD; padrão hoje)'),
  vencimento: str('Vencimento da conta a receber (AAAA-MM-DD; vazio = regra da origem; na avulsa, padrão 30 dias)'),
  issRetido: { type: 'boolean', description: 'ISS retido pelo cliente (avulsa)' },
  retencoes: obj({ inss: num('INSS %'), ir: num('IR %'), csll: num('CSLL %'), pis: num('PIS %'), cofins: num('COFINS %') }),
};

/** Corpo da nota a partir da entrada do assistente (origem sugerida pela API, ou avulsa). */
async function noteBody(ctx: ToolContext, input: Record<string, any>, deps: ToolDeps): Promise<Record<string, unknown>> {
  const origem = String(input.origem ?? 'avulsa');
  const query: Record<string, unknown> | null =
    origem === 'parcela' ? { kind: 'installments', contractId: input.contratoId, installmentIds: (input.parcelaIds ?? []).join(',') }
      : origem === 'boletim' ? { kind: 'measurement', contractId: input.contratoId, measurementId: input.boletimId }
        : origem === 'locacao' ? { kind: 'rental', contractId: input.contratoId, rentalId: input.olId }
          : origem === 'contrato' ? { kind: 'contract', contractId: input.contratoId, mode: input.modo ?? 'saldo' }
            : origem === 'inscricoes' ? { kind: 'subscriptions', subscriptionIds: (input.inscricaoIds ?? []).join(',') }
              : null;
  const retentions = input.retencoes ? Object.fromEntries(Object.entries(input.retencoes).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, { rate: v }])) : undefined;
  if (query) {
    if (origem !== 'inscricoes' && !positiveInt(input.contratoId)) throw new ToolRefusal('Informe o contrato');
    const suggested = (await api(deps).call(ctx, 'GET', 'fiscal/invoices/from-origin', { query })) as Record<string, any>;
    return {
      ...suggested,
      ...(positiveInt(input.empresaId) ? { entityId: Number(input.empresaId) } : {}),
      ...(input.descricao ? { description: text(input.descricao, 2000) } : {}),
      ...(input.competencia ? { competence: input.competencia } : {}),
      ...(origem === 'contrato' && input.modo === 'livre' && input.valor ? { grossValue: Number(input.valor), origin: { ...suggested.origin, mode: 'livre' } } : {}),
      ...(input.vencimento ? { receivable: { dueDate: input.vencimento } } : {}),
      ...(retentions ? { retentions } : {}),
    };
  }
  if (!positiveInt(input.clienteId)) throw new ToolRefusal('Na nota avulsa, informe o cliente (buscar_clientes)');
  if (!(Number(input.valor) > 0)) throw new ToolRefusal('Informe o valor do serviço');
  // sem serviço informado, vale o serviço fiscal padrão da empresa
  let serviceCodeId = positiveInt(input.servicoFiscalId);
  if (!serviceCodeId) {
    const services = (await api(deps).call(ctx, 'GET', 'fiscal/service-codes', { query: positiveInt(input.empresaId) ? { entityId: input.empresaId } : {} })) as Array<{ id: number; isDefault: boolean; entityId: number | null }>;
    // o padrão do próprio CNPJ vale mais que o padrão de "todos"
    serviceCodeId = (services.find((sv) => sv.isDefault && sv.entityId) ?? services.find((sv) => sv.isDefault) ?? services[0])?.id ?? null;
    if (!serviceCodeId) throw new ToolRefusal('Nenhum serviço fiscal cadastrado: cadastre em Fiscal → Configuração');
  }
  return {
    takerKind: 'cliente', customerId: Number(input.clienteId), serviceCodeId,
    ...(positiveInt(input.empresaId) ? { entityId: Number(input.empresaId) } : {}),
    grossValue: Number(input.valor), description: input.descricao ? text(input.descricao, 2000) : '', competence: input.competencia,
    issWithheld: !!input.issRetido, retentions: retentions ?? {},
    receivable: { create: true, dueDate: input.vencimento || new Date(Date.now() + 27 * 86400000).toISOString().slice(0, 10) },
  };
}

/** Resumo legível da prévia (cartão e resposta ao modelo). */
function previewLines(preview: any): { label: string; value: string }[] {
  const c = preview.calc ?? {};
  const out = [
    ...(preview.emitter?.tradeName ? [{ label: 'Emitente', value: `${preview.emitter.tradeName} (${preview.emitter.cnpj})` }] : []),
    { label: 'Tomador', value: `${preview.taker?.name ?? '—'} (${preview.taker?.document ?? 'sem documento'})` },
    { label: 'Valor', value: brl(c.gross ?? 0) },
  ];
  if (c.issWithheld && c.issValue) out.push({ label: 'ISS retido', value: brl(c.issValue) });
  for (const [tax, line] of Object.entries(c.federal ?? {}) as Array<[string, any]>) if (line?.value > 0) out.push({ label: `${tax.toUpperCase()} retido`, value: brl(line.value) });
  out.push({ label: 'Líquido', value: brl(c.net ?? 0) });
  out.push({ label: 'Competência', value: String(preview.competence ?? '').split('-').reverse().join('/') });
  if (preview.origin?.label) out.push({ label: 'Origem', value: preview.origin.label });
  out.push({ label: 'Ambiente', value: preview.environment === 'producao' ? 'Produção (vale de verdade)' : 'Testes (sem valor fiscal)' });
  return out;
}

const slimInvoice = (inv: any) => ({
  emitente: inv.entity?.tradeName ?? null,
  id: inv.id, numero: inv.number, situacao: inv.status, ambiente: inv.environment, emitidaFora: inv.provider === 'externa',
  tomador: inv.taker?.name, documento: inv.taker?.document, servico: inv.service?.name, competencia: inv.competence,
  valor: inv.grossValue, liquido: inv.netValue, emitidaEm: inv.issuedAt, origem: inv.origin?.label ?? null, link: link(inv.id),
});

export const NFSE_TOOLS: ToolDefinition[] = [
  {
    name: 'notas_fiscais',
    title: 'Consultando notas fiscais',
    description: 'Lista as notas fiscais de serviço (NFS-e): número, situação (rascunho, enviando, autorizada, rejeitada, cancelada, substituída), tomador, valor, líquido e competência, com os totais das autorizadas.',
    inputSchema: obj({
      situacao: str('Situação', { enum: STATUS }), busca: str('Tomador, CPF/CNPJ, número ou descrição'),
      competenciaDe: str('Competência a partir de (AAAA-MM-DD)'), competenciaAte: str('Competência até (AAAA-MM-DD)'), clienteId: int('Cliente'),
      empresaId: int('Só as notas deste CNPJ do grupo (empresas_do_grupo)'),
    }),
    permissions: VIEW, risk: 'read',
    run: async (ctx, input, deps) => {
      const res = (await api(deps).call(ctx, 'GET', 'fiscal/invoices', { query: { status: input.situacao, q: input.busca, from: input.competenciaDe, to: input.competenciaAte, customerId: input.clienteId, entityId: input.empresaId, limit: 30 } })) as any;
      return { total: res.total, resumo: res.summary, notas: (res.data ?? []).map(slimInvoice) };
    },
  },
  {
    name: 'ver_nota_fiscal',
    title: 'Abrindo a nota fiscal',
    description: 'Detalhe de uma nota fiscal: tomador, serviço, valores e retenções, chave de acesso, mensagens de rejeição, contas a receber ligadas e o histórico.',
    inputSchema: obj({ id: int('Id da nota') }, ['id']),
    permissions: VIEW, risk: 'read',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.id);
      if (!id) throw new ToolRefusal('Informe a nota');
      const inv = (await api(deps).call(ctx, 'GET', `fiscal/invoices/${id}`)) as any;
      return {
        ...slimInvoice(inv), descricao: inv.description, issRetido: inv.issWithheld, iss: inv.issValue, retencoesFederais: inv.federalRetentions,
        chave: inv.accessKey, mensagens: inv.messages, motivoCancelamento: inv.cancelReason,
        contasAReceber: (inv.receivables ?? []).map((r: any) => ({ id: r.id, valor: r.netValue ?? r.value, situacao: r.status, vencimento: r.dueDate })),
        historico: (inv.events ?? []).map((e: any) => ({ quando: e.createdAt, o_que: e.kind })),
      };
    },
  },
  {
    name: 'notas_a_emitir',
    title: 'Vendo as notas a emitir',
    description: 'O que está pronto para ter nota fiscal: inscrições pagas de turma aberta sem nota e parcelas/boletins liberados no A faturar ainda sem nota. Use antes de sugerir emissões.',
    inputSchema: obj({}),
    permissions: VIEW, risk: 'read',
    run: async (ctx, _input, deps) => {
      const training = (await api(deps).call(ctx, 'GET', 'fiscal/training/pending')) as any[];
      let billing: unknown[] | string = 'sem permissão para ver o A faturar';
      if (ctx.permissions.includes('list_financeiro')) {
        try {
          const queue = (await api(deps).call(ctx, 'GET', 'commercial/contracts/billing')) as any;
          const rows = ((queue?.rows ?? []) as any[]).filter((r) => r.stage === 'liberada' && !r.record);
          billing = rows.slice(0, 40).map((r) => ({
            contrato: r.contractNumber, cliente: r.customer?.name ?? null, valor: r.value, vencimentoSugerido: r.suggestedDue ?? null,
            oQue: r.source === 'parcela' ? `parcela ${r.number}/${r.total}${r.description ? ` · ${r.description}` : ''}` : r.description,
            // como pedir a nota desta linha nas ferramentas de nota
            comoEmitir: r.source === 'parcela' ? { origem: 'parcela', contratoId: r.contractId, parcelaIds: [r.id] }
              : r.source === 'obra' ? { origem: 'boletim', contratoId: r.contractId, boletimId: r.measurementId }
                : r.rental?.id ? { origem: 'locacao', contratoId: r.contractId, olId: r.rental.id } : null,
          }));
        } catch {
          billing = 'não consegui ler o A faturar agora';
        }
      }
      return {
        inscricoesPagasSemNota: training.filter((t) => !t.invoice).map((t) => ({ inscricaoId: t.subscriptionId, aluno: t.name, empresa: t.customer?.name ?? null, turma: [t.courseName, t.className].filter(Boolean).join(' · '), valor: t.value, pagoEm: t.paidAt })),
        rascunhosDeInscricao: training.filter((t) => t.invoice).map((t) => ({ inscricaoId: t.subscriptionId, aluno: t.name, notaId: t.invoice.id, situacao: t.invoice.status })),
        aFaturarSemNota: billing,
        dica: 'Parcela: origem parcela com contratoId e parcelaIds. Boletim: origem boletim. Inscrições da mesma empresa vão numa nota só.',
      };
    },
  },
  {
    name: 'saldo_notas_contrato',
    title: 'Vendo as notas do contrato',
    description: 'Notas fiscais de um contrato e o saldo a notar (valor do contrato menos as notas autorizadas), com as notas do contrato que ainda têm saldo para cobrar parcelas.',
    inputSchema: obj({ contratoId: int('Contrato') }, ['contratoId']),
    permissions: VIEW, risk: 'read',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.contratoId);
      if (!id) throw new ToolRefusal('Informe o contrato');
      return api(deps).call(ctx, 'GET', `fiscal/contracts/${id}/summary`);
    },
  },
  {
    name: 'simular_nota_fiscal',
    title: 'Simulando a nota fiscal',
    description: 'Mostra como a nota sairia, sem gravar nada: tomador, valor, retenções, líquido, discriminação, o que impede emitir (erros) e avisos. Serve para parcela, boletim, locação, contrato, inscrições ou nota avulsa.',
    inputSchema: obj(NOTE_INPUT, ['origem']),
    permissions: VIEW, risk: 'read',
    run: async (ctx, input, deps) => {
      const body = await noteBody(ctx, input, deps);
      const preview = (await api(deps).call(ctx, 'POST', 'fiscal/invoices/preview', { body })) as any;
      return { podeEmitir: preview.canEmit, resumo: previewLines(preview), descricao: preview.description, erros: preview.errors, avisos: preview.warnings };
    },
  },
  {
    name: 'rascunho_nota_fiscal',
    title: 'Preparando o rascunho da nota',
    description: 'Cria a nota fiscal como RASCUNHO (não emite) para a pessoa revisar na tela. Bom para preparar as notas do mês. Mesma entrada da simulação.',
    inputSchema: obj(NOTE_INPUT, ['origem']),
    permissions: EMIT, risk: 'draft',
    run: async (ctx, input, deps) => {
      const body = await noteBody(ctx, input, deps);
      const inv = (await api(deps).call(ctx, 'POST', 'fiscal/invoices', { body })) as any;
      return { ...slimInvoice(inv), mensagem: 'Rascunho criado. A pessoa revisa e emite na tela (ou peça emitir_nota_fiscal com o rascunhoId).' };
    },
  },
  {
    name: 'emitir_nota_fiscal',
    title: 'Preparando a emissão da nota',
    description: 'Prepara a emissão de uma NFS-e (de uma origem, avulsa ou de um rascunho já criado). O cartão mostra tomador, valor, retenções, líquido e o ambiente; a nota só é emitida quando a pessoa confirma. Erros de cadastro aparecem antes, sem cartão.',
    inputSchema: obj({ rascunhoId: int('Rascunho ou nota rejeitada já existente (em vez da origem)'), ...NOTE_INPUT }),
    permissions: EMIT, risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const draftId = positiveInt(input.rascunhoId);
      if (draftId) {
        const inv = (await api(deps).call(ctx, 'GET', `fiscal/invoices/${draftId}`)) as any;
        if (!['rascunho', 'rejeitada'].includes(inv.status)) throw new ToolRefusal(`A nota ${draftId} está ${inv.status}: só rascunho ou rejeitada pode ser emitida`);
        return {
          summary: `Emitir a NFS-e de ${inv.taker?.name ?? 'tomador'} no valor de ${brl(inv.grossValue)}?`,
          details: [
            { label: 'Tomador', value: `${inv.taker?.name} (${inv.taker?.document})` }, { label: 'Valor', value: brl(inv.grossValue) },
            { label: 'Líquido', value: brl(inv.netValue) }, { label: 'Serviço', value: inv.service?.name ?? inv.service?.nationalCode ?? '—' },
            { label: 'Ambiente', value: inv.environment === 'producao' ? 'Produção (vale de verdade)' : 'Testes (sem valor fiscal)' },
          ],
          payload: { draftId },
        };
      }
      if (!input.origem) throw new ToolRefusal('Informe a origem da nota ou o rascunhoId');
      const body = await noteBody(ctx, input, deps);
      const preview = (await api(deps).call(ctx, 'POST', 'fiscal/invoices/preview', { body })) as any;
      if (!preview.canEmit) throw new ToolRefusal(`Ainda não dá para emitir: ${preview.errors.join(' ')}`);
      const details = previewLines(preview);
      if (preview.warnings?.length) details.push({ label: 'Avisos', value: preview.warnings.join(' ') });
      // nunca automático: emitir nota fiscal sempre passa pela confirmação humana
      return { summary: `Emitir a NFS-e de ${preview.taker?.name} no valor de ${brl(preview.calc?.gross ?? 0)}?`, details, payload: { body: { ...body, description: preview.description } }, auto: false };
    },
    execute: async (ctx, payload, deps) => {
      const inv = (payload.draftId
        ? await api(deps).call(ctx, 'POST', `fiscal/invoices/${payload.draftId}/emit`)
        : await api(deps).call(ctx, 'POST', 'fiscal/invoices', { body: { ...payload.body, emit: true } })) as any;
      const ok = inv.status === 'autorizada';
      return {
        message: ok ? `NFS-e nº ${inv.number} autorizada${inv.environment === 'restrita' ? ' (ambiente de testes)' : ''}.` : inv.status === 'rejeitada' ? `A nota foi rejeitada: ${(inv.messages ?? []).map((m: any) => m.message).join(' ')}` : 'Nota enviada, sem resposta ainda: confira na ficha.',
        link: link(inv.id), data: slimInvoice(inv),
      };
    },
  },
  {
    name: 'cancelar_nota_fiscal',
    title: 'Preparando o cancelamento da nota',
    description: 'Prepara o cancelamento de uma NFS-e autorizada (com motivo). O cartão diz o que acontece com a cobrança (parcela volta para a faturar; inscrição paga continua paga). Só cancela quando a pessoa confirma. Nota com conta já recebida não cancela: substitua.',
    inputSchema: obj({ id: int('Id da nota'), motivo: str('Motivo (pelo menos 15 letras)'), codigo: str('1 erro na emissão, 2 serviço não prestado, 9 outros', { enum: ['1', '2', '9'] }) }, ['id', 'motivo']),
    permissions: CANCEL, risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const id = positiveInt(input.id);
      if (!id) throw new ToolRefusal('Informe a nota');
      const reason = text(input.motivo, 255);
      if (reason.length < 15) throw new ToolRefusal('Explique o motivo do cancelamento (pelo menos 15 letras)');
      const inv = (await api(deps).call(ctx, 'GET', `fiscal/invoices/${id}`)) as any;
      if (inv.status !== 'autorizada') throw new ToolRefusal(`A nota está ${inv.status}: só nota autorizada pode ser cancelada`);
      const kind = inv.origin?.kind;
      const effect = kind === 'installments' || kind === 'measurement' || kind === 'rental' ? 'o faturamento é desfeito (volta para a faturar)'
        : kind === 'subscriptions' ? 'o pagamento da inscrição continua; só a nota sai dele'
          : (inv.receivables ?? []).length ? 'a conta a receber em aberto é cancelada' : 'não há cobrança ligada';
      return {
        summary: `Cancelar a NFS-e nº ${inv.number} de ${inv.taker?.name} (${brl(inv.grossValue)})? Não dá para desfazer; ${effect}.`,
        details: [{ label: 'Motivo', value: reason }, { label: 'Efeito', value: effect }, { label: 'Ambiente', value: inv.environment === 'producao' ? 'Produção' : 'Testes' }],
        payload: { id, reason, reasonCode: Number(input.codigo ?? 9) },
      };
    },
    execute: async (ctx, payload, deps) => {
      const inv = (await api(deps).call(ctx, 'POST', `fiscal/invoices/${payload.id}/cancel`, { body: { reason: payload.reason, reasonCode: payload.reasonCode } })) as any;
      return { message: `NFS-e nº ${inv.number} cancelada.`, link: link(inv.id) };
    },
  },
  {
    name: 'rascunho_substituicao_nota',
    title: 'Preparando a nota substituta',
    description: 'Cria o rascunho da nota que vai SUBSTITUIR uma nota autorizada (para corrigir dados quando a conta já foi recebida). A pessoa corrige e emite na tela; ao emitir, a nota antiga fica substituída.',
    inputSchema: obj({ id: int('Id da nota autorizada') }, ['id']),
    permissions: [...CANCEL, ...EMIT], risk: 'draft',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.id);
      if (!id) throw new ToolRefusal('Informe a nota');
      const draft = (await api(deps).call(ctx, 'POST', `fiscal/invoices/${id}/replace`)) as any;
      return { ...slimInvoice(draft), mensagem: 'Rascunho da substituta criado: corrija na tela e emita.' };
    },
  },
  {
    name: 'reenviar_nota_fiscal',
    title: 'Preparando o envio da nota',
    description: 'Prepara o envio do PDF e do XML de uma nota autorizada por e-mail (ao contato fiscal do tomador ou ao e-mail informado). Só envia quando a pessoa confirma.',
    inputSchema: obj({ id: int('Id da nota'), para: str('E-mail(s) separados por vírgula (vazio = contato fiscal da nota)') }, ['id']),
    permissions: EMIT, risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const id = positiveInt(input.id);
      if (!id) throw new ToolRefusal('Informe a nota');
      const inv = (await api(deps).call(ctx, 'GET', `fiscal/invoices/${id}`)) as any;
      if (inv.status !== 'autorizada') throw new ToolRefusal('Só nota autorizada pode ser enviada');
      const to = text(input.para, 500) || inv.taker?.email;
      if (!to) throw new ToolRefusal('O tomador não tem e-mail: informe para quem enviar');
      return { summary: `Enviar a NFS-e nº ${inv.number} para ${to}?`, details: [{ label: 'Tomador', value: inv.taker?.name ?? '—' }, { label: 'Anexos', value: 'PDF (DANFSe) e XML' }], payload: { id, to } };
    },
    execute: async (ctx, payload, deps) => {
      await api(deps).call(ctx, 'POST', `fiscal/invoices/${payload.id}/send`, { body: { to: payload.to } });
      return { message: `Nota enviada para ${payload.to}.`, link: link(payload.id) };
    },
  },
];
