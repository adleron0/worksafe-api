import { asRefusal, brl, isDate, money, orderActor, positiveInt, text, todayBr } from './actors';
import type { ToolDeps } from './tool.deps';
import { ToolContext, ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Obras: o caminho da proposta aceita até o faturamento, para o Bruno
 * (Operação) e, nas leituras de dinheiro, para o Financeiro e o Comercial.
 *
 * A OS nasce sozinha no aceite da proposta de serviço ("A liberar" sem o
 * pedido do cliente, "A mobilizar" com ele): não há rota para "abrir OS". Por
 * isso aqui ficam a consulta da OS da proposta e o registro do pedido do
 * cliente, que é o que libera a OS. Avanço físico, parcelas "ao atingir X% da
 * obra", caução, A faturar e boletim de medição vêm das rotas da tela
 * (`deps.api.call`), com as permissões delas; o diário vem do mesmo serviço
 * da tela de Estatísticas do Diário.
 *
 * Já existem e não se repetem: listar_os, ver_os, resultado_obras,
 * quem_esta_livre, escalar_equipe_os, mover_os (read/write.tools) e
 * listar_rdos, ver_rdo, rdos_pendentes, resumo_diario_de_obra, devolver_rdo,
 * cobrar_rdo (rdo.tools).
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const num = (description: string) => ({ type: 'number', description });

const has = (ctx: ToolContext, permission: string) => ctx.permissions.includes(permission);
const br = (value: string | null | undefined) => (value ? value.split('-').reverse().join('/') : '');
const pct = (value: number | null | undefined) => (value === null || value === undefined ? null : `${String(Math.round(value * 100) / 100).replace('.', ',')}%`);

const L = {
  order: (id: number) => `/servicos/ordens-de-servico/${id}`,
  contract: (id: number) => `/comercial/contratos/${id}`,
  proposal: (id: number) => `/comercial/propostas/${id}`,
  billing: '/financeiro/faturar',
  stats: '/servicos/estatisticas-do-diario',
};

const ORDER_LABEL: Record<string, string> = {
  a_liberar: 'A liberar', a_mobilizar: 'A mobilizar', agendada: 'Agendada', em_execucao: 'Em execução', concluida: 'Concluída', encerrada: 'Encerrada', cancelada: 'Cancelada',
};
const KIND_LABEL: Record<string, string> = { servico: 'serviço', treinamento: 'treinamento', locacao: 'locação' };
const DUE_RULE: Record<string, string> = {
  data_fixa: 'data fixa', dias_apos_aceite: 'dias após o aceite', dias_apos_nf: 'dias após a nota', dias_apos_conclusao: 'dias após a conclusão', percentual_obra: '% da obra',
};
const WEATHER: Record<string, string> = { bom: 'bom', nublado: 'nublado', chuva: 'chuva', impraticavel: 'impraticável', sem_registro: 'sem registro' };
const CONDITION: Record<string, string> = { normal: 'normal', restricao: 'com restrição', impedido: 'impedida', sem_registro: 'sem registro' };
const OCCURRENCE: Record<string, string> = { paralisacao: 'paralisação', pendencia_cliente: 'pendência do cliente', quase_acidente: 'quase acidente', acidente: 'acidente', outro: 'outro' };
const BILLING_STAGES = ['aguardando', 'liberada', 'faturada', 'recebida'];
const MEASUREMENT_STATUS: Record<string, string> = { rascunho: 'rascunho', enviada: 'enviado ao cliente', aprovada: 'aprovado', contestada: 'contestado', faturada: 'faturado' };

/** Só as contagens que aconteceram, com rótulo. */
const tallied = (counts: Record<string, number> | undefined, labels: Record<string, string>) =>
  Object.fromEntries(Object.entries(counts ?? {}).filter(([, n]) => n > 0).map(([key, n]) => [labels[key] ?? key, n]));

// ------------------------------------------------------------------ busca de ids

/** OS da empresa pelo id ou pelo número (OS-2026-0001). A visibilidade ("só as minhas") é conferida pelo serviço depois. */
async function orderOf(ctx: ToolContext, deps: ToolDeps, input: Record<string, any>) {
  const id = positiveInt(input.osId);
  const number = text(input.numeroOs, 30).toUpperCase();
  if (!id && !number) return null;
  const row = await deps.prisma.service_Order.findFirst({
    where: { companyId: ctx.companyId, ...(id ? { id } : { number }) }, select: { id: true, number: true, contractId: true, status: true },
  });
  if (!row) throw new ToolRefusal('OS não encontrada (veja o id em listar_os)');
  return row;
}

/** Contrato (venda fechada) pela OS, pelo id do contrato ou pela proposta (id ou número). */
async function contractOf(ctx: ToolContext, deps: ToolDeps, input: Record<string, any>) {
  const order = await orderOf(ctx, deps, input);
  let id = order?.contractId ?? positiveInt(input.contratoId);
  if (!id) {
    const proposalId = positiveInt(input.propostaId);
    const number = text(input.numeroProposta, 30).toUpperCase();
    if (!proposalId && !number) throw new ToolRefusal('Diga de qual obra: osId, contratoId ou a proposta (propostaId ou numeroProposta)');
    const proposal = await deps.prisma.commercial_Proposal.findFirst({ where: { companyId: ctx.companyId, ...(proposalId ? { id: proposalId } : { number }) }, select: { id: true, number: true, status: true } });
    if (!proposal) throw new ToolRefusal('Proposta não encontrada (veja em listar_propostas)');
    const contract = await deps.prisma.commercial_Contract.findFirst({ where: { companyId: ctx.companyId, proposalId: proposal.id }, select: { id: true } });
    if (!contract) throw new ToolRefusal(`A proposta ${proposal.number} está "${proposal.status}": ainda não virou venda (a OS nasce sozinha quando a proposta de serviço é aceita)`);
    id = contract.id;
  }
  const contract = await deps.prisma.commercial_Contract.findFirst({
    where: { id, companyId: ctx.companyId },
    select: { id: true, number: true, title: true, kind: true, status: true, proposalId: true, customerOrderNumber: true, customerOrderDate: true, billingMode: true, customer: { select: { name: true } } },
  });
  if (!contract) throw new ToolRefusal('Venda (contrato) não encontrada');
  return contract;
}

/** Usuário ativo da empresa pelo id ou pelo nome (parte do nome serve; ambíguo recusa listando). */
async function userOf(ctx: ToolContext, deps: ToolDeps, id: unknown, name: unknown) {
  const userId = positiveInt(id);
  const term = text(name, 80);
  const where = { companyId: ctx.companyId, inactiveAt: null, ...(userId ? { id: userId } : { name: { contains: term, mode: 'insensitive' as const } }) };
  const rows = await deps.prisma.user.findMany({ where, select: { id: true, name: true }, take: 6, orderBy: { name: 'asc' } });
  if (!rows.length) throw new ToolRefusal(`Responsável ${term || userId} não encontrado entre os usuários ativos`);
  const exact = rows.find((row) => row.name.toLowerCase() === term.toLowerCase());
  if (rows.length > 1 && !exact) throw new ToolRefusal(`Mais de um usuário com "${term}": ${rows.map((row) => `${row.id} = ${row.name}`).join('; ')}. Diga qual (responsavelId).`);
  return exact ?? rows[0];
}

/** Uma parcela do contrato, enxuta, com a situação do marco da obra. */
function installmentLine(inst: any) {
  const work = inst.work;
  return {
    parcelaId: inst.id, parcela: `${inst.number}/${inst.total}`, descricao: inst.description || null, valor: money(inst.value),
    vence: inst.dueRule === 'percentual_obra' ? `ao atingir ${pct(work?.workPercent)} da obra` : DUE_RULE[inst.dueRule] ?? inst.dueRule,
    ...(work ? { marcoAtingido: work.reached, atingidoEm: work.reachedAt ? br(work.reachedAt) : undefined, previsaoDoMarco: work.expectedDate ? br(work.expectedDate) : undefined } : {}),
    caucao: inst.depositValue ? money(inst.depositValue) : undefined,
    faturada: inst.record ? { nota: inst.record.invoiceNumber, paga: inst.record.paid, vencimento: br(inst.record.dueDate) } : false,
  };
}

// ------------------------------------------------------------------ ferramentas

export const WORKS_TOOLS: ToolDefinition[] = [
  {
    name: 'os_da_proposta',
    title: 'Procurando a OS da proposta',
    description: 'A OS de uma proposta aceita (por propostaId, numeroProposta ou contratoId). A OS nasce sozinha no aceite da proposta de serviço: não existe "abrir OS". Diz se já existe, em que etapa está e o que falta (sem o pedido do cliente fica "A liberar"; registre com informar_pedido_do_cliente). Treinamento vira turma e locação vira ordem de locação: não têm OS.',
    inputSchema: obj({ propostaId: int('Id da proposta'), numeroProposta: str('Número da proposta (ex.: PR-2026-0012)'), contratoId: int('Id da venda (contrato)') }),
    permissions: ['list_ordens_de_servico'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const contract = await contractOf(ctx, deps, { contratoId: input.contratoId, propostaId: input.propostaId, numeroProposta: input.numeroProposta });
      const venda = {
        id: contract.id, numero: contract.number, titulo: contract.title, tipo: KIND_LABEL[contract.kind] ?? contract.kind, situacao: contract.status, cliente: contract.customer.name,
        pedidoDoCliente: contract.customerOrderNumber ? { numero: contract.customerOrderNumber, data: br(contract.customerOrderDate?.toISOString().slice(0, 10)) } : null,
        link: L.contract(contract.id),
      };
      if (contract.kind !== 'servico') {
        return { venda, os: null, explicacao: contract.kind === 'treinamento' ? 'Venda de treinamento: segue pelas turmas, não tem OS.' : 'Venda de locação: segue pela ordem de locação (Suprimentos), não tem OS.' };
      }
      const raw = await deps.prisma.service_Order.findUnique({ where: { contractId: contract.id }, select: { id: true } });
      if (!raw) {
        return { venda, os: null, explicacao: contract.status === 'cancelado' ? 'Venda cancelada: não abre OS.' : 'A OS ainda não apareceu: ela é criada na primeira abertura do quadro de OS (listar_os).' };
      }
      const order: any = await asRefusal(() => deps.orders.get(orderActor(ctx), raw.id));
      const falta = order.status === 'a_liberar' ? 'Falta o pedido de compra do cliente: com ele a OS vai para "A mobilizar" (informar_pedido_do_cliente).'
        : order.status === 'a_mobilizar' ? 'Pronta para mobilizar: defina responsável e datas (atualizar_os), escale a equipe (escalar_equipe_os) e agende (mover_os).'
          : null;
      return {
        venda,
        os: {
          id: order.id, numero: order.number, etapa: ORDER_LABEL[order.status] ?? order.status, proximasEtapas: (order.nextStatuses ?? []).map((s: string) => ORDER_LABEL[s] ?? s),
          responsavel: order.responsible?.name ?? null, inicioPrevisto: br(order.plannedStart), fimPrevisto: br(order.plannedEnd), link: L.order(order.id),
        },
        falta,
      };
    },
  },
  {
    name: 'informar_pedido_do_cliente',
    title: 'Preparando o registro do pedido do cliente',
    description: 'Registra o pedido de compra do cliente (número e data) na venda. É o que libera a OS que está "A liberar" para "A mobilizar" e o que o Financeiro cita na nota. Aceita a OS (osId), a venda (contratoId) ou a proposta. O arquivo do pedido só pela tela. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      numero: str('Número do pedido de compra do cliente'), data: str('Data do pedido (AAAA-MM-DD; padrão hoje)'),
      osId: int('Id da OS'), contratoId: int('Id da venda (contrato)'), propostaId: int('Id da proposta'), numeroProposta: str('Número da proposta'),
    }, ['numero']),
    permissions: ['update_comercial'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const numero = text(input.numero, 60);
      if (!numero) throw new ToolRefusal('Informe o número do pedido do cliente');
      const data = input.data ? String(input.data) : todayBr();
      if (!isDate(data)) throw new ToolRefusal('Data do pedido: use AAAA-MM-DD');
      if (data > todayBr()) throw new ToolRefusal('A data do pedido não pode ser futura');
      const contract = await contractOf(ctx, deps, input);
      if (contract.status === 'cancelado') throw new ToolRefusal(`A venda ${contract.number} está cancelada`);
      const order = await deps.prisma.service_Order.findUnique({ where: { contractId: contract.id }, select: { id: true, number: true, status: true } });
      const efeito = !order ? 'Só grava o pedido na venda' : order.status === 'a_liberar' ? `A OS ${order.number} sai de "A liberar" e vai para "A mobilizar"` : `A OS ${order.number} continua em "${ORDER_LABEL[order.status] ?? order.status}"`;
      return {
        summary: `Registrar o pedido ${numero} do cliente na venda ${contract.number} (${contract.customer.name})?`,
        details: [
          { label: 'Pedido', value: `${numero} de ${br(data)}` },
          ...(contract.customerOrderNumber && contract.customerOrderNumber !== numero ? [{ label: 'Substitui', value: contract.customerOrderNumber }] : []),
          { label: 'Efeito', value: efeito },
        ],
        payload: { contractId: contract.id, contractNumber: contract.number, number: numero, date: data },
      };
    },
    execute: async (ctx, payload, deps) => {
      await deps.api.call(ctx, 'PUT', `commercial/contracts/${payload.contractId}/customer-order`, { body: { number: payload.number, date: payload.date } });
      const order = await deps.prisma.service_Order.findUnique({ where: { contractId: payload.contractId }, select: { id: true, number: true, status: true } });
      return {
        message: `Pedido ${payload.number} registrado na venda ${payload.contractNumber}.${order ? ` A OS ${order.number} está em "${ORDER_LABEL[order.status] ?? order.status}".` : ''}`,
        link: order ? L.order(order.id) : L.contract(payload.contractId),
        data: order ? { osId: order.id, etapa: order.status } : undefined,
      };
    },
  },
  {
    name: 'avanco_da_obra',
    title: 'Medindo o avanço da obra',
    description: 'Avanço de uma obra (osId ou numeroOs) pelos RDOs: % feito × planejado para hoje e por etapa, horas feitas × orçadas, dias parados. Para quem vê o comercial, junta as parcelas da venda: as "ao atingir X% da obra" com o marco atingido ou a previsão, as que já podem ser faturadas, a caução retida e, na venda por medição, os boletins e o valor sugerido do próximo.',
    inputSchema: obj({ osId: int('Id da OS'), numeroOs: str('Número da OS (ex.: OS-2026-0003)') }),
    permissions: ['list_ordens_de_servico'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const raw = await orderOf(ctx, deps, input);
      if (!raw) throw new ToolRefusal('Informe a OS (osId ou numeroOs)');
      const out: any = await asRefusal(() => deps.reports.list(orderActor(ctx), raw.id));
      const s = out.summary;
      const result: Record<string, unknown> = {
        os: { id: raw.id, numero: raw.number, titulo: out.order.title, etapa: ORDER_LABEL[out.order.status] ?? out.order.status, cliente: out.order.customer?.name ?? null, link: L.order(raw.id) },
        avanco: {
          feito: s.progress.done, planejadoParaHoje: s.progress.planned,
          etapas: s.progress.steps.map((step: any) => ({ etapa: step.title, percentual: step.percent })),
          ultimoRdo: br(s.lastDate), rdos: s.reports, rascunhos: s.drafts,
        },
        horas: { feitas: s.hours.total, extras: s.hours.overtime, orcadas: s.hours.budget, extrasOrcadas: s.hours.budgetOvertime },
        diasParados: s.stoppedDays, horasPerdidas: s.hoursLost,
      };
      if (!has(ctx, 'list_comercial')) return { ...result, parcelas: 'Sem a permissão do comercial: as parcelas e a caução ficam com o Comercial/Financeiro.' };
      const c: any = await deps.api.call(ctx, 'GET', `commercial/contracts/${raw.contractId}`);
      const parcelas = (c.installments ?? []).map(installmentLine);
      // a mesma regra do A faturar: "após a conclusão" espera a conclusão; "% da obra" espera o marco (concluída libera tudo)
      const concluded = Boolean(c.endDate) || c.status === 'concluido';
      const waits = (inst: any) => !concluded && ((inst.dueRule === 'dias_apos_conclusao') || (inst.dueRule === 'percentual_obra' && !inst.work?.reached));
      const liberadas = (c.installments ?? []).filter((inst: any) => !inst.record && !waits(inst)).map((inst: any) => `${inst.number}/${inst.total}`);
      const retida = (c.installments ?? []).filter((i: any) => i.record && i.depositValue).reduce((sum: number, i: any) => sum + Number(i.depositValue), 0);
      const venda: Record<string, unknown> = {
        id: c.id, numero: c.number, valor: money(c.value), faturado: money(c.billed), recebido: money(c.received), aFaturar: money(c.toBill),
        avancoPeloRdoFechado: pct(c.workProgress?.percent), link: L.contract(c.id),
      };
      if (c.billingMode === 'medicao' && c.works) {
        const sug: any = c.status === 'vigente' ? await deps.api.call(ctx, 'GET', `commercial/contracts/${c.id}/works/suggestion`).catch(() => null) : null;
        return {
          ...result,
          venda: { ...venda, modo: 'medição de obra (boletins)' },
          boletins: c.works.measurements.map((m: any) => ({ id: m.id, boletim: m.label, situacao: MEASUREMENT_STATUS[m.status] ?? m.status, periodo: `${br(m.periodStart)} a ${br(m.periodEnd)}`, nota: money(m.invoiceValue), caucao: money(m.depositValue), aReceber: money(m.value) })),
          medido: money(c.works.summary.measured), saldoAMedir: money(c.works.summary.balance),
          caucao: { retida: money(c.works.summary.deposit), conta: c.works.summary.depositRecord ? { vencimento: br(c.works.summary.depositRecord.dueDate), paga: c.works.summary.depositRecord.paid } : null },
          proximoBoletim: c.works.summary.open ? 'Já há um boletim em aberto: ele precisa ser faturado (ou excluído) antes de outro.'
            : sug ? { periodo: `${br(sug.periodStart)} a ${br(sug.periodEnd)}`, rdoUsado: br(sug.rdoDate), frentes: sug.fronts.map((f: any) => ({ frenteId: f.id, frente: f.title, anterior: f.prevPercent, peloRdo: f.rdoPercent, sugerido: f.percent })), nota: money(sug.preview.invoiceValue), aReceber: money(sug.preview.value) } : null,
        };
      }
      return {
        ...result,
        venda: { ...venda, modo: 'parcelas' },
        parcelas,
        podemSerFaturadas: liberadas,
        caucao: c.deposit ? { percentual: pct(c.deposit.rate * 100), liberaDiasAposConclusao: c.deposit.releaseDays, retidaAteAgora: money(retida) } : null,
      };
    },
  },
  {
    name: 'a_faturar',
    title: 'Vendo o que está a faturar',
    description: 'Fila "A faturar" do Financeiro: parcelas das vendas e boletins de medição por etapa — liberada (já pode emitir a nota), aguardando (o que falta: conclusão, % da obra, aprovação do boletim), faturada e recebida. Padrão: só as liberadas. Traz valor, caução, vencimento sugerido e pedido do cliente. Faturar (emitir a nota) é pela tela.',
    inputSchema: obj({
      etapa: str('Etapa (padrão liberada)', { enum: [...BILLING_STAGES, 'todas'] }), tipo: str('Tipo de venda', { enum: ['servico', 'treinamento', 'locacao'] }),
      busca: str('Venda, cliente, título ou pedido do cliente'),
    }),
    permissions: ['list_financeiro'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const out: any = await deps.api.call(ctx, 'GET', 'commercial/contracts/billing', { query: { kind: input.tipo, search: text(input.busca, 80) } });
      const stage = input.etapa === 'todas' ? null : BILLING_STAGES.includes(input.etapa) ? input.etapa : 'liberada';
      const rows = (out.rows ?? []).filter((row: any) => !stage || row.stage === stage);
      return {
        resumo: Object.fromEntries(Object.entries(out.summary ?? {}).map(([key, value]: [string, any]) => [key, { quantidade: value.count, total: money(value.total) }])),
        etapa: stage ?? 'todas', total: rows.length, valor: money(rows.reduce((sum: number, row: any) => sum + Number(row.value), 0)),
        itens: rows.slice(0, 40).map((row: any) => ({
          etapa: row.stage, venda: row.contractNumber, cliente: row.customer?.name ?? null, titulo: text(row.title, 80), tipo: KIND_LABEL[row.kind] ?? row.kind,
          o_que: row.source === 'parcela' ? `parcela ${row.number}/${row.total}${row.description ? ` · ${row.description}` : ''}` : text(row.description, 140),
          valor: money(row.value), caucao: row.depositValue ? money(row.depositValue) : undefined,
          esperando: row.waitingFor ?? undefined, vencimentoSugerido: row.record ? undefined : br(row.suggestedDue),
          pedidoDoCliente: row.customerOrder?.number ?? null, nota: row.record?.invoiceNumber ?? undefined,
          link: L.contract(row.contractId),
        })),
        link: L.billing,
      };
    },
  },
  {
    name: 'estatisticas_diario',
    title: 'Lendo as estatísticas do diário',
    description: 'Clima e paradas pelo diário de obra num período (padrão: últimos 30 dias), de todas as obras ou de uma OS: clima na entrada e na saída, condição da frente de trabalho, dias parados, ocorrências por tipo com horas perdidas, horas por função e os dias com mais horas perdidas. Para horas por pessoa, jornada e saídas antecipadas use resumo_diario_de_obra.',
    inputSchema: obj({ de: str('Desde (AAAA-MM-DD)'), ate: str('Até (AAAA-MM-DD)'), osId: int('Só esta OS (opcional)') }),
    permissions: ['list_ordens_de_servico'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const query: Record<string, string> = {};
      if (isDate(input.de)) query.from = String(input.de);
      if (isDate(input.ate)) query.to = String(input.ate);
      if (positiveInt(input.osId)) query.orderId = String(positiveInt(input.osId));
      const out: any = await asRefusal(() => deps.reports.stats(orderActor(ctx), query));
      return {
        periodo: `${br(out.period.from)} a ${br(out.period.to)}`, rdos: out.reports, dias: out.days, obras: out.orders,
        clima: { naEntrada: tallied(out.weather.start, WEATHER), naSaida: tallied(out.weather.end, WEATHER), mudouDuranteODia: out.weather.changed },
        frenteDeTrabalho: { naEntrada: tallied(out.conditions.start, CONDITION), naSaida: tallied(out.conditions.end, CONDITION) },
        diasParados: out.stoppedDays, horasPerdidas: out.hours.lost,
        ocorrencias: out.occurrences.map((item: any) => ({ tipo: OCCURRENCE[item.type] ?? item.type, vezes: item.count, horasPerdidas: item.hoursLost })),
        porFuncao: out.byRole.slice(0, 10).map((row: any) => ({ funcao: row.role, presencas: row.presences, horas: row.hours, extras: row.overtime })),
        diasComMaisHorasPerdidas: out.byDay.filter((day: any) => day.hoursLost > 0).sort((a: any, b: any) => b.hoursLost - a.hoursLost).slice(0, 7).map((day: any) => ({ dia: br(day.date), horasPerdidas: day.hoursLost, pessoas: day.people })),
        link: L.stats,
      };
    },
  },
  {
    name: 'atualizar_os',
    title: 'Atualizando a OS',
    description: 'Altera dados de planejamento de uma OS: início e término previstos, responsável (id ou nome), local, contato na obra e observações. Só muda o que for informado; texto vazio apaga. Não muda a etapa (mover_os) nem a equipe (escalar_equipe_os). OS encerrada ou cancelada precisa ser reaberta.',
    inputSchema: obj({
      osId: int('Id da OS'), numeroOs: str('Número da OS'),
      inicioPrevisto: str('Início previsto (AAAA-MM-DD; vazio apaga)'), fimPrevisto: str('Término previsto (AAAA-MM-DD; vazio apaga)'),
      responsavelId: int('Id do usuário responsável'), responsavel: str('Nome do responsável (se não souber o id)'),
      local: str('Local da obra'), contatoNome: str('Contato na obra'), contatoTelefone: str('Telefone do contato'), contatoEmail: str('E-mail do contato'),
      observacoes: str('Observações da OS (substitui as atuais)'),
    }),
    permissions: ['update_ordens_de_servico'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const raw = await orderOf(ctx, deps, input);
      if (!raw) throw new ToolRefusal('Informe a OS (osId ou numeroOs)');
      const body: Record<string, unknown> = {};
      const mudou: string[] = [];
      for (const [key, field, label] of [['inicioPrevisto', 'plannedStart', 'início previsto'], ['fimPrevisto', 'plannedEnd', 'término previsto']] as const) {
        if (!(key in input)) continue;
        const value = String(input[key] ?? '').trim();
        if (value && !isDate(value)) throw new ToolRefusal(`${label}: use AAAA-MM-DD`);
        body[field] = value || null;
        mudou.push(label);
      }
      if (positiveInt(input.responsavelId) || text(input.responsavel)) {
        const user = await userOf(ctx, deps, input.responsavelId, input.responsavel);
        body.responsibleUserId = user.id;
        mudou.push(`responsável: ${user.name}`);
      }
      for (const [key, field, label, max] of [['local', 'location', 'local', 300], ['contatoNome', 'contactName', 'contato', 160], ['contatoTelefone', 'contactPhone', 'telefone do contato', 60], ['contatoEmail', 'contactEmail', 'e-mail do contato', 255], ['observacoes', 'notes', 'observações', 5000]] as const) {
        if (!(key in input)) continue;
        body[field] = text(input[key], max);
        mudou.push(label);
      }
      if (!mudou.length) throw new ToolRefusal('Diga o que mudar na OS (datas, responsável, local, contato ou observações)');
      const row: any = await deps.api.call(ctx, 'PUT', `service-orders/${raw.id}`, { body });
      return {
        mensagem: `OS ${row.number} atualizada: ${mudou.join(', ')}.`,
        os: { id: row.id, numero: row.number, etapa: ORDER_LABEL[row.status] ?? row.status, inicioPrevisto: br(row.plannedStart), fimPrevisto: br(row.plannedEnd), responsavel: row.responsible?.name ?? null, local: row.location, atrasada: row.late },
        link: L.order(row.id),
      };
    },
  },
  {
    name: 'registrar_medicao',
    title: 'Montando o boletim de medição',
    description: 'Cria o rascunho do próximo boletim de medição (BM) de uma venda faturada por medição de obra (osId ou contratoId). Sem frentes informadas, usa o % de cada frente pelo último RDO fechado (a mobilização sai inteira no primeiro). Devolve as linhas, o valor da nota, a caução e o a receber. Fica em rascunho: enviar ao cliente e faturar são pela tela. Só um boletim em aberto por venda.',
    inputSchema: obj({
      osId: int('Id da OS'), contratoId: int('Id da venda (contrato)'),
      fimDoPeriodo: str('Fim do período medido (AAAA-MM-DD; padrão hoje)'), inicioDoPeriodo: str('Início do período (AAAA-MM-DD; padrão: dia seguinte ao último boletim)'),
      frentes: { type: 'array', description: '% acumulado de cada frente (opcional; sem isso vale o RDO)', items: obj({ frenteId: int('Id da frente (veja avanco_da_obra)'), percentual: num('% acumulado (0 a 100)') }, ['frenteId', 'percentual']) },
      observacao: str('Observação do boletim'),
    }),
    permissions: ['update_comercial', 'list_comercial'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const contract = await contractOf(ctx, deps, { osId: input.osId, contratoId: input.contratoId });
      if (contract.billingMode !== 'medicao') throw new ToolRefusal(`A venda ${contract.number} é faturada por parcelas, não por medição de obra: veja as parcelas em avanco_da_obra`);
      for (const key of ['fimDoPeriodo', 'inicioDoPeriodo']) if (input[key] && !isDate(input[key])) throw new ToolRefusal(`${key}: use AAAA-MM-DD`);
      let fronts: Array<{ id: number; percent: number }>;
      if (Array.isArray(input.frentes) && input.frentes.length) {
        fronts = input.frentes.map((f: any) => {
          const percent = Number(f?.percentual);
          if (!positiveInt(f?.frenteId) || !(percent >= 0 && percent <= 100)) throw new ToolRefusal('Cada frente precisa do frenteId e de um % entre 0 e 100');
          return { id: Number(f.frenteId), percent };
        });
      } else {
        const sug: any = await deps.api.call(ctx, 'GET', `commercial/contracts/${contract.id}/works/suggestion`, { query: { periodEnd: input.fimDoPeriodo } });
        fronts = sug.fronts.map((f: any) => ({ id: f.id, percent: f.percent }));
      }
      const out: any = await deps.api.call(ctx, 'POST', `commercial/contracts/${contract.id}/works`, {
        body: { periodEnd: input.fimDoPeriodo || undefined, periodStart: input.inicioDoPeriodo || undefined, fronts, notes: text(input.observacao, 2000) || undefined },
      });
      const bm = (out.works?.measurements ?? []).find((m: any) => m.id === out.created?.id);
      if (!bm) return { mensagem: `Boletim ${out.created?.number ?? ''} criado em rascunho.`, link: L.contract(contract.id) };
      return {
        mensagem: `${bm.label} criado em rascunho: nota de ${brl(bm.invoiceValue)}, caução de ${brl(bm.depositValue)}, a receber ${brl(bm.value)}. Revise, envie ao cliente e fature pela tela da venda.`,
        boletim: {
          id: bm.id, numero: bm.label, periodo: `${br(bm.periodStart)} a ${br(bm.periodEnd)}`, nota: money(bm.invoiceValue), caucao: money(bm.depositValue), aReceber: money(bm.value),
          linhas: (bm.lines ?? []).map((l: any) => ({ o_que: l.description, anterior: l.prevPercent, noPeriodo: l.percent, acumulado: l.accPercent, valor: money(l.value) })),
        },
        link: L.contract(contract.id),
      };
    },
  },
];
