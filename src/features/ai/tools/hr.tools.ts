import { iso, isDate, positiveInt, text, todayBr } from './actors';
import type { ToolDeps } from './tool.deps';
import { ToolContext, ToolDefinition, ToolRefusal } from './tool.types';

/**
 * RH e Departamento Pessoal: ficha do funcionário, alocação, documentos,
 * cadastro e o histórico (férias, afastamento, atestado).
 *
 * Tudo passa pelas rotas da tela (`deps.api.call`) em nome da pessoa: as
 * permissões da rota, os dados pessoais escondidos de quem não pode ver e as
 * regras do histórico (sobreposição, admissão, desligamento) valem aqui do
 * mesmo jeito. A lista de funcionários, os vencimentos e "quem está livre" já
 * existem em read.tools (listar_funcionarios, documentos_vencendo, quem_esta_livre).
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });
const date = (description: string) => ({ type: 'string', description: `${description} (AAAA-MM-DD)` });

const CONTRACTS = ['clt', 'pj', 'temporario', 'estagio'];
const ABSENCES = ['ferias', 'afastamento', 'atestado'];
const ABSENCE_LABEL: Record<string, string> = { ferias: 'férias', afastamento: 'afastamento', atestado: 'atestado médico' };

const has = (ctx: ToolContext, ...permissions: string[]) => permissions.every((permission) => ctx.permissions.includes(permission));
const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
/** O CPF nunca vai inteiro para o modelo: só o final, para diferenciar homônimos. */
const cpfTail = (cpf: string | null | undefined) => (cpf && cpf.length >= 4 ? `***.***.*${cpf.slice(-4, -2)}-${cpf.slice(-2)}` : null);
const br = (value: string | null | undefined) => (value ? value.split('-').reverse().join('/') : '?');
const addDays = (day: string, days: number) => iso(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * 86400000))!;
const overlaps = (start: string | null, end: string | null, from: string, to: string) => !!start && start <= to && (end ?? '9999-12-31') >= from;
const link = (id: number) => `/rh/funcionarios/${id}`;

/** Acha o funcionário da empresa pelo id ou pelo nome; com nome ambíguo, recusa listando as opções. */
async function employeeOf(ctx: ToolContext, deps: ToolDeps, input: Record<string, any>) {
  const id = positiveInt(input.funcionarioId);
  if (id) {
    const row = await deps.prisma.hr_Employee.findFirst({ where: { id, companyId: ctx.companyId }, select: { id: true, name: true } });
    if (!row) throw new ToolRefusal('Funcionário não encontrado (veja o id em listar_funcionarios)');
    return row;
  }
  const name = text(input.nome, 80);
  if (name.length < 3) throw new ToolRefusal('Informe o id do funcionário ou ao menos 3 letras do nome');
  const rows = await deps.prisma.hr_Employee.findMany({
    where: { companyId: ctx.companyId, inactiveAt: null, name: { contains: name, mode: 'insensitive' } },
    select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 8,
  });
  if (!rows.length) throw new ToolRefusal(`Nenhum funcionário com "${name}" no nome`);
  if (rows.length > 1) {
    const exact = rows.filter((row) => row.name.toLowerCase() === name.toLowerCase());
    if (exact.length === 1) return exact[0];
    throw new ToolRefusal(`Mais de um funcionário com "${name}": ${rows.map((row) => `${row.name} (id ${row.id})`).join(', ')}. Pergunte qual e mande o funcionarioId.`);
  }
  return rows[0];
}

