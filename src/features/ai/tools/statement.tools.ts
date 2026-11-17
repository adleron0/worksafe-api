import { brl, isDate, positiveInt, text } from './actors';
import { ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Extratos pelo assistente: ele lê o PDF (ou o Claude do dono lê, pelo MCP),
 * manda as linhas, o sistema confere a soma e guarda um rascunho. A
 * classificação é sugerida linha a linha e o lançamento passa pela mesma
 * conciliação do OFX, com uma confirmação só no cartão.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const num = (description: string) => ({ type: 'number', description });
const date = (description: string) => ({ type: 'string', description: `${description} (AAAA-MM-DD)` });

const ACTION_LABEL: Record<string, string> = { baixar: 'dar baixa em conta já lançada', vincular: 'só marcar como conciliada', criar: 'criar lançamento novo', transferir: 'transferência entre contas', ignorar: 'ignorar' };
const draftLink = (id: number) => `/financeiro/conciliacao?rascunho=${id}`;

/** Resumo enxuto do rascunho para o modelo: totais, conferência e as linhas que pedem decisão. */
function summarize(draft: any, maxLines = 50, fromLine = 1) {
  const items: any[] = draft.items ?? [];
  const open = items.map((item, index) => ({ item, linha: index + 1 })).filter(({ item, linha }) => linha >= fromLine && (item.status === 'sugerido' || item.status === 'sem_par'));
  return {
    rascunhoId: draft.id, situacao: draft.status, conta: draft.bankAccount?.name, periodo: draft.period,
    conferencia: { saldoInicial: draft.check?.opening, entradas: draft.check?.credits, saidas: draft.check?.debits, saldoFinal: draft.check?.closing, diferenca: draft.check?.difference, confere: draft.check?.ok },
    saldoDoSistemaNaData: draft.balance?.system,
    totais: { linhas: items.length, jaConciliadas: draft.totals?.reconciled, comPar: draft.totals?.suggested, semPar: draft.totals?.unmatched, antesDoSaldoInicial: draft.totals?.beforeStart },
    linhasParaDecidir: open.slice(0, maxLines).map(({ item, linha }) => ({
      linha, data: item.date, valor: item.amount, historico: item.memo,
      par: item.candidates?.[0] ? `${item.candidates[0].type === 'payable' ? 'conta a pagar' : 'conta a receber'} #${item.candidates[0].id} "${item.candidates[0].label}" ${brl(item.candidates[0].value)}` : null,
      proposta: item.proposed ? { acao: item.proposed.action, contaDoPlanoId: item.proposed.chartAccountId, fornecedorId: item.proposed.supplierId, clienteId: item.proposed.customerId } : null,
    })),
    maisLinhas: Math.max(0, open.length - maxLines),
    link: draftLink(draft.id),
  };
}

export const STATEMENT_TOOLS: ToolDefinition[] = [
  {
    name: 'fin_situacao_inicial',
    title: 'Vendo como está o financeiro',
    description: 'Ponto de partida para organizar o financeiro: contas bancárias (com saldo inicial e a data dele), até quando cada conta tem extrato conciliado, rascunhos de extrato abertos, lançamentos sem categoria e o tamanho do plano de contas. Use no começo de toda conversa de organização para saber de onde continuar.',
    inputSchema: obj({}),
    permissions: ['list_financeiro'], risk: 'read',
    run: async (ctx, _input, deps) => {
      const companyId = ctx.companyId;
      const [banks, drafts, chart, centers, suppliers, payablesNoCategory, receivablesNoCategory, payablesTotal, receivablesManual] = await Promise.all([
        deps.prisma.financial_BankAccount.findMany({ where: { companyId, inactiveAt: null }, select: { id: true, name: true, type: true, bankName: true, openingBalance: true, openingBalanceDate: true, isDefault: true }, orderBy: { id: 'asc' } }),
        deps.prisma.financial_StatementDraft.findMany({ where: { companyId, status: { in: ['rascunho', 'nao_confere', 'parcial'] } }, select: { id: true, bankAccountId: true, status: true, periodFrom: true, periodTo: true, difference: true }, orderBy: { id: 'desc' }, take: 20 }),
        deps.prisma.financial_ChartAccount.count({ where: { companyId, inactiveAt: null } }),
        deps.prisma.financial_CostCenter.count({ where: { companyId, inactiveAt: null } }),
        deps.prisma.financial_Supplier.count({ where: { companyId, inactiveAt: null } }),
        deps.prisma.financial_Payable.count({ where: { companyId, inactiveAt: null, chartAccountId: null } }),
        deps.prisma.financialRecords.count({ where: { companyId, inactiveAt: null, chartAccountId: null, status: { not: 'cancelled' } } }),
        deps.prisma.financial_Payable.count({ where: { companyId, inactiveAt: null } }),
        deps.prisma.financialRecords.count({ where: { companyId, inactiveAt: null, gateway: 'manual' } }),
      ]);
      const contas = await Promise.all(banks.map(async (bank) => {
        // último dia com linha de extrato conciliada nesta conta
        const [payable, record, lastDraft] = await Promise.all([
          deps.prisma.financial_Payable.findFirst({ where: { companyId, bankAccountId: bank.id, statementRef: { not: null } }, orderBy: { paidAt: 'desc' }, select: { paidAt: true } }),
          deps.prisma.financialRecords.findFirst({ where: { companyId, bankAccountId: bank.id, statementRef: { not: null } }, orderBy: { paidAt: 'desc' }, select: { paidAt: true } }),
          deps.prisma.financial_StatementDraft.findFirst({ where: { companyId, bankAccountId: bank.id, status: 'lancado' }, orderBy: { periodTo: 'desc' }, select: { periodTo: true } }),
        ]);
        const dates = [payable?.paidAt?.toISOString().slice(0, 10), record?.paidAt?.toISOString().slice(0, 10), lastDraft?.periodTo].filter(Boolean).sort() as string[];
        return {
          id: bank.id, nome: bank.name, tipo: bank.type, banco: bank.bankName, padrao: bank.isDefault,
          saldoInicial: Number(bank.openingBalance), dataSaldoInicial: bank.openingBalanceDate?.toISOString().slice(0, 10) ?? null,
          extratoConciliadoAte: dates[dates.length - 1] ?? null,
        };
      }));
      const etapa = !contas.length ? 'cadastrar_contas'
        : contas.some((conta) => !conta.dataSaldoInicial) ? 'definir_saldo_inicial'
          : drafts.length ? 'revisar_rascunhos'
            : contas.some((conta) => !conta.extratoConciliadoAte) ? 'pedir_extratos'
              : payablesNoCategory + receivablesNoCategory > 0 ? 'categorizar' : 'em_dia';
      return {
        etapa, contas,
        rascunhosAbertos: drafts.map((draft) => ({ id: draft.id, contaId: draft.bankAccountId, situacao: draft.status, periodo: `${draft.periodFrom} a ${draft.periodTo}`, diferenca: Number(draft.difference), link: draftLink(draft.id) })),
        semCategoria: { contasAPagar: payablesNoCategory, contasAReceber: receivablesNoCategory },
        lancamentos: { contasAPagar: payablesTotal, contasAReceberManuais: receivablesManual },
        cadastros: { contasDoPlano: chart, centrosDeCusto: centers, fornecedores: suppliers },
        hoje: new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10),
      };
    },
  },
  {
    name: 'fin_ler_extrato',
    title: 'Conferindo o extrato',
    description: 'Registra o extrato bancário que você leu (PDF anexado pela pessoa) como RASCUNHO, sem lançar nada. Mande TODAS as linhas de movimento do período na ordem do extrato (saída com valor negativo, entrada positivo; ignore linhas de saldo do dia), o saldo anterior ao primeiro lançamento e o saldo final. O sistema confere se saldo inicial + linhas = saldo final; se não conferir, releia a página e mande de novo com substituiRascunhoId. Devolve o que já está conciliado, os pares encontrados e as linhas sem par para você sugerir a classificação. Extrato longo: mande em partes de até 200 linhas (por semana ou quinzena), cada parte com o saldo do início e do fim dela.',
    inputSchema: obj({
      contaBancariaId: int('Conta bancária do extrato (veja fin_situacao_inicial)'),
      saldoInicial: num('Saldo anterior ao primeiro lançamento do período'),
      saldoFinal: num('Saldo ao fim do período'),
      periodoDe: date('Primeiro dia do período do extrato'),
      periodoAte: date('Último dia do período do extrato'),
      arquivo: str('Nome do arquivo lido'),
      substituiRascunhoId: int('Rascunho anterior deste mesmo extrato que deve ser descartado (releitura)'),
      lancamentos: {
        type: 'array', description: 'Linhas de movimento, na ordem do extrato',
        items: obj({ data: date('Data do lançamento'), valor: num('Valor: negativo = saída, positivo = entrada'), historico: str('Histórico como está no extrato') }, ['data', 'valor', 'historico']),
      },
    }, ['contaBancariaId', 'saldoInicial', 'saldoFinal', 'lancamentos']),
    permissions: ['create_financeiro', 'importar_extrato_bots'], risk: 'draft',
    run: async (ctx, input, deps) => {
      const bankAccountId = positiveInt(input.contaBancariaId);
      if (!bankAccountId) throw new ToolRefusal('Informe a conta bancária do extrato');
      const lines = (Array.isArray(input.lancamentos) ? input.lancamentos : []).map((line: any) => ({ date: String(line?.data ?? ''), amount: Number(line?.valor), memo: text(line?.historico, 200) }));
      if (!lines.length) throw new ToolRefusal('Nenhum lançamento lido');
      const replaced = positiveInt(input.substituiRascunhoId);
      if (replaced) await deps.api.call(ctx, 'PATCH', `financial/statement-drafts/${replaced}/discard`).catch(() => undefined);
      const draft = await deps.api.call(ctx, 'POST', 'financial/statement-drafts', {
        body: {
          bankAccountId, openingBalance: input.saldoInicial, closingBalance: input.saldoFinal, lines,
          periodFrom: isDate(input.periodoDe) ? input.periodoDe : undefined, periodTo: isDate(input.periodoAte) ? input.periodoAte : undefined,
          fileName: input.arquivo ? text(input.arquivo, 200) : undefined, source: ctx.origin === 'mcp' ? 'mcp' : 'pdf', botId: ctx.botId ?? undefined,
        },
      });
      const out = summarize(draft);
      return draft.check?.ok
        ? { ...out, proximoPasso: 'A soma confere. Sugira a classificação das linhas sem par (fin_sugerir_classificacao_extrato), mostre o resumo à pessoa e prepare o lançamento (fin_lancar_extrato).' }
        : { ...out, proximoPasso: `A soma NÃO confere (diferença de ${brl(draft.check?.difference)}). Releia o extrato procurando linha faltando, valor trocado ou sinal errado e mande de novo com substituiRascunhoId=${draft.id}. Se persistir, mostre a diferença à pessoa.` };
    },
  },
  {
    name: 'fin_sugerir_classificacao_extrato',
    title: 'Classificando o extrato',
    description: 'Guarda no rascunho do extrato o que fazer com cada linha (pelo número da linha devolvido em fin_ler_extrato): criar com conta do plano, centro de custo e fornecedor/cliente; dar baixa numa conta já lançada; transferência entre contas; ou ignorar. Não lança nada. Use os ids do plano de contas (fin_plano_de_contas) e dos cadastros (fin_cadastros); fornecedor novo, cadastre antes.',
    inputSchema: obj({
      rascunhoId: int('Rascunho do extrato'),
      linhas: {
        type: 'array', description: 'Sugestões por linha',
        items: obj({
          linha: int('Número da linha (1 = primeira)'),
          acao: str('O que fazer', { enum: ['criar', 'baixar', 'vincular', 'transferir', 'ignorar'] }),
          contaDoPlanoId: int('Conta do plano de contas (criar)'), centroDeCustoId: int('Centro de custo (criar)'),
          fornecedorId: int('Fornecedor (criar saída)'), clienteId: int('Cliente (criar entrada)'),
          lancamentoId: int('Conta a pagar/receber já lançada (baixar ou vincular)'), tipoLancamento: str('pagar ou receber (baixar ou vincular)', { enum: ['pagar', 'receber'] }),
          outraContaBancariaId: int('Outra conta da empresa (transferir)'), descricao: str('Descrição do lançamento (criar); padrão: o histórico'),
        }, ['linha', 'acao']),
      },
    }, ['rascunhoId', 'linhas']),
    permissions: ['update_financeiro', 'importar_extrato_bots'], risk: 'draft',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.rascunhoId);
      if (!id) throw new ToolRefusal('Informe o rascunho');
      const items = (Array.isArray(input.linhas) ? input.linhas : []).slice(0, 1500).map((line: any) => ({
        index: Number(line?.linha) - 1, action: line?.acao, chartAccountId: line?.contaDoPlanoId, costCenterId: line?.centroDeCustoId,
        supplierId: line?.fornecedorId, customerId: line?.clienteId, targetId: line?.lancamentoId,
        type: line?.tipoLancamento === 'receber' ? 'receivable' : line?.tipoLancamento === 'pagar' ? 'payable' : undefined,
        otherBankAccountId: line?.outraContaBancariaId, description: line?.descricao ? text(line.descricao, 255) : undefined,
      })).filter((item: any) => item.index >= 0);
      if (!items.length) throw new ToolRefusal('Nenhuma linha');
      const out = await deps.api.call(ctx, 'PUT', `financial/statement-drafts/${id}/suggestions`, { body: { items } });
      return { alteradas: out.changed, ...summarize(out.draft, 30) };
    },
  },
  {
    name: 'fin_ver_rascunho_extrato',
    title: 'Abrindo o rascunho do extrato',
    description: 'Mostra um rascunho de extrato: conferência da soma, totais e as linhas que pedem decisão (com a proposta atual), a partir de uma linha. Use para continuar a classificação quando houver mais linhas que o mostrado.',
    inputSchema: obj({ rascunhoId: int('Rascunho do extrato'), aPartirDaLinha: int('Mostrar a partir desta linha (padrão 1)') }, ['rascunhoId']),
    permissions: ['list_financeiro', 'importar_extrato_bots'], risk: 'read',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.rascunhoId);
      if (!id) throw new ToolRefusal('Informe o rascunho');
      return summarize(await deps.api.call(ctx, 'GET', `financial/statement-drafts/${id}`), 50, positiveInt(input.aPartirDaLinha) ?? 1);
    },
  },
  {
    name: 'fin_lancar_extrato',
    title: 'Preparando o lançamento do extrato',
    description: 'Lança o rascunho do extrato: cada linha vira o que foi sugerido (baixa, lançamento novo já pago/recebido, transferência) pela conciliação, que não lança duas vezes. Só depois de a soma conferir. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({ rascunhoId: int('Rascunho do extrato') }, ['rascunhoId']),
    permissions: ['update_financeiro', 'importar_extrato_bots'], risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const id = positiveInt(input.rascunhoId);
      if (!id) throw new ToolRefusal('Informe o rascunho');
      const draft = await deps.api.call(ctx, 'GET', `financial/statement-drafts/${id}`);
      if (!draft.check?.ok) throw new ToolRefusal(`A soma do extrato não confere (diferença de ${brl(draft.check?.difference)}): releia antes de lançar`);
      if (draft.status === 'lancado') throw new ToolRefusal('Este extrato já foi lançado');
      if (draft.status === 'descartado') throw new ToolRefusal('Este extrato foi descartado');
      const actions = new Map<string, { n: number; total: number }>();
      let noCategory = 0;
      for (const item of draft.items as any[]) {
        if (!item.proposed) continue;
        const current = actions.get(item.proposed.action) ?? { n: 0, total: 0 };
        actions.set(item.proposed.action, { n: current.n + 1, total: current.total + item.amount });
        if (item.proposed.action === 'criar' && !item.proposed.chartAccountId) noCategory++;
      }
      const count = [...actions.values()].reduce((sum, value) => sum + (value.n), 0) - (actions.get('ignorar')?.n ?? 0);
      if (!count) throw new ToolRefusal('Nada para lançar: as linhas já estão conciliadas ou ignoradas');
      const details = [
        { label: 'Conta', value: draft.bankAccount?.name ?? '' },
        { label: 'Período', value: `${String(draft.period.from).split('-').reverse().join('/')} a ${String(draft.period.to).split('-').reverse().join('/')}` },
        { label: 'Conferência', value: `${brl(draft.check.opening)} + ${brl(draft.check.credits)} − ${brl(Math.abs(draft.check.debits))} = ${brl(draft.check.closing)} ✓` },
        ...[...actions.entries()].map(([action, value]) => ({ label: ACTION_LABEL[action] ?? action, value: `${value.n} linha(s), ${brl(value.total)}` })),
      ];
      if (draft.totals?.reconciled) details.push({ label: 'Já conciliadas', value: `${draft.totals.reconciled} (não mexe)` });
      if (noCategory) details.push({ label: 'Atenção', value: `${noCategory} lançamento(s) novo(s) sem categoria` });
      return { summary: `Lançar ${count} linha(s) do extrato de ${draft.bankAccount?.name}?`, details, payload: { id } };
    },
    execute: async (ctx, payload, deps) => {
      const out = await deps.api.call(ctx, 'POST', `financial/statement-drafts/${payload.id}/apply`, { body: {} });
      const errors = (out.errors ?? []) as Array<{ reason: string }>;
      return {
        message: `${out.applied} linha(s) lançada(s)${errors.length ? `; ${errors.length} com problema (${errors.slice(0, 3).map((error) => error.reason).join('; ')})` : ''}${out.remaining ? `; ${out.remaining} ainda em aberto` : ''}.`,
        link: draftLink(payload.id), data: out,
      };
    },
  },
];
