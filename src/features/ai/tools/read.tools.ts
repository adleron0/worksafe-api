import { Prisma } from '@prisma/client';
import {
  activityActor, asRefusal, employeeActor, iso, isDate, money, orderActor, plainActor, positiveInt, proposalActor, purchaseActor, resultActor, text, todayBr,
} from './actors';
import { ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Ferramentas de consulta. Devolvem resumos enxutos (o modelo paga por token):
 * só os campos que respondem perguntas, sem textos longos nem dados pessoais.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const date = (description: string) => ({ type: 'string', description: `${description} (AAAA-MM-DD)` });

const PROPOSAL_STATUS = ['rascunho', 'enviada', 'visualizada', 'aceita', 'recusada', 'expirada', 'cancelada', 'substituida'];
const ORDER_STATUS = ['a_planejar', 'agendada', 'em_execucao', 'concluida', 'encerrada', 'cancelada'];

const overlaps = (start: string | null, end: string | null, from: string, to: string) => !!start && start <= to && (end ?? start) >= from;

export const READ_TOOLS: ToolDefinition[] = [
  {
    name: 'minha_esteira',
    title: 'Olhando a sua esteira',
    description: 'Pendências da pessoa que está pedindo, por área (propostas a acompanhar, OS a planejar, documentos vencendo, contas a vencer...). Use para "o que tenho para hoje", "o que está atrasado", resumos do dia.',
    inputSchema: obj({}),
    permissions: [],
    risk: 'read',
    run: async (ctx, _input, deps) => {
      const out = await deps.pipeline.mine({ userId: ctx.userId, companyId: ctx.companyId, permissions: ctx.permissions });
      return {
        hoje: out.today,
        blocos: out.blocks.map((block) => ({
          area: block.area, titulo: block.title, quantidade: block.count, total: block.total, link: block.link,
          itens: block.items.map((item) => ({ titulo: item.title, detalhe: item.subtitle, valor: item.value, atrasado: item.late, link: item.link })),
        })),
      };
    },
  },
  {
    name: 'buscar_clientes',
    title: 'Buscando clientes',
    description: 'Procura clientes pelo nome, razão social ou cidade. Devolve id, nome e cidade. Use antes de criar proposta ou acompanhamento para achar o customerId.',
    inputSchema: obj({ busca: str('Parte do nome, razão social ou cidade') }, ['busca']),
    permissions: ['list_comercial'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const rows = (await asRefusal(() => deps.proposals.customers(proposalActor(ctx), text(input.busca, 80)))) as any[];
      return { clientes: (rows ?? []).slice(0, 15).map((row) => ({ id: row.id, nome: row.name, razaoSocial: row.corporateName ?? null, cidade: row.city ?? row.cityName ?? null })) };
    },
  },
  {
    name: 'listar_propostas',
    title: 'Consultando propostas',
    description: 'Lista propostas comerciais (só as que a pessoa pode ver), com filtros. Devolve número, cliente, situação, total, validade, próximo retorno e o resumo por situação.',
    inputSchema: obj({
      situacao: str('Filtra pela situação', { enum: PROPOSAL_STATUS }),
      busca: str('Número, título ou cliente'),
      tipo: str('Tipo da proposta', { enum: ['servico', 'treinamento', 'locacao'] }),
      clienteId: int('Id do cliente'),
      pagina: int('Página, começando em 0'),
    }),
    permissions: ['list_comercial'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const query: Record<string, string> = { limit: '20', page: String(Math.max(0, Number(input.pagina) || 0)) };
      if (input.situacao) query.status = String(input.situacao);
      if (input.busca) query.search = text(input.busca, 80);
      if (input.tipo) query.kind = String(input.tipo);
      if (positiveInt(input.clienteId)) query.customerId = String(input.clienteId);
      const out = await asRefusal(() => deps.proposals.list(proposalActor(ctx), query));
      // resumo como lista com nome legível: modelos menores pulavam chaves do objeto (ex.: o rascunho)
      const summary = Object.entries((out.summary ?? {}) as Record<string, { count: number; total: number }>)
        .map(([situacao, v]) => ({ situacao, quantidade: v.count, valorTotal: money(v.total) }))
        .sort((a, b) => PROPOSAL_STATUS.indexOf(a.situacao) - PROPOSAL_STATUS.indexOf(b.situacao));
      return {
        total: out.total,
        resumoPorSituacao: summary,
        observacao: input.situacao ? undefined : 'O resumo por situação inclui TODAS as situações, inclusive rascunhos: cite cada linha do resumo. A lista abaixo não traz as versões substituídas (peça situacao=substituida para vê-las).',
        propostas: out.rows.map((row: any) => ({
          id: row.id, numero: row.number, revisao: row.revision, tipo: row.kind, situacao: row.status, titulo: row.title, cliente: row.customer?.name ?? null,
          total: money(row.total), validade: row.validUntil, vencida: row.expired, vendedor: row.seller, enviadaEm: iso(row.sentAt),
          proximoRetorno: row.followUp?.next ?? null, link: `/comercial/propostas/${row.id}`,
        })),
      };
    },
  },
  {
    name: 'ver_proposta',
    title: 'Abrindo a proposta',
    description: 'Detalhes de uma proposta: cliente, contato, situação, seções e itens com valores, parcelas, validade e totais (custos e margem só se a pessoa pode ver custos).',
    inputSchema: obj({ propostaId: int('Id da proposta (o número do link /comercial/propostas/ID)'), numero: str('Ou o código da proposta, ex.: PC-2026-0004 ou PC-2026-0002-R1') }),
    permissions: ['list_comercial'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      let id = positiveInt(input.propostaId);
      const code = text(input.numero ?? (typeof input.propostaId === 'string' && /[a-z]/i.test(input.propostaId) ? input.propostaId : ''), 30).toUpperCase();
      if (!id && code) {
        const found = await deps.prisma.commercial_Proposal.findFirst({ where: { companyId: ctx.companyId, number: { equals: code, mode: 'insensitive' } }, orderBy: { inactiveAt: { sort: 'asc', nulls: 'first' } }, select: { id: true } })
          ?? await deps.prisma.commercial_Proposal.findFirst({ where: { companyId: ctx.companyId, number: { startsWith: code, mode: 'insensitive' } }, orderBy: { id: 'desc' }, select: { id: true } });
        if (!found) throw new ToolRefusal(`Não há proposta com o código ${code}. Confira o código ou procure com listar_propostas (busca).`);
        id = found.id;
      }
      if (!id) throw new ToolRefusal('Informe o id ou o código da proposta (ex.: PC-2026-0004)');
      const row: any = await asRefusal(() => deps.proposals.get(proposalActor(ctx), id));
      const inactiveAt = row.inactiveAt ?? (await deps.prisma.commercial_Proposal.findUnique({ where: { id }, select: { inactiveAt: true } }))?.inactiveAt;
      return {
        ...(inactiveAt ? { excluida: true, aviso: `Esta proposta foi EXCLUÍDA em ${iso(inactiveAt)}: não ofereça enviar, editar nem mudar a situação; diga que ela foi excluída.` } : {}),
        id: row.id, numero: row.number, revisao: row.revision, tipo: row.kind, situacao: row.status, titulo: row.title,
        cliente: row.customer ? { id: row.customer.id, nome: row.customer.name } : row.customerId,
        contato: { nome: row.contactName ?? null, email: row.contactEmail ?? null },
        validade: row.validUntil ?? null, prazoDiasUteis: row.workDays ?? null, descricao: text(row.description, 600) || null,
        secoes: (row.sections ?? []).map((section: any) => ({
          titulo: section.title, tipo: section.kind,
          itens: (section.items ?? []).map((item: any) => ({ descricao: item.description, quantidade: item.quantity, unidade: item.unit, valor: money(item.total ?? item.finalValue ?? item.price) })),
        })),
        parcelas: (row.installments ?? []).map((inst: any) => ({ percentual: inst.percent, valor: inst.amount, regra: inst.dueRule, dias: inst.dueDays, percentualObra: inst.workPercent ?? undefined, vencimento: inst.dueDate })),
        totais: row.result ? { total: money(row.result.total ?? row.total), custo: row.result.cost ?? undefined, margem: row.result.margin ?? undefined } : { total: money(row.total) },
        link: `/comercial/propostas/${row.id}`,
      };
    },
  },
  {
    name: 'opcoes_proposta',
    title: 'Carregando a base de cálculo',
    description: 'O que é preciso para montar uma proposta: profissionais (funções de mão de obra, com id), cursos (com id) e padrões da base de cálculo. Use antes de simular ou criar uma proposta.',
    inputSchema: obj({}),
    permissions: ['list_comercial'],
    risk: 'read',
    run: async (ctx, _input, deps) => {
      const out: any = await asRefusal(() => deps.proposals.options(proposalActor(ctx), {}));
      return {
        profissionais: (out.professionals ?? []).map((row: any) => ({ id: row.id, nome: row.name })),
        cursos: (out.courses ?? []).map((row: any) => ({ id: row.id, nome: row.name, preco: row.price ?? null })),
        padroes: out.defaults ? { validadeDias: out.defaults.validityDays ?? null, imprevisibilidade: out.defaults.contingencyRate ?? null } : null,
      };
    },
  },
  {
    name: 'simular_proposta',
    title: 'Calculando a proposta',
    description: 'Calcula o valor de uma proposta SEM gravar nada, pela base de cálculo da empresa. Use para responder "quanto fica" antes de criar o rascunho. Mesmos campos de criar_rascunho_proposta.',
    inputSchema: obj({
      clienteId: int('Id do cliente'),
      tipo: str('Tipo', { enum: ['servico', 'treinamento', 'locacao'] }),
      itens: { type: 'array', items: { type: 'object' }, description: 'Itens como em criar_rascunho_proposta' },
      prazoDiasUteis: int('Prazo em dias úteis'),
    }, ['itens']),
    permissions: ['list_comercial'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const { proposalBody } = await import('./write.tools');
      const body = proposalBody({ ...input, titulo: 'Simulação' });
      const out: any = await asRefusal(() => deps.proposals.preview(proposalActor(ctx), body));
      const result = out.result ?? out;
      return { total: money(result.total), subtotal: result.subtotal ?? undefined, impostos: result.taxes ?? undefined, custo: result.cost ?? undefined, margem: result.margin ?? undefined };
    },
  },
  {
    name: 'listar_acompanhamentos',
    title: 'Consultando o acompanhamento',
    description: 'Contatos e retornos marcados com clientes (ligação, WhatsApp, reunião, visita...). Filtra por situação: pendentes, atrasadas, hoje, proximas, feitas.',
    inputSchema: obj({
      situacao: str('Quais', { enum: ['pendentes', 'atrasadas', 'hoje', 'proximas', 'feitas'] }),
      propostaId: int('Só desta proposta'),
      clienteId: int('Só deste cliente'),
    }),
    permissions: ['list_comercial'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const query: Record<string, string> = { limit: '30' };
      if (input.situacao) query.status = String(input.situacao);
      if (positiveInt(input.propostaId)) query.proposalId = String(input.propostaId);
      if (positiveInt(input.clienteId)) query.customerId = String(input.clienteId);
      const out = await asRefusal(() => deps.activities.list(activityActor(ctx), query));
      return {
        total: out.total, resumo: out.summary,
        itens: out.rows.map((row: any) => ({
          id: row.id, tipo: row.type, assunto: row.subject, cliente: row.customer?.name ?? row.customerName ?? null, proposta: row.proposal?.number ?? null,
          marcadoPara: row.dueDate ?? null, hora: row.dueTime ?? null, feitoEm: row.doneAt ?? null, responsavel: row.user?.name ?? row.userName ?? null, atrasado: !!row.overdue,
        })),
      };
    },
  },
  {
    name: 'listar_os',
    title: 'Consultando ordens de serviço',
    description: 'Lista ordens de serviço (só as que a pessoa pode ver) por etapa: a_planejar, agendada, em_execucao, concluida, encerrada, cancelada. Devolve número, cliente, datas e responsável.',
    inputSchema: obj({ etapa: str('Etapa', { enum: ORDER_STATUS }), busca: str('Número, título ou cliente'), pagina: int('Página, começando em 0') }),
    permissions: ['list_ordens_de_servico'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const query: Record<string, string> = { limit: '25', page: String(Math.max(0, Number(input.pagina) || 0)) };
      if (input.etapa) query.status = String(input.etapa);
      if (input.busca) query.search = text(input.busca, 80);
      const out: any = await asRefusal(() => deps.orders.list(orderActor(ctx), query));
      return {
        total: out.total, resumoPorEtapa: out.summary ?? out.groups ?? undefined,
        ordens: (out.rows ?? []).map((row: any) => ({
          id: row.id, numero: row.number, titulo: row.title, etapa: row.status, cliente: row.customer?.name ?? row.customerName ?? null,
          inicioPrevisto: iso(row.plannedStart), fimPrevisto: iso(row.plannedEnd), inicio: iso(row.startedAt), fim: iso(row.finishedAt),
          responsavel: row.responsible?.name ?? row.responsibleName ?? null, local: row.location ?? null, link: `/servicos/ordens-de-servico/${row.id}`,
        })),
      };
    },
  },
  {
    name: 'ver_os',
    title: 'Abrindo a ordem de serviço',
    description: 'Detalhes de uma OS: cliente, etapa, datas, equipe escalada, checklist e local.',
    inputSchema: obj({ osId: int('Id da OS') }, ['osId']),
    permissions: ['list_ordens_de_servico'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.osId);
      if (!id) throw new ToolRefusal('Informe o id da OS');
      const row: any = await asRefusal(() => deps.orders.get(orderActor(ctx), id));
      return {
        id: row.id, numero: row.number, titulo: row.title, etapa: row.status, cliente: row.customer?.name ?? null, proposta: row.proposal?.number ?? null,
        inicioPrevisto: iso(row.plannedStart), fimPrevisto: iso(row.plannedEnd), inicio: iso(row.startedAt), fim: iso(row.finishedAt), local: row.location ?? null,
        equipe: (row.team ?? []).map((member: any) => ({ funcionarioId: member.employeeId ?? null, nome: member.name, funcao: member.role ?? member.professionalName ?? null, de: member.from ?? null, ate: member.to ?? null })),
        checklist: (row.checklist ?? []).map((item: any) => ({ item: item.label ?? item.text, feito: !!item.done })),
        link: `/servicos/ordens-de-servico/${row.id}`,
      };
    },
  },
  {
    name: 'resultado_obras',
    title: 'Calculando o resultado das obras',
    description: 'Resultado das OS: receita, custo, lucro e margem orçados × realizados × projetados (custos só para quem pode ver custos). Use para relatórios de desempenho.',
    inputSchema: obj({ etapa: str('Etapa das OS', { enum: ORDER_STATUS }) }),
    permissions: ['list_ordens_de_servico'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const query: Record<string, string> = { limit: '30' };
      if (input.etapa) query.status = String(input.etapa);
      const out: any = await asRefusal(() => deps.results.list(resultActor(ctx), query));
      const fig = (f: any) => (f ? { receita: money(f.revenue), custo: f.cost === undefined ? undefined : money(f.cost), lucro: f.profit === undefined ? undefined : money(f.profit), margem: f.margin ?? null } : null);
      return {
        totais: out.totals ? { obras: out.totals.orders, orcado: fig(out.totals.budget), realizado: fig(out.totals.realized), projetado: fig(out.totals.projected), abaixoDoOrcado: out.totals.below } : undefined,
        obras: (out.rows ?? []).slice(0, 30).map((row: any) => ({
          id: row.id, numero: row.number, titulo: row.title, cliente: row.customer, etapa: row.status, avanco: row.progress,
          orcado: fig(row.budget), realizado: fig(row.realized), projetado: fig(row.projected), link: `/servicos/ordens-de-servico/${row.id}`,
        })),
      };
    },
  },
  {
    name: 'quem_esta_livre',
    title: 'Vendo quem está livre',
    description: 'Funcionários livres num período (sem obra, atividade, turma, férias ou afastamento), com a função principal. Também diz quem está ocupado e com o quê. Use para montar escala.',
    inputSchema: obj({ de: date('Início do período'), ate: date('Fim do período'), funcao: str('Filtra pela função (parte do nome)') }, ['de', 'ate']),
    permissions: ['view_alocacao'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      if (!isDate(input.de) || !isDate(input.ate)) throw new ToolRefusal('Informe as datas no formato AAAA-MM-DD');
      const from = String(input.de);
      const to = String(input.ate);
      const out: any = await asRefusal(() => deps.employees.allocation(employeeActor(ctx), { from, to }));
      const busy = new Map<number, string[]>();
      const mark = (employeeId: number, label: string) => busy.set(employeeId, [...(busy.get(employeeId) ?? []), label]);
      for (const span of out.spans ?? []) if (overlaps(span.start, span.end, from, to)) mark(span.employeeId, `OS ${span.number} (${span.title})`);
      for (const span of out.activities ?? []) if (span.occupies !== false && overlaps(span.start, span.end, from, to)) mark(span.employeeId, span.typeName);
      for (const span of out.classes ?? []) if (overlaps(span.start, span.end, from, to)) mark(span.employeeId, `Turma ${span.className} (${span.role})`);
      for (const span of out.unavailable ?? []) if (overlaps(span.start, span.end ?? to, from, to)) mark(span.employeeId, span.label);
      const role = text(input.funcao, 60).toLowerCase();
      const people = (out.employees ?? []).filter((employee: any) => !role || (employee.roles ?? []).some((r: any) => String(r.name).toLowerCase().includes(role)));
      return {
        periodo: { de: from, ate: to },
        livres: people.filter((employee: any) => !busy.has(employee.id)).map((employee: any) => ({ id: employee.id, nome: employee.name, funcao: employee.primaryRole, situacao: employee.statusLabel })),
        ocupados: people.filter((employee: any) => busy.has(employee.id)).map((employee: any) => ({ id: employee.id, nome: employee.name, funcao: employee.primaryRole, com: busy.get(employee.id) })),
      };
    },
  },
  {
    name: 'listar_funcionarios',
    title: 'Consultando funcionários',
    description: 'Funcionários com função principal, tipo de contrato e situação (ativo, férias, afastado...). Sem dados pessoais.',
    inputSchema: obj({ busca: str('Parte do nome'), situacao: str('Situação (ativo, ferias, afastado, desligado...)') }),
    permissions: ['list_funcionarios'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const query: Record<string, string> = {};
      if (input.busca) query.search = text(input.busca, 80);
      if (input.situacao) query.status = text(input.situacao, 20);
      const out: any = await asRefusal(() => deps.employees.list({ ...employeeActor(ctx), seesPersonal: false }, query));
      return {
        total: out.total ?? out.rows?.length, resumo: out.summary,
        funcionarios: (out.rows ?? []).slice(0, 60).map((row: any) => ({ id: row.id, nome: row.name, funcao: row.primaryRole, contrato: row.contractType, situacao: row.statusLabel, ate: row.statusUntil })),
      };
    },
  },
  {
    name: 'documentos_vencendo',
    title: 'Conferindo documentos da equipe',
    description: 'Documentos de funcionários vencidos, a vencer ou obrigatórios faltando (ASO, NR35, NR33...).',
    inputSchema: obj({ situacao: str('Quais', { enum: ['vencido', 'a_vencer', 'faltando'] }), busca: str('Nome do funcionário') }),
    permissions: ['view_documentos_funcionarios'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const query: Record<string, string> = {};
      if (input.situacao) query.status = String(input.situacao);
      if (input.busca) query.search = text(input.busca, 80);
      const out: any = await asRefusal(() => deps.documents.expiring(plainActor(ctx), query));
      return {
        hoje: out.today, resumo: out.summary, total: out.total,
        documentos: (out.rows ?? []).slice(0, 60).map((row: any) => ({ funcionario: row.employee?.name, documento: row.typeName ?? row.type?.name, situacao: row.status, vence: row.expiryDate ?? row.expiresAt ?? null })),
      };
    },
  },
  {
    name: 'listar_turmas',
    title: 'Consultando turmas',
    description: 'Turmas de treinamento com curso, datas, vagas, inscritos confirmados e se estão abertas no site. Por padrão, as que ainda não terminaram.',
    inputSchema: obj({ busca: str('Nome da turma ou do curso'), incluirPassadas: { type: 'boolean', description: 'Incluir turmas já encerradas' } }),
    permissions: ['list_classes'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const term = text(input.busca, 80);
      const where: Prisma.CourseClassWhereInput = {
        companyId: ctx.companyId, inactiveAt: null,
        ...(input.incluirPassadas ? {} : { OR: [{ finalDate: null }, { finalDate: { gte: new Date(`${todayBr()}T00:00:00Z`) } }] }),
        ...(term ? { AND: [{ OR: [{ name: { contains: term, mode: 'insensitive' } }, { course: { name: { contains: term, mode: 'insensitive' } } }] }] } : {}),
      };
      const rows = await deps.prisma.courseClass.findMany({
        where, orderBy: [{ initialDate: 'asc' }, { id: 'asc' }], take: 40,
        select: {
          id: true, name: true, initialDate: true, finalDate: true, maxSubscriptions: true, unlimitedSubscriptions: true, openClass: true, active: true, price: true, discountPrice: true,
          city: true, course: { select: { name: true } }, customer: { select: { name: true } },
          _count: { select: { subscriptions: { where: { subscribeStatus: 'confirmed', inactiveAt: null } } } },
        },
      });
      return {
        turmas: rows.map((row) => ({
          id: row.id, nome: row.name, curso: row.course?.name ?? null, inicio: iso(row.initialDate), fim: iso(row.finalDate), cidade: row.city,
          vagas: row.unlimitedSubscriptions ? 'ilimitadas' : row.maxSubscriptions, inscritosConfirmados: row._count.subscriptions,
          abertaNoSite: !!row.openClass && row.active, fechadaParaCliente: row.customer?.name ?? null,
          preco: row.price === null ? null : money(row.price), precoPromocional: row.discountPrice === null ? null : money(row.discountPrice),
          link: `/treinamentos/turmas/${row.id}`,
        })),
      };
    },
  },
  {
    name: 'contas_a_receber',
    title: 'Consultando contas a receber',
    description: 'Recebíveis por situação e período de vencimento: em aberto, vencidos e recebidos, com totais. Use para fluxo de caixa e cobranças.',
    inputSchema: obj({ situacao: str('Quais', { enum: ['aberto', 'vencido', 'recebido'] }), de: date('Vencimento a partir de'), ate: date('Vencimento até') }),
    permissions: ['list_financeiro'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const today = new Date(`${todayBr()}T00:00:00Z`);
      const due: Prisma.DateTimeNullableFilter = {};
      if (isDate(input.de)) due.gte = new Date(`${input.de}T00:00:00Z`);
      if (isDate(input.ate)) due.lte = new Date(`${input.ate}T23:59:59Z`);
      const status: Prisma.FinancialRecordsWhereInput =
        input.situacao === 'recebido' ? { status: 'received' }
          : input.situacao === 'vencido' ? { status: { in: ['waiting', 'overdue', 'processing'] }, dueDate: { lt: today } }
            : { status: { in: ['waiting', 'overdue', 'processing'] } };
      const where: Prisma.FinancialRecordsWhereInput = { companyId: ctx.companyId, inactiveAt: null, ...status, ...(Object.keys(due).length ? { dueDate: { ...(status.dueDate as object), ...due } } : {}) };
      const [rows, sum] = await Promise.all([
        deps.prisma.financialRecords.findMany({
          where, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: 40,
          select: { id: true, description: true, value: true, dueDate: true, paidAt: true, status: true, invoiceNumber: true, customer: { select: { name: true } }, trainee: { select: { name: true } } },
        }),
        deps.prisma.financialRecords.aggregate({ where, _sum: { value: true }, _count: { _all: true } }),
      ]);
      return {
        quantidade: sum._count._all, total: money(sum._sum.value),
        contas: rows.map((row) => ({
          id: row.id, descricao: row.description, de: row.customer?.name ?? row.trainee?.name ?? null, valor: money(row.value), vencimento: iso(row.dueDate), recebidoEm: iso(row.paidAt),
          situacao: row.status, vencida: row.status !== 'received' && !!row.dueDate && row.dueDate < today, nf: row.invoiceNumber,
        })),
      };
    },
  },
  {
    name: 'contas_a_pagar',
    title: 'Consultando contas a pagar',
    description: 'Contas a pagar em aberto (ou pagas) por período de vencimento, com fornecedor e totais, mais o resumo do mês.',
    inputSchema: obj({ situacao: str('Quais', { enum: ['aberta', 'vencida', 'paga'] }), de: date('Vencimento a partir de'), ate: date('Vencimento até') }),
    permissions: ['list_financeiro'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const today = new Date(`${todayBr()}T00:00:00Z`);
      const where: Prisma.Financial_PayableWhereInput = {
        companyId: ctx.companyId, inactiveAt: null,
        status: input.situacao === 'paga' ? 'paga' : 'aberta',
        ...(input.situacao === 'vencida' ? { dueDate: { lt: today } } : {}),
      };
      if (isDate(input.de) || isDate(input.ate)) {
        where.dueDate = { ...(where.dueDate as object), ...(isDate(input.de) ? { gte: new Date(`${input.de}T00:00:00Z`) } : {}), ...(isDate(input.ate) ? { lte: new Date(`${input.ate}T23:59:59Z`) } : {}) };
      }
      const [rows, sum, month] = await Promise.all([
        deps.prisma.financial_Payable.findMany({ where, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: 40, select: { id: true, description: true, value: true, dueDate: true, paidAt: true, status: true, supplier: { select: { name: true } } } }),
        deps.prisma.financial_Payable.aggregate({ where, _sum: { value: true }, _count: { _all: true } }),
        deps.payables.summary(ctx.companyId).catch(() => null),
      ]);
      return {
        quantidade: sum._count._all, total: money(sum._sum.value), resumoDoMes: month,
        contas: rows.map((row) => ({ id: row.id, descricao: row.description, fornecedor: row.supplier?.name ?? null, valor: money(row.value), vencimento: iso(row.dueDate), pagaEm: iso(row.paidAt), vencida: row.status === 'aberta' && row.dueDate < today })),
      };
    },
  },
  {
    name: 'listar_pedidos_de_compra',
    title: 'Consultando pedidos de compra',
    description: 'Pedidos de compra por situação (solicitado, aprovado, comprado, recebido, recusado, cancelado), com OS, fornecedor e valor.',
    inputSchema: obj({ situacao: str('Situação', { enum: ['solicitado', 'aprovado', 'comprado', 'recebido', 'recusado', 'cancelado'] }), busca: str('Número ou descrição') }),
    permissions: ['list_pedidos_de_compra'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const query: Record<string, string> = { limit: '30' };
      if (input.situacao) query.status = String(input.situacao);
      if (input.busca) query.search = text(input.busca, 80);
      const out: any = await asRefusal(() => deps.purchases.list(purchaseActor(ctx), query));
      return {
        total: out.total, resumo: out.summary,
        pedidos: (out.rows ?? []).map((row: any) => ({ id: row.id, numero: row.number, situacao: row.status, descricao: row.title ?? row.description, os: row.serviceOrder?.number ?? null, fornecedor: row.supplier?.name ?? null, total: row.total === undefined ? undefined : money(row.total) })),
      };
    },
  },
  {
    name: 'listar_posts_blog',
    title: 'Consultando o blog',
    description: 'Posts do blog com situação (rascunho, publicado), data e visualizações.',
    inputSchema: obj({ situacao: str('Situação', { enum: ['draft', 'published', 'archived'] }), busca: str('Parte do título') }),
    permissions: ['list_blog'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const term = text(input.busca, 80);
      const rows = await deps.prisma.blog_Post.findMany({
        where: { companyId: ctx.companyId, inactiveAt: null, ...(input.situacao ? { status: input.situacao as any } : {}), ...(term ? { title: { contains: term, mode: 'insensitive' } } : {}) },
        orderBy: [{ updatedAt: 'desc' }], take: 30,
        select: { id: true, title: true, slug: true, status: true, publishedAt: true, viewCount: true, category: { select: { name: true } } },
      });
      return { posts: rows.map((row) => ({ id: row.id, titulo: row.title, situacao: row.status, categoria: row.category?.name ?? null, publicadoEm: iso(row.publishedAt), visualizacoes: row.viewCount, link: "/blog/posts" })) };
    },
  },
];