/** Funções pelo nome (cadastro de Profissionais da base de cálculo); nome desconhecido recusa com a lista. */
async function rolesOf(ctx: ToolContext, deps: ToolDeps, names: unknown, primary: unknown) {
  const wanted = (Array.isArray(names) ? names : [names]).map((name) => text(name, 80)).filter(Boolean);
  const professionals = await deps.prisma.commercial_Professional.findMany({ where: { companyId: ctx.companyId, inactiveAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const find = (name: string) => professionals.find((row) => row.name.toLowerCase() === name.toLowerCase())
    ?? (professionals.filter((row) => row.name.toLowerCase().includes(name.toLowerCase())).length === 1 ? professionals.find((row) => row.name.toLowerCase().includes(name.toLowerCase())) : undefined);
  const ids: number[] = [];
  for (const name of wanted) {
    const found = find(name);
    if (!found) throw new ToolRefusal(`Função "${name}" não está no cadastro. Funções que existem: ${professionals.map((row) => row.name).join(', ') || 'nenhuma (cadastre em Comercial → Base de cálculo)'}`);
    if (!ids.includes(found.id)) ids.push(found.id);
  }
  const primaryName = text(primary, 80);
  const primaryId = primaryName ? find(primaryName)?.id : undefined;
  if (primaryName && (!primaryId || !ids.includes(primaryId))) throw new ToolRefusal('A função principal precisa estar entre as funções informadas');
  return { roles: ids, primaryRoleId: primaryId ?? ids[0] ?? null };
}

/** O corpo do cadastro/alteração: só as chaves informadas, no formato da rota. */
async function employeeBody(ctx: ToolContext, deps: ToolDeps, input: Record<string, any>) {
  const body: Record<string, unknown> = {};
  const avisos: string[] = [];
  if (input.nome !== undefined) body.name = text(input.nome, 160);
  if (input.telefone !== undefined) body.phone = text(input.telefone, 30);
  if (input.matricula !== undefined) body.registration = text(input.matricula, 30);
  if (input.observacoes !== undefined) body.notes = text(input.observacoes, 1000);
  if (input.contrato !== undefined) {
    if (!CONTRACTS.includes(input.contrato)) throw new ToolRefusal('Contrato: clt, pj, temporario ou estagio');
    body.contractType = input.contrato;
  }
  if (input.admissao !== undefined) {
    if (input.admissao && !isDate(input.admissao)) throw new ToolRefusal('Admissão: use AAAA-MM-DD');
    body.admissionDate = input.admissao || null;
  }
  if (input.funcoes !== undefined) Object.assign(body, await rolesOf(ctx, deps, input.funcoes, input.funcaoPrincipal));
  else if (input.funcaoPrincipal !== undefined) throw new ToolRefusal('Para trocar a função principal, mande também a lista completa de funções');
  const personal: Array<[string, string]> = [['cpf', 'cpf'], ['email', 'email'], ['rg', 'rg'], ['nascimento', 'birthDate'], ['contatoEmergencia', 'emergencyName'], ['telefoneEmergencia', 'emergencyPhone']];
  const sent = personal.filter(([key]) => input[key] !== undefined);
  if (sent.length && !has(ctx, 'view_dados_pessoais_funcionarios')) {
    avisos.push(`Não gravei ${sent.map(([key]) => key).join(', ')}: dados pessoais pedem a permissão de ver dados pessoais dos funcionários.`);
  } else {
    for (const [key, field] of sent) body[field] = key === 'cpf' ? digits(input[key]) : text(input[key], 160);
    if (body.birthDate && !isDate(body.birthDate)) throw new ToolRefusal('Nascimento: use AAAA-MM-DD');
  }
  return { body, avisos };
}

/** O resumo da ficha que volta depois de cadastrar ou alterar. */
const brief = (row: any) => ({
  funcionarioId: row.id, nome: row.name, funcao: row.primaryRole, funcoes: (row.roles ?? []).map((role: any) => role.name), contrato: row.contractType,
  telefone: row.phone, matricula: row.registration, admissao: row.admissionDate, situacao: row.statusLabel, cpfFinal: cpfTail(row.cpf), email: row.email ?? undefined, link: link(row.id),
});

const EMPLOYEE_FIELDS = {
  nome: str('Nome completo'), telefone: str('Telefone com DDD'), matricula: str('Matrícula'),
  contrato: str('Vínculo', { enum: CONTRACTS }), admissao: date('Data de admissão'),
  funcoes: { type: 'array', items: { type: 'string' }, description: 'Funções pelo nome, do cadastro de profissionais (ex.: "Alpinista N2"). Substitui a lista inteira.' },
  funcaoPrincipal: str('Qual das funções é a principal (padrão: a primeira)'),
  cpf: str('CPF (dado pessoal)'), email: str('E-mail (dado pessoal)'), rg: str('RG (dado pessoal)'), nascimento: date('Nascimento (dado pessoal)'),
  contatoEmergencia: str('Nome do contato de emergência (dado pessoal)'), telefoneEmergencia: str('Telefone de emergência (dado pessoal)'),
  observacoes: str('Observações'),
};

export const HR_TOOLS: ToolDefinition[] = [
  // ------------------------------------------------------------- consultas
  {
    name: 'ver_funcionario',
    title: 'Abrindo a ficha do funcionário',
    description: 'Ficha de um funcionário (pelo id ou nome): funções, contrato, situação (ativo, férias, afastado...), histórico com ids (para encerrar_ausencia), documentos com vencimento (ids para corrigir_documento) e os que faltam, alocação de hoje e das próximas semanas (obras, atividades, turmas) e EPIs em posse. CPF só o final; dados pessoais e histórico só se a pessoa tiver permissão.',
    inputSchema: obj({ funcionarioId: int('Id do funcionário (de listar_funcionarios)'), nome: str('Nome, se não souber o id'), dias: int('Quantos dias à frente olhar a alocação (padrão 45)') }),
    permissions: ['view_funcionarios'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const { id } = await employeeOf(ctx, deps, input);
      const today = todayBr();
      const to = addDays(today, Math.min(180, Math.max(1, positiveInt(input.dias) ?? 45)));
      const optional = <T>(work: Promise<T>) => work.catch((error) => (error instanceof ToolRefusal ? null : Promise.reject(error)));
      const [row, allocation, docs, ppe]: any[] = await Promise.all([
        deps.api.call(ctx, 'GET', `employees/${id}`),
        optional(deps.api.call(ctx, 'GET', `employees/${id}/allocation`, { query: { from: today, to } })),
        has(ctx, 'view_documentos_funcionarios') ? optional(deps.api.call(ctx, 'GET', `hr-documents/employee/${id}`)) : Promise.resolve(null),
        optional(deps.api.call(ctx, 'GET', `stock/ppe/employees/${id}`)),
      ]);
      const alocacao = allocation ? [
        ...(allocation.spans ?? []).map((span: any) => ({ tipo: 'obra', o: `OS ${span.number} · ${span.title}`, cliente: span.customer, local: span.location, funcao: span.role || null, de: span.start, ate: span.end, turno: span.shift, agora: overlaps(span.start, span.end, today, today) })),
        ...(allocation.undated ?? []).map((span: any) => ({ tipo: 'obra sem data', o: `OS ${span.number} · ${span.title}`, cliente: span.customer, funcao: span.role || null })),
        ...(allocation.activities ?? []).map((span: any) => ({ tipo: 'atividade', o: span.typeName, local: span.location, de: span.start, ate: span.end, turno: span.shift, agora: overlaps(span.start, span.end, today, today) })),
        ...(allocation.classes ?? []).map((span: any) => ({ tipo: span.role === 'instrutor' ? 'dá aula' : 'treinamento', o: span.className, de: span.start, ate: span.end, agora: overlaps(span.start, span.end, today, today) })),
      ].sort((a: any, b: any) => String(a.de ?? '9').localeCompare(String(b.de ?? '9'))) : null;
      return {
        funcionarioId: row.id, nome: row.name, matricula: row.registration, telefone: row.phone, contrato: row.contractType,
        funcao: row.primaryRole, funcoes: (row.roles ?? []).map((role: any) => role.name),
        situacao: row.statusLabel, situacaoAte: row.statusUntil, admissao: row.admissionDate, desligamento: row.terminationDate, inativo: row.inactive || undefined,
        usuarioDoSistema: row.user?.name ?? null, observacoes: row.notes,
        dadosPessoais: row.canSeePersonal ? { cpfFinal: cpfTail(row.cpf), email: row.email, nascimento: row.birthDate, contatoEmergencia: row.emergencyName, telefoneEmergencia: row.emergencyPhone } : 'sem permissão',
        historico: row.canSeeOccurrences ? (row.events ?? []).slice(0, 15).map((event: any) => ({ id: event.id, tipo: event.typeLabel, de: event.startDate, ate: event.endDate, motivo: event.reason })) : undefined,
        indisponivel: (row.unavailable ?? []).map((span: any) => ({ o: span.label, de: span.startDate, ate: span.endDate })),
        alocacao: alocacao ?? 'sem permissão',
        documentos: docs ? {
          situacao: docs.statusLabel,
          vigentes: (docs.folders ?? []).flatMap((folder: any) => folder.documents.map((doc: any) => ({ documentoId: doc.id, tipo: doc.typeName, emissao: doc.issueDate, vence: doc.expiryDate, situacao: doc.statusLabel }))),
          faltando: (docs.folders ?? []).flatMap((folder: any) => folder.missing.map((miss: any) => miss.typeName)),
        } : 'sem permissão',
        epis: ppe ? (ppe.holding ?? []).map((item: any) => ({ item: item.item, quantidade: item.quantity, ca: item.caNumber, entregue: item.deliveredAt, trocarEm: item.replaceAt })) : 'sem permissão',
        link: link(row.id),
      };
    },
  },
  {
    name: 'mapa_alocacao',
    title: 'Montando o mapa de alocação',
    description: 'Quem está onde num período: por obra (OS) as pessoas escaladas, as atividades fora de obra, as turmas, quem está indisponível (férias, afastamento) e quem está livre. Para só montar escala, quem_esta_livre é mais direto.',
    inputSchema: obj({ de: date('Início (padrão: hoje)'), ate: date('Fim (padrão: 7 dias depois do início)') }),
    permissions: ['view_alocacao'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      if ((input.de && !isDate(input.de)) || (input.ate && !isDate(input.ate))) throw new ToolRefusal('Informe as datas no formato AAAA-MM-DD');
      const from = input.de ? String(input.de) : todayBr();
      const to = input.ate ? String(input.ate) : addDays(from, 6);
      const out: any = await deps.api.call(ctx, 'GET', 'employees/allocation', { query: { from, to } });
      const name = new Map<number, string>((out.employees ?? []).map((employee: any) => [employee.id, employee.name]));
      const busy = new Set<number>();
      const obras = new Map<number, { os: string; cliente: string | null; local: string | null; pessoas: unknown[] }>();
      for (const span of out.spans ?? []) {
        if (!overlaps(span.start, span.end, from, to)) continue;
        busy.add(span.employeeId);
        const obra = obras.get(span.orderId) ?? { os: `OS ${span.number} · ${span.title}`, cliente: span.customer, local: span.location, pessoas: [] };
        obra.pessoas.push({ nome: name.get(span.employeeId), funcao: span.role || null, de: span.start, ate: span.end, turno: span.shift });
        obras.set(span.orderId, obra);
      }
      const atividades = (out.activities ?? []).filter((span: any) => overlaps(span.start, span.end, from, to)).map((span: any) => {
        if (span.occupies !== false) busy.add(span.employeeId);
        return { nome: name.get(span.employeeId), atividade: span.typeName, local: span.location, de: span.start, ate: span.end, turno: span.shift };
      });
      const turmas = (out.classes ?? []).filter((span: any) => overlaps(span.start, span.end, from, to)).map((span: any) => {
        busy.add(span.employeeId);
        return { nome: name.get(span.employeeId), turma: span.className, papel: span.role, de: span.start, ate: span.end };
      });
      const indisponiveis = (out.unavailable ?? []).filter((span: any) => overlaps(span.start, span.end, from, to)).map((span: any) => {
        busy.add(span.employeeId);
        return { nome: name.get(span.employeeId), motivo: span.label, de: span.start, ate: span.end };
      });
      return {
        periodo: { de: from, ate: to },
        obras: [...obras.entries()].map(([orderId, obra]) => ({ ...obra, link: `/servicos/ordens-de-servico/${orderId}` })),
        atividades, turmas, indisponiveis,
        livres: (out.employees ?? []).filter((employee: any) => !busy.has(employee.id)).map((employee: any) => ({ id: employee.id, nome: employee.name, funcao: employee.primaryRole })),
        link: '/rh/mapa-de-alocacao',
      };
    },
  },
  {
    name: 'tipos_de_documento',
    title: 'Consultando os tipos de documento',
    description: 'Tipos de documento do RH (ASO, NRs, ficha de registro...) com pasta, se vence, validade em meses e se é obrigatório (para todos ou para certas funções).',
    inputSchema: obj({}),
    permissions: ['view_documentos_funcionarios'],
    risk: 'read',
    run: async (ctx, _input, deps) => {
      const out: any = await deps.api.call(ctx, 'GET', 'hr-documents/types');
      const roleName = new Map<number, string>((out.professionals ?? []).map((row: any) => [row.id, row.name]));
      return {
        tipos: (out.rows ?? []).map((type: any) => ({
          id: type.id, nome: type.name, pasta: type.folderName, vence: type.expires, validadeMeses: type.validityMonths, avisoDias: type.warnDays,
          obrigatorio: !type.required ? false : type.requiredProfessionalIds?.length ? `só para ${type.requiredProfessionalIds.map((id: number) => roleName.get(id) ?? id).join(', ')}` : 'para todos',
          integracao: type.inIntegration,
        })),
      };
    },
  },
  {
    name: 'atividades_funcionario',
    title: 'Consultando atividades fora de obra',
    description: 'Atividades fora de OS (aula, treinamento, atividade no CT, deslocamento, sobreaviso) num período, de todos ou de um funcionário.',
    inputSchema: obj({ funcionarioId: int('Só deste funcionário (opcional)'), de: date('Início (padrão: hoje)'), ate: date('Fim (padrão: 30 dias depois)') }),
    permissions: ['view_alocacao'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      if ((input.de && !isDate(input.de)) || (input.ate && !isDate(input.ate))) throw new ToolRefusal('Informe as datas no formato AAAA-MM-DD');
      const from = input.de ? String(input.de) : todayBr();
      const to = input.ate ? String(input.ate) : addDays(from, 30);
      const employeeId = positiveInt(input.funcionarioId);
      const out: any = await deps.api.call(ctx, 'GET', 'hr-activities', { query: { from, to } });
      const rows = (out.rows ?? []).filter((row: any) => !employeeId || (row.employees ?? []).some((employee: any) => employee.id === employeeId));
      return {
        periodo: { de: from, ate: to },
        atividades: rows.slice(0, 80).map((row: any) => ({
          id: row.id, tipo: row.typeName, local: row.location, de: row.startDate, ate: row.endDate, turno: row.shift, ocupa: row.occupies, observacoes: row.notes,
          pessoas: (row.employees ?? []).map((employee: any) => employee.name),
        })),
        link: '/rh/mapa-de-alocacao',
      };
    },
  },

  // ------------------------------------------------------------- rascunhos
  {
    name: 'cadastrar_funcionario',
    title: 'Cadastrando o funcionário',
    description: 'Cadastra um funcionário. Só o nome é obrigatório; pergunte função, contrato (clt, pj, temporario, estagio), admissão e telefone se a pessoa não disser. CPF, e-mail, RG e nascimento só são gravados por quem pode ver dados pessoais. Se já houver alguém com o mesmo nome, recusa: confirme com a pessoa e mande homonimo=true.',
    inputSchema: obj({ ...EMPLOYEE_FIELDS, homonimo: bool('true se a pessoa confirmou que é outra pessoa com o mesmo nome') }, ['nome']),
    permissions: ['create_funcionarios'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const name = text(input.nome, 160);
      if (name.length < 3) throw new ToolRefusal('Informe o nome completo');
      if (input.homonimo !== true) {
        const same = await deps.prisma.hr_Employee.findFirst({ where: { companyId: ctx.companyId, inactiveAt: null, name: { equals: name, mode: 'insensitive' } }, select: { id: true, name: true } });
        if (same) throw new ToolRefusal(`Já existe ${same.name} (id ${same.id}). Se for outra pessoa, confirme e mande homonimo=true; se for a mesma, use atualizar_funcionario.`);
      }
      const { body, avisos } = await employeeBody(ctx, deps, input);
      const created: any = await deps.api.call(ctx, 'POST', 'employees', { body });
      return { ...brief(created), avisos: avisos.length ? avisos : undefined };
    },
  },
  {
    name: 'atualizar_funcionario',
    title: 'Atualizando o funcionário',
    description: 'Altera o cadastro de um funcionário: só os campos informados mudam. funcoes substitui a lista inteira (trocar a principal fica no histórico). Dados pessoais só por quem pode vê-los. Para férias/afastamento use registrar_ausencia.',
    inputSchema: obj({ funcionarioId: int('Id do funcionário'), ...EMPLOYEE_FIELDS }, ['funcionarioId']),
    permissions: ['update_funcionarios'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const { id } = await employeeOf(ctx, deps, { funcionarioId: input.funcionarioId });
      const { body, avisos } = await employeeBody(ctx, deps, input);
      if (!Object.keys(body).length) throw new ToolRefusal(avisos[0] ?? 'Diga o que mudar');
      const updated: any = await deps.api.call(ctx, 'PUT', `employees/${id}`, { body });
      return { ...brief(updated), alterado: Object.keys(body), avisos: avisos.length ? avisos : undefined };
    },
  },
  {
    name: 'encerrar_ausencia',
    title: 'Encerrando a ausência',
    description: 'Põe a data de volta num afastamento em aberto (a pessoa voltou) ou corrige o fim de férias/afastamento. O id do registro vem do histórico em ver_funcionario.',
    inputSchema: obj({ funcionarioId: int('Id do funcionário'), registroId: int('Id do registro no histórico'), fim: date('Último dia da ausência') }, ['funcionarioId', 'registroId', 'fim']),
    permissions: ['view_funcionarios', 'update_ocorrencias_funcionarios'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const { id, name } = await employeeOf(ctx, deps, { funcionarioId: input.funcionarioId });
      if (!isDate(input.fim)) throw new ToolRefusal('Fim: use AAAA-MM-DD');
      const row: any = await deps.api.call(ctx, 'PATCH', `employees/${id}/events/${positiveInt(input.registroId) ?? 0}`, { body: { endDate: input.fim } });
      const event = (row.events ?? []).find((item: any) => item.id === Number(input.registroId));
      return { funcionario: name, registro: event ? { tipo: event.typeLabel, de: event.startDate, ate: event.endDate } : null, situacaoHoje: row.statusLabel, link: link(id) };
    },
  },
  {
    name: 'corrigir_documento',
    title: 'Corrigindo o documento',
    description: 'Corrige a emissão, o vencimento ou a observação de um documento já enviado (o id vem de ver_funcionario). Não envia arquivo: documento novo (ASO renovado etc.) é enviado pela tela, na ficha do funcionário.',
    inputSchema: obj({ documentoId: int('Id do documento'), emissao: date('Data de emissão'), vencimento: date('Data de vencimento'), observacao: str('Observação') }, ['documentoId']),
    permissions: ['update_documentos_funcionarios'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const doc = await deps.prisma.hr_EmployeeDocument.findFirst({ where: { id: positiveInt(input.documentoId) ?? 0, companyId: ctx.companyId, inactiveAt: null }, select: { id: true, employeeId: true } });
      if (!doc) throw new ToolRefusal('Documento não encontrado (veja os ids em ver_funcionario)');
      const body: Record<string, unknown> = {};
      for (const [key, field] of [['emissao', 'issueDate'], ['vencimento', 'expiryDate']] as const) {
        if (input[key] === undefined) continue;
        if (!isDate(input[key])) throw new ToolRefusal(`${key}: use AAAA-MM-DD`);
        body[field] = input[key];
      }
      if (input.observacao !== undefined) body.notes = text(input.observacao, 500);
      if (!Object.keys(body).length) throw new ToolRefusal('Diga o que corrigir (emissão, vencimento ou observação)');
      const out: any = await deps.api.call(ctx, 'PUT', `hr-documents/${doc.id}`, { body });
      const updated = (out.folders ?? []).flatMap((folder: any) => folder.documents).find((item: any) => item.id === doc.id);
      return { funcionario: out.employee?.name, documento: updated ? { documentoId: updated.id, tipo: updated.typeName, emissao: updated.issueDate, vence: updated.expiryDate, situacao: updated.statusLabel } : null, link: link(doc.employeeId) };
    },
  },

  // ------------------------------------------------------------- sensível
  {
    name: 'registrar_ausencia',
    title: 'Preparando o registro de ausência',
    description: 'Lança férias, afastamento ou atestado médico no histórico do funcionário (a pessoa fica indisponível no mapa de alocação). Férias pedem início e fim; afastamento e atestado podem ficar sem fim (encerre depois com encerrar_ausencia). Avisa se a pessoa está escalada nesse período. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      funcionarioId: int('Id do funcionário'), nome: str('Nome, se não souber o id'),
      tipo: str('O que lançar', { enum: ABSENCES }), inicio: date('Primeiro dia'), fim: date('Último dia (obrigatório nas férias)'),
      motivo: str('Motivo/observação, sem CID nem diagnóstico (ex.: "atestado de 3 dias")'),
    }, ['tipo', 'inicio']),
    permissions: ['view_funcionarios', 'update_ocorrencias_funcionarios'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const { id, name } = await employeeOf(ctx, deps, input);
      if (!ABSENCES.includes(input.tipo)) throw new ToolRefusal('Tipo: ferias, afastamento ou atestado');
      if (!isDate(input.inicio)) throw new ToolRefusal('Início: use AAAA-MM-DD');
      if (input.fim !== undefined && input.fim !== null && input.fim !== '' && !isDate(input.fim)) throw new ToolRefusal('Fim: use AAAA-MM-DD');
      const start = String(input.inicio);
      const end = input.fim ? String(input.fim) : null;
      if (input.tipo === 'ferias' && !end) throw new ToolRefusal('Férias: informe até quando');
      if (end && end < start) throw new ToolRefusal('O fim não pode ser antes do início');
      const type = input.tipo === 'ferias' ? 'ferias' : 'afastamento';
      const reason = [input.tipo === 'atestado' ? 'Atestado médico' : '', text(input.motivo, 900)].filter(Boolean).join(': ') || null;

      // mesmas regras da rota, para recusar antes do cartão (a rota confere de novo no clique)
      const row: any = await deps.api.call(ctx, 'GET', `employees/${id}`);
      if (row.admissionDate && start < row.admissionDate) throw new ToolRefusal(`Admitido(a) em ${br(row.admissionDate)}: o registro não pode ser anterior`);
      if (row.terminationDate && start > row.terminationDate) throw new ToolRefusal(`Já foi desligado(a) em ${br(row.terminationDate)}`);
      const clash = (row.events ?? []).find((event: any) => event.type === type && overlaps(event.startDate, event.endDate, start, end ?? '9999-12-31'));
      if (clash) throw new ToolRefusal(`Já existe ${clash.typeLabel.toLowerCase()} lançada nesse período (${br(clash.startDate)} a ${clash.endDate ? br(clash.endDate) : 'em aberto'})`);

      const details: { label: string; value: string }[] = [
        { label: 'Funcionário', value: `${name}${row.primaryRole ? ` (${row.primaryRole})` : ''}` },
        { label: 'Tipo', value: ABSENCE_LABEL[input.tipo] },
        { label: 'Período', value: end ? `${br(start)} a ${br(end)}` : `a partir de ${br(start)}, sem data de volta` },
      ];
      if (reason) details.push({ label: 'Motivo', value: reason });
      // escalado em obra, atividade ou turma nesse período: avisa no cartão
      const allocation: any = await deps.api.call(ctx, 'GET', `employees/${id}/allocation`, { query: { from: start, to: end ?? addDays(start, 30) } }).catch(() => null);
      const busy = allocation ? [
        ...(allocation.spans ?? []).filter((span: any) => overlaps(span.start, span.end, start, end ?? '9999-12-31')).map((span: any) => `OS ${span.number}`),
        ...(allocation.activities ?? []).filter((span: any) => span.occupies !== false && overlaps(span.start, span.end, start, end ?? '9999-12-31')).map((span: any) => span.typeName),
        ...(allocation.classes ?? []).filter((span: any) => overlaps(span.start, span.end, start, end ?? '9999-12-31')).map((span: any) => `turma ${span.className}`),
      ] : [];
      if (busy.length) details.push({ label: 'Atenção', value: `está escalado(a) nesse período: ${[...new Set(busy)].join(', ')}` });

      return {
        summary: `Lançar ${ABSENCE_LABEL[input.tipo]} de ${name} ${end ? `de ${br(start)} a ${br(end)}` : `a partir de ${br(start)}`}?`,
        details,
        payload: { employeeId: id, name, label: ABSENCE_LABEL[input.tipo], type, startDate: start, endDate: end, reason },
      };
    },
    execute: async (ctx, payload, deps) => {
      const row: any = await deps.api.call(ctx, 'POST', `employees/${payload.employeeId}/events`, {
        body: { type: payload.type, startDate: payload.startDate, endDate: payload.endDate, reason: payload.reason },
      });
      const event = (row.events ?? []).find((item: any) => item.type === payload.type && item.startDate === payload.startDate);
      return {
        message: `${payload.label[0].toUpperCase()}${payload.label.slice(1)} de ${payload.name} lançado(a) (${payload.endDate ? `${br(payload.startDate)} a ${br(payload.endDate)}` : `a partir de ${br(payload.startDate)}`}).`,
        link: link(payload.employeeId),
        data: { registroId: event?.id ?? null, situacaoHoje: row.statusLabel },
      };
    },
  },
];
