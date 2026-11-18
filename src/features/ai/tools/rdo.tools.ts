import { frontUrl } from '../mcp/mcp-oauth.service';
import { asRefusal, isDate, orderActor, positiveInt, text, todayBr } from './actors';
import { ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Diário de obra (RDO) para o coordenador: ler e conferir os relatórios,
 * acompanhar o andamento das obras, ver o que falta, devolver para quem
 * preencheu corrigir e cobrar o preenchimento. As regras ficam no
 * DailyReportService (o mesmo da tela); aqui só se resume para o modelo.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const br = (value: string | null | undefined) => (value ? value.split('-').reverse().join('/') : '');
const SHIFT: Record<string, string> = { integral: 'dia inteiro', manha: 'manhã', tarde: 'tarde', noite: 'noite' };
const situacao = (row: { status: string; returned?: unknown }) => (row.returned ? 'devolvido' : row.status);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Linha curta de um RDO (listas). */
function line(row: any) {
  return {
    id: row.id, os: row.order?.number ?? undefined, data: row.date, turno: SHIFT[row.shift] ?? row.shift, situacao: situacao(row),
    pessoas: row.people, horas: row.hours, horasExtras: row.overtime, ocorrencias: row.occurrences, fotos: row.photos,
    saidasAntecipadas: row.earlyLeaves || undefined, feito: row.activities ? text(row.activities, 140) : null,
    preenchidoPor: row.createdBy, motivoDaDevolucao: row.returned?.note ?? undefined,
    link: `/servicos/ordens-de-servico/${row.orderId ?? row.order?.id}/rdo/${row.id}`,
  };
}

async function userContact(deps: any, companyId: number, userId: number | null | undefined) {
  if (!userId) return null;
  const user = await deps.prisma.user.findFirst({ where: { id: userId, companyId }, select: { id: true, name: true, email: true } })
    ?? await deps.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
  if (!user) return null;
  return { id: user.id, name: user.name as string, email: user.email && EMAIL.test(user.email) ? (user.email as string) : null };
}

export const RDO_TOOLS: ToolDefinition[] = [
  {
    name: 'listar_rdos',
    title: 'Consultando o diário de obra',
    description: 'Lista os RDOs (relatórios diários de obra). Com osId traz todos os da OS e o andamento dela (avanço feito × planejado por etapa, horas × orçado, dias parados). Sem osId, os mais recentes de todas as obras. Filtra por período e situação (rascunho, fechado, devolvido).',
    inputSchema: obj({
      osId: int('Id da OS (opcional)'), de: str('Desde (AAAA-MM-DD)'), ate: str('Até (AAAA-MM-DD)'),
      situacao: str('Situação', { enum: ['rascunho', 'fechado', 'devolvido'] }),
    }),
    permissions: ['list_ordens_de_servico'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const actor = orderActor(ctx);
      const osId = positiveInt(input.osId);
      const keep = (row: any) => (!isDate(input.de) || row.date >= input.de) && (!isDate(input.ate) || row.date <= input.ate) && (!input.situacao || situacao(row) === input.situacao);
      if (osId) {
        const out: any = await asRefusal(() => deps.reports.list(actor, osId));
        const summary = out.summary;
        const rows = out.rows.filter(keep);
        return {
          os: { id: out.order.id, numero: out.order.number, titulo: out.order.title, etapa: out.order.status, cliente: out.order.customer?.name ?? null, inicio: out.order.startedAt, local: out.order.location },
          andamento: {
            rdos: summary.reports, diasComRdo: summary.days, rascunhos: summary.drafts, ultimoRdo: summary.lastDate,
            avancoFeito: summary.progress.done, avancoPlanejadoHoje: summary.progress.planned,
            etapas: summary.progress.steps.map((step: any) => ({ etapa: step.title, percentual: step.percent })),
            horas: { feitas: summary.hours.total, extras: summary.hours.overtime, orcadas: summary.hours.budget, extrasOrcadas: summary.hours.budgetOvertime },
            diasParados: summary.stoppedDays, horasPerdidas: summary.hoursLost,
            maoDeObra: summary.labor ? { custo: summary.labor.cost, orcado: summary.labor.budget } : undefined,
          },
          total: rows.length,
          rdos: rows.slice(0, 40).map((row: any) => line({ ...row, order: { id: osId } })),
        };
      }
      const out: any = await asRefusal(() => deps.reports.recent(actor, { limit: '100' }));
      const rows = out.rows.filter(keep);
      return {
        hoje: out.today,
        obrasEmExecucao: out.running.map((order: any) => ({ id: order.id, numero: order.number, titulo: order.title, cliente: order.customer, rdoDeHoje: order.todayReports.length > 0 })),
        total: rows.length,
        rdos: rows.slice(0, 40).map(line),
      };
    },
  },
  {
    name: 'ver_rdo',
    title: 'Conferindo o RDO',
    description: 'Abre um RDO inteiro (equipe com horas, entrada e saída, o que foi feito, avanço por etapa, ocorrências, fotos, clima) e traz pontosDeAtencao: o que está faltando ou fora do comum, já conferido pelo sistema. Use para revisar um RDO e apontar falhas.',
    inputSchema: obj({ rdoId: int('Id do RDO') }, ['rdoId']),
    permissions: ['list_ordens_de_servico'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.rdoId);
      if (!id) throw new ToolRefusal('Informe o id do RDO');
      const actor = orderActor(ctx);
      const row: any = await asRefusal(() => deps.reports.get(actor, id));
      const pontos = await deps.reports.findings(actor, id);
      return {
        id: row.id, os: { id: row.order.id, numero: row.order.number, titulo: row.order.title, cliente: row.order.customer?.name ?? null },
        data: row.date, turno: SHIFT[row.shift] ?? row.shift, situacao: situacao(row),
        entrada: row.startTime, saida: row.endTime, intervaloMin: row.breakMinutes, clima: { entrada: row.weather, saida: row.weatherEnd },
        frente: { entrada: row.startCondition, notaEntrada: row.startNote, saida: row.endCondition, notaSaida: row.endNote },
        equipe: row.crew.map((member: any) => ({ nome: member.name, funcao: member.role || null, horas: member.hours, extras: member.overtime, entrou: member.in || undefined, saiu: member.out || undefined, motivoSaida: member.leaveReason || undefined })),
        feito: row.activities ? text(row.activities, 1500) : null,
        avanco: row.progress.map((item: any) => ({ etapa: item.title, percentual: item.percent })),
        ocorrencias: row.occurrences.map((item: any) => ({ tipo: item.type, descricao: text(item.description, 300), horasPerdidas: item.hoursLost })),
        equipamentos: row.equipment ? text(row.equipment, 400) : null, observacoes: row.notes ? text(row.notes, 600) : null,
        fotos: row.photos.length, legendasDasFotos: row.photos.map((photo: any) => photo.caption).filter(Boolean).slice(0, 10),
        preenchidoPor: row.createdBy, fechadoPor: row.closedBy, devolucao: row.returned ? { motivo: row.returned.note, por: row.returned.by, em: row.returned.at } : null,
        pontosDeAtencao: pontos,
        link: `/servicos/ordens-de-servico/${row.order.id}/rdo/${row.id}`,
      };
    },
  },
  {
    name: 'rdos_pendentes',
    title: 'Vendo o que falta no diário de obra',
    description: 'Obras em execução com RDO faltando: dias sem relatório (domingo não conta, a menos que peça), rascunhos de dias passados não fechados e RDOs devolvidos que ainda não voltaram. Traz o responsável da OS e quem preencheu por último. Use antes de cobrar.',
    inputSchema: obj({ dias: int('Quantos dias para trás olhar (1 a 31, padrão 7)'), osId: int('Só esta OS (opcional)'), contarDomingo: { type: 'boolean', description: 'A obra trabalha no domingo' } }),
    permissions: ['list_ordens_de_servico'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const out: any = await asRefusal(() => deps.reports.pending(orderActor(ctx), { days: Number(input.dias) || 7, orderId: positiveInt(input.osId), sundays: input.contarDomingo === true }));
      const obras = out.orders.map((order: any) => ({
        id: order.id, numero: order.number, titulo: order.title, cliente: order.customer, responsavel: order.responsible?.name ?? null, ultimoAPreencher: order.lastFiller?.name ?? null,
        diasSemRdo: order.missingDays.map(br), rascunhosAbertos: order.drafts.map((draft: any) => ({ id: draft.id, data: br(draft.date), por: draft.by })),
        devolvidos: order.returned.map((item: any) => ({ id: item.id, data: br(item.date), motivo: item.note, por: item.by })),
      }));
      const comPendencia = obras.filter((order: any) => order.diasSemRdo.length || order.rascunhosAbertos.length || order.devolvidos.length);
      return { hoje: br(out.today), periodo: `${br(out.from)} a ${br(out.today)}`, obrasEmExecucao: obras.length, emDia: obras.length - comPendencia.length, pendencias: comPendencia };
    },
  },
  {
    name: 'resumo_diario_de_obra',
    title: 'Resumindo o diário de obra',
    description: 'Números do diário de obra num período (padrão: últimos 30 dias), de todas as obras ou de uma OS: presenças, horas normais, extras e perdidas, horário médio de entrada e saída, saídas antecipadas e motivos, dias parados, ocorrências por tipo e horas por obra e por pessoa.',
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
        periodo: `${br(out.period.from)} a ${br(out.period.to)}`, rdos: out.reports, rascunhos: out.drafts, dias: out.days, obras: out.orders,
        presencas: out.people.presences, pessoasDiferentes: out.people.distinct, mediaDePessoasPorDia: out.people.averagePerDay,
        horas: { normais: out.hours.normal, extras: out.hours.overtime, perdidas: out.hours.lost, porPresenca: out.hours.perPresence },
        horario: { entradaMedia: out.times.averageStart, saidaMedia: out.times.averageEnd, jornadaMediaHoras: out.times.averageSpan },
        saidasAntecipadas: { total: out.earlyLeaves.count, percentual: out.earlyLeaves.rate, motivos: out.earlyLeaves.reasons.slice(0, 5) },
        diasParados: out.stoppedDays, ocorrencias: out.occurrences.map((item: any) => ({ tipo: item.type, vezes: item.count, horasPerdidas: item.hoursLost })),
        porObra: out.byOrder.slice(0, 15).map((row: any) => ({ id: row.id, numero: row.number, cliente: row.customer, dias: row.days, horas: row.hours, extras: row.overtime, horasPerdidas: row.hoursLost })),
        porPessoa: out.byPerson.slice(0, 15).map((row: any) => ({ nome: row.name, funcao: row.role, dias: row.days, horas: row.hours, extras: row.overtime, saidasAntecipadas: row.earlyLeaves })),
      };
    },
  },
  {
    name: 'devolver_rdo',
    title: 'Preparando a devolução do RDO',
    description: 'Devolve um RDO para quem preencheu corrigir: volta a ser rascunho (se estava fechado) com o motivo, que aparece na tela e na esteira da pessoa; ela recebe um e-mail se tiver e-mail cadastrado. Escreva o motivo dizendo exatamente o que corrigir. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({ rdoId: int('Id do RDO'), motivo: str('O que precisa ser corrigido (claro e específico)') }, ['rdoId', 'motivo']),
    permissions: ['update_ordens_de_servico'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const id = positiveInt(input.rdoId);
      if (!id) throw new ToolRefusal('Informe o id do RDO');
      const motivo = text(input.motivo, 500);
      if (motivo.length < 10) throw new ToolRefusal('Escreva o motivo dizendo o que corrigir');
      const row: any = await asRefusal(() => deps.reports.get(orderActor(ctx), id));
      const raw = await deps.prisma.service_DailyReport.findUnique({ where: { id }, select: { createdByUserId: true } });
      const who = await userContact(deps, ctx.companyId, raw?.createdByUserId);
      return {
        summary: `Devolver o RDO de ${br(row.date)} da OS ${row.order.number} para ${who?.name ?? 'quem preencheu'} corrigir?`,
        details: [
          { label: 'Motivo', value: motivo },
          { label: 'Situação hoje', value: situacao(row) },
          { label: 'Aviso', value: who?.email ? `e-mail para ${who.email}` : 'sem e-mail cadastrado: a pessoa verá na tela e na esteira' },
        ],
        payload: { reportId: id, orderId: row.order.id, note: motivo, email: who?.email ?? null, name: who?.name ?? null, date: row.date, order: row.order.number },
      };
    },
    execute: async (ctx, payload, deps) => {
      await asRefusal(() => deps.reports.sendBack(orderActor(ctx), payload.reportId, { note: payload.note }));
      const link = `/servicos/ordens-de-servico/${payload.orderId}/rdo/${payload.reportId}`;
      let aviso = '';
      if (payload.email && deps.notify.emailReady()) {
        aviso = await deps.notify.sendEmail(payload.email, `RDO de ${br(payload.date)} devolvido para correção`, `RDO da OS ${payload.order} (${br(payload.date)}) devolvido para correção`,
          `${payload.name ? `${payload.name}, o` : 'O'} RDO de ${br(payload.date)} da OS ${payload.order} voltou para você corrigir.\n\nO que corrigir: ${payload.note}\n\nDepois de corrigir, feche o RDO de novo.`, `${frontUrl()}${link}`)
          .then(() => ` Aviso enviado para ${payload.email}.`).catch(() => ' O e-mail de aviso não saiu; a pessoa verá na tela e na esteira.');
      }
      return { message: `RDO de ${br(payload.date)} da OS ${payload.order} devolvido para correção.${aviso}`, link };
    },
  },
  {
    name: 'cobrar_rdo',
    title: 'Preparando a cobrança do RDO',
    description: 'Manda um e-mail cobrando o diário de uma obra em execução: lista os dias sem RDO, rascunhos não fechados e devolvidos sem correção. Vai para o responsável da OS (ou para quem preencheu por último, se pedir). Só use depois de ver as pendências (rdos_pendentes). Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      osId: int('Id da OS'), para: str('Quem recebe', { enum: ['responsavel', 'quem_preencheu'] }),
      mensagem: str('Recado curto para incluir no e-mail (opcional)'), dias: int('Quantos dias para trás olhar (padrão 7)'),
      contarDomingo: { type: 'boolean', description: 'A obra trabalha no domingo' },
    }, ['osId']),
    permissions: ['update_ordens_de_servico'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const id = positiveInt(input.osId);
      if (!id) throw new ToolRefusal('Informe o id da OS');
      if (!deps.notify.emailReady()) throw new ToolRefusal('O envio de e-mail não está configurado no servidor');
      const out: any = await asRefusal(() => deps.reports.pending(orderActor(ctx), { days: Number(input.dias) || 7, orderId: id, sundays: input.contarDomingo === true }));
      const order = out.orders[0];
      if (!order) throw new ToolRefusal('Esta OS não está em execução: não há diário para cobrar');
      const missing: string[] = order.missingDays.filter((day: string) => day < out.today);
      const lines = [
        ...(missing.length ? [`Dias sem RDO: ${missing.map(br).join(', ')}`] : []),
        ...(order.drafts.length ? [`Rascunhos não fechados: ${order.drafts.map((draft: any) => br(draft.date)).join(', ')}`] : []),
        ...(order.returned.length ? [`Devolvidos aguardando correção: ${order.returned.map((item: any) => `${br(item.date)} (${item.note})`).join('; ')}`] : []),
      ];
      if (!lines.length) throw new ToolRefusal(`A OS ${order.number} está com o diário em dia (o dia de hoje ainda não conta): não há o que cobrar`);
      const target = input.para === 'quem_preencheu' ? order.lastFiller : order.responsible ?? order.lastFiller;
      const who = await userContact(deps, ctx.companyId, target?.id);
      if (!who) throw new ToolRefusal(`A OS ${order.number} não tem ${input.para === 'quem_preencheu' ? 'RDO preenchido por alguém' : 'responsável'} para cobrar`);
      if (!who.email) throw new ToolRefusal(`${who.name} não tem e-mail cadastrado: cobre por outro canal`);
      const mensagem = text(input.mensagem, 600);
      return {
        summary: `Cobrar por e-mail ${who.name} (${who.email}) pelo diário da OS ${order.number}?`,
        details: [{ label: 'Obra', value: `${order.number} · ${order.title} · ${order.customer}` }, ...lines.map((value) => ({ label: 'Pendência', value })), ...(mensagem ? [{ label: 'Recado', value: mensagem }] : [])],
        payload: { orderId: order.id, number: order.number, title: order.title, email: who.email, name: who.name, lines, message: mensagem },
      };
    },
    execute: async (ctx, payload, deps) => {
      const link = `${frontUrl()}/servicos/diario-de-obra`;
      const body = [`${payload.name}, o diário da obra ${payload.number} (${payload.title}) está com pendências:`, payload.lines.map((item: string) => `• ${item}`).join('\n'), ...(payload.message ? [payload.message] : []), `Hoje é ${br(todayBr())}. Preencha e feche os RDOs no sistema.`].join('\n\n');
      try {
        await deps.notify.sendEmail(payload.email, `Diário de obra pendente — ${payload.number}`, `Diário de obra pendente: ${payload.number}`, body, link);
      } catch {
        throw new ToolRefusal('O e-mail não saiu (falha no envio). Tente de novo mais tarde.');
      }
      return { message: `Cobrança enviada para ${payload.name} (${payload.email}).`, link: `/servicos/ordens-de-servico/${payload.orderId}` };
    },
  },
];
