import { Prisma } from '@prisma/client';
import { CacheService } from 'src/common/cache/cache.service';
import { iso, isDate, positiveInt, text, todayBr } from './actors';
import type { ToolDeps } from './tool.deps';
import { ToolContext, ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Treinamentos, além de alunos e inscrições (training.tools): reciclagem
 * (certificados vencendo), cursos, instrutores livres, lista de presença,
 * resultado de prova, emissão e reenvio de certificados, cancelamento de
 * inscrição e vagas reservadas por empresas.
 *
 * As escritas vão pelas rotas da tela (`deps.api.call`): presença pelo upsert
 * da lista, prova pelo crud de exames, emissão pela emissão seletiva da turma,
 * reenvio pelo envio por e-mail, cancelamento pelo PUT da inscrição (com as
 * travas de certificado/presença/prova do crud). O que a tela recusa, a
 * ferramenta recusa.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });
const date = (description: string) => ({ type: 'string', description: `${description} (AAAA-MM-DD)` });
const ints = (description: string) => ({ type: 'array', items: { type: 'integer' }, description });

const CLASSES_CACHE = ['training-classes:*', 'cache:*/classes*', 'subscription:*', 'cache:*/subscription*'];
const STATUS_LABEL: Record<string, string> = { confirmed: 'confirmada', pending: 'pendente', declined: 'recusada' };

/** O CPF nunca vai inteiro para o modelo: só o final, para diferenciar homônimos. */
const cpfTail = (cpf: string | null | undefined) => (cpf && cpf.length >= 4 ? `***.***.*${cpf.slice(-4, -2)}-${cpf.slice(-2)}` : null);
const br = (value: string | null | undefined) => (value ? value.split('-').reverse().join('/') : '?');
const brDate = (value: Date | null | undefined) => br(iso(value));
const addDays = (day: string, days: number) => iso(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * 86400000))!;
const dayStart = (day: string) => new Date(`${day}T00:00:00Z`);
const dayEnd = (day: string) => new Date(`${day}T23:59:59.999Z`);
const classLink = (id: number) => `/treinamentos/turmas/${id}`;
const names = (list: string[], max = 12) => (list.length > max ? `${list.slice(0, max).join(', ')} e mais ${list.length - max}` : list.join(', '));

async function evict() {
  const cache = new CacheService();
  for (const pattern of CLASSES_CACHE) await cache.reset(pattern).catch(() => undefined);
}

async function classOf(ctx: ToolContext, deps: ToolDeps, id: unknown) {
  const turma = await deps.prisma.courseClass.findFirst({
    where: { id: positiveInt(id) ?? 0, companyId: ctx.companyId, inactiveAt: null },
    select: {
      id: true, name: true, courseId: true, initialDate: true, finalDate: true, daysDuration: true, allowExam: true, certificateId: true,
      course: { select: { name: true } }, customer: { select: { name: true, corporateName: true } },
    },
  });
  if (!turma) throw new ToolRefusal('Turma não encontrada (veja o id em listar_turmas)');
  return turma;
}

/** Inscrições confirmadas da turma (as que entram na presença, prova e certificado). */
async function confirmedOf(deps: ToolDeps, classId: number) {
  return deps.prisma.courseClassSubscription.findMany({
    where: { classId, subscribeStatus: 'confirmed', inactiveAt: null },
    orderBy: { name: 'asc' }, take: 300,
    select: { id: true, name: true, cpf: true, traineeId: true, trainee: { select: { name: true } } },
  });
}

/** Dias da turma (a tela numera de 1 a daysDuration). */
const daysOf = (turma: { daysDuration: number | null }) => Math.max(1, turma.daysDuration ?? 1);

/** Período a partir da entrada; sem nada, o padrão pedido. */
function period(input: Record<string, any>, from: string, to: string) {
  const de = input.de ? String(input.de) : from;
  const ate = input.ate ? String(input.ate) : to;
  if (!isDate(de) || !isDate(ate)) throw new ToolRefusal('Datas no formato AAAA-MM-DD');
  if (de > ate) throw new ToolRefusal('A data inicial é depois da final');
  return { de, ate };
}

export const TRAINING_EXTRA_TOOLS: ToolDefinition[] = [
  // ------------------------------------------------------------- consultas
  {
    name: 'certificados_vencendo',
    title: 'Conferindo certificados vencendo',
    description: 'Certificados de alunos que vencem (ou já venceram) num período: base da reciclagem. Traz aluno, contato, curso, turma e a empresa do aluno, com um resumo por empresa (útil ao Comercial para oferecer reciclagem). Padrão: vencidos nos últimos 30 dias e a vencer nos próximos 60. Por padrão esconde quem já renovou (tem certificado mais novo do mesmo curso).',
    inputSchema: obj({
      de: date('Vencimento a partir de'), ate: date('Vencimento até'),
      curso: str('Parte do nome do curso'), clienteId: int('Só os alunos desta empresa cliente (de buscar_clientes)'),
      incluirRenovados: bool('Mostrar também quem já renovou'),
    }),
    permissions: ['list_classes'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const today = todayBr();
      const { de, ate } = period(input, addDays(today, -30), addDays(today, 60));
      const course = text(input.curso, 80);
      const rows = await deps.prisma.traineeCourseCertificate.findMany({
        where: {
          companyId: ctx.companyId, inactiveAt: null, expirationDate: { gte: dayStart(de), lte: dayEnd(ate) },
          ...(course ? { course: { name: { contains: course, mode: 'insensitive' } } } : {}),
        },
        orderBy: { expirationDate: 'asc' }, take: 300,
        select: {
          id: true, traineeId: true, courseId: true, classId: true, expirationDate: true,
          trainee: { select: { name: true, cpf: true, email: true, phone: true } },
          course: { select: { name: true } },
          class: { select: { name: true, customer: { select: { id: true, name: true } } } },
        },
      });
      // renovou = tem outro certificado do mesmo curso vencendo depois deste
      const newer = rows.length ? await deps.prisma.traineeCourseCertificate.findMany({
        where: { companyId: ctx.companyId, inactiveAt: null, OR: rows.map((row) => ({ traineeId: row.traineeId, courseId: row.courseId, expirationDate: { gt: row.expirationDate! } })) },
        select: { traineeId: true, courseId: true },
      }) : [];
      const renewed = new Set(newer.map((row) => `${row.traineeId}-${row.courseId}`));
      // a empresa do aluno vem da inscrição (contratante da vaga ou digitada); turma fechada, do cliente da turma
      const subs = rows.length ? await deps.prisma.courseClassSubscription.findMany({
        where: { OR: rows.map((row) => ({ classId: row.classId, traineeId: row.traineeId })), inactiveAt: null },
        select: { classId: true, traineeId: true, workedAt: true, customer: { select: { id: true, name: true } }, reservation: { select: { customer: { select: { id: true, name: true } } } } },
      }) : [];
      const companyOf = (row: (typeof rows)[number]) => {
        const sub = subs.find((item) => item.classId === row.classId && item.traineeId === row.traineeId);
        const customer = sub?.customer ?? sub?.reservation?.customer ?? row.class?.customer ?? null;
        return { id: customer?.id ?? null, nome: customer?.name ?? sub?.workedAt ?? null };
      };
      const clienteId = positiveInt(input.clienteId);
      const list = rows
        .map((row) => ({ row, empresa: companyOf(row), renovou: renewed.has(`${row.traineeId}-${row.courseId}`) }))
        .filter((item) => (input.incluirRenovados ? true : !item.renovou))
        .filter((item) => (clienteId ? item.empresa.id === clienteId : true));
      const byCompany = new Map<string, { empresa: string; clienteId: number | null; vencidos: number; aVencer: number }>();
      for (const item of list) {
        const key = item.empresa.id ? `c${item.empresa.id}` : `t${item.empresa.nome ?? '-'}`;
        const entry = byCompany.get(key) ?? { empresa: item.empresa.nome ?? 'sem empresa (particular)', clienteId: item.empresa.id, vencidos: 0, aVencer: 0 };
        if (iso(item.row.expirationDate)! < today) entry.vencidos++; else entry.aVencer++;
        byCompany.set(key, entry);
      }
      return {
        periodo: { de, ate }, hoje: today, total: list.length,
        vencidos: list.filter((item) => iso(item.row.expirationDate)! < today).length,
        porEmpresa: [...byCompany.values()].sort((a, b) => b.vencidos + b.aVencer - (a.vencidos + a.aVencer)),
        certificados: list.slice(0, 80).map(({ row, empresa, renovou }) => ({
          certificadoId: row.id, alunoId: row.traineeId, aluno: row.trainee?.name, cpfFinal: cpfTail(row.trainee?.cpf), email: row.trainee?.email ?? null, telefone: row.trainee?.phone ?? null,
          curso: row.course?.name, turma: row.class?.name, turmaId: row.classId, vence: iso(row.expirationDate),
          situacao: iso(row.expirationDate)! < today ? 'vencido' : 'a vencer', empresa: empresa.nome, clienteId: empresa.id, ...(renovou ? { jaRenovou: true } : {}),
        })),
        aviso: list.length > 80 ? `Mostrando 80 de ${list.length}: filtre por curso, empresa ou período.` : undefined,
        link: '/treinamentos/certificados',
      };
    },
  },
  {
    name: 'listar_cursos',
    title: 'Consultando os cursos',
    description: 'Cursos cadastrados com carga horária, validade do certificado (anos), se têm prova e quantas turmas estão por vir. Use para saber o id do curso, a validade (reciclagem) ou o que a empresa oferece.',
    inputSchema: obj({ busca: str('Parte do nome do curso'), incluirInativos: bool('Incluir cursos desativados') }),
    permissions: ['list_treinamentos'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const term = text(input.busca, 80);
      const today = dayStart(todayBr());
      const rows = await deps.prisma.course.findMany({
        where: { companyId: ctx.companyId, inactiveAt: null, ...(input.incluirInativos ? {} : { active: true }), ...(term ? { name: { contains: term, mode: 'insensitive' } } : {}) },
        orderBy: { name: 'asc' }, take: 60,
        select: {
          id: true, name: true, hoursDuration: true, yearOfValidation: true, active: true, exam: true, slug: true,
          _count: { select: { classes: { where: { inactiveAt: null, OR: [{ finalDate: null }, { finalDate: { gte: today } }] } }, certificates: { where: { inactiveAt: null } } } },
        },
      });
      return {
        cursos: rows.map((row) => ({
          id: row.id, nome: row.name, cargaHoraria: row.hoursDuration, validadeAnos: row.yearOfValidation ?? null, ativo: row.active,
          temProva: Array.isArray(row.exam) ? row.exam.length > 0 : !!row.exam, modelosDeCertificado: row._count.certificates,
          turmasPorVir: row._count.classes, paginaNoSite: row.slug ? `/cursos/${row.slug}` : null,
        })),
        link: '/treinamentos/cursos',
      };
    },
  },
  {
    name: 'instrutores_disponiveis',
    title: 'Vendo instrutores livres',
    description: 'Instrutores ativos livres e ocupados num período (pelas turmas em que estão escalados). Mande turmaId para usar as datas da turma (mostra também quem já está nela) ou de/ate.',
    inputSchema: obj({ turmaId: int('Usar as datas desta turma'), de: date('Início do período'), ate: date('Fim do período') }),
    permissions: ['list_instrutores', 'list_classes'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      let de: string; let ate: string; let classId: number | null = null;
      if (input.turmaId) {
        const turma = await classOf(ctx, deps, input.turmaId);
        if (!turma.initialDate) throw new ToolRefusal('A turma não tem data de início: informe de/ate');
        classId = turma.id;
        de = iso(turma.initialDate)!; ate = iso(turma.finalDate ?? turma.initialDate)!;
      } else {
        if (!input.de) throw new ToolRefusal('Informe a turma ou o período (de/ate)');
        ({ de, ate } = period(input, String(input.de), String(input.ate ?? input.de)));
      }
      const instructors = await deps.prisma.instructor.findMany({
        where: { companyId: ctx.companyId, inactiveAt: null, active: true }, orderBy: { name: 'asc' }, take: 100,
        select: {
          id: true, name: true, formation: true, phone: true,
          classes: {
            where: { inactiveAt: null, class: { inactiveAt: null, companyId: ctx.companyId, initialDate: { lte: dayEnd(ate) }, OR: [{ finalDate: { gte: dayStart(de) } }, { finalDate: null, initialDate: { gte: dayStart(de) } }] } },
            select: { class: { select: { id: true, name: true, initialDate: true, finalDate: true } } },
          },
        },
      });
      const busy = (row: (typeof instructors)[number]) => row.classes.filter((item) => item.class.id !== classId);
      return {
        periodo: { de, ate },
        disponiveis: instructors.filter((row) => !busy(row).length).map((row) => ({ instrutorId: row.id, nome: row.name, formacao: row.formation, telefone: row.phone, ...(classId && row.classes.some((item) => item.class.id === classId) ? { jaNaTurma: true } : {}) })),
        ocupados: instructors.filter((row) => busy(row).length).map((row) => ({
          instrutorId: row.id, nome: row.name,
          turmas: busy(row).map((item) => ({ turmaId: item.class.id, turma: item.class.name, inicio: iso(item.class.initialDate), fim: iso(item.class.finalDate) })),
        })),
        link: '/treinamentos/instrutores',
      };
    },
  },
  {
    name: 'lista_de_presenca',
    title: 'Abrindo a lista de presença',
    description: 'Lista de presença de uma turma: os inscritos confirmados com os dias em que estão presentes (dias numerados de 1 até a duração da turma) e o total de presentes por dia.',
    inputSchema: obj({ turmaId: int('Id da turma (de listar_turmas)') }, ['turmaId']),
    permissions: ['list_classes'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const turma = await classOf(ctx, deps, input.turmaId);
      const days = daysOf(turma);
      const subs = await confirmedOf(deps, turma.id);
      const marks = await deps.prisma.courseClassAttendanceList.findMany({
        where: { classId: turma.id, inactiveAt: null, IsPresent: true }, select: { traineeId: true, day: true },
      });
      const presentDays = (traineeId: number | null) => (traineeId ? [...new Set(marks.filter((row) => row.traineeId === traineeId && row.day <= days).map((row) => row.day))].sort((a, b) => a - b) : []);
      return {
        turma: { id: turma.id, nome: turma.name, inicio: iso(turma.initialDate), fim: iso(turma.finalDate), dias: days },
        porDia: Array.from({ length: days }, (_, index) => ({ dia: index + 1, presentes: new Set(marks.filter((row) => row.day === index + 1).map((row) => row.traineeId)).size })),
        alunos: subs.map((sub) => {
          const present = presentDays(sub.traineeId);
          return {
            inscricaoId: sub.id, alunoId: sub.traineeId, nome: sub.trainee?.name ?? sub.name, cpfFinal: cpfTail(sub.cpf),
            diasPresente: present, faltas: days - present.length, ...(sub.traineeId ? {} : { aviso: 'sem cadastro de aluno: confirme a inscrição de novo' }),
          };
        }),
        link: classLink(turma.id),
      };
    },
  },
  {
    name: 'vagas_empresas_turma',
    title: 'Consultando vagas de empresas',
    description: 'Vagas reservadas por empresas em turmas abertas: quantas vagas cada empresa tem, quantas já têm aluno, quantas sobram, a venda de origem e os alunos. Mande turmaId (todas as empresas da turma) ou clienteId (todas as reservas da empresa).',
    inputSchema: obj({ turmaId: int('Id da turma'), clienteId: int('Id do cliente (de buscar_clientes)'), incluirCanceladas: bool('Mostrar reservas canceladas') }),
    permissions: [],
    anyPermissions: ['list_classes', 'list_comercial'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const classId = positiveInt(input.turmaId);
      const customerId = positiveInt(input.clienteId);
      if (!classId && !customerId) throw new ToolRefusal('Informe a turma ou o cliente');
      const rows: any[] = await deps.api.call(ctx, 'GET', 'class-reservations', { query: { classId, customerId, includeCancelled: input.incluirCanceladas ? 'true' : undefined } });
      const seats = rows[0]?.classSeats;
      return {
        ...(classId && seats ? { vagasDaTurma: { limite: seats.max ?? 'ilimitado', confirmadas: seats.confirmed, reservadasParaEmpresas: seats.reserved, livres: seats.free ?? 'ilimitadas' } } : {}),
        reservas: rows.map((row) => ({
          reservaId: row.id, turmaId: row.classId, turma: row.class?.name, inicio: iso(row.class?.initialDate), empresa: row.customer?.name, clienteId: row.customerId,
          vagas: row.seats, comAluno: row.used, sobrando: row.open, venda: row.contract?.number ?? null, ...(row.cancelled ? { cancelada: true, motivo: row.cancelReason } : {}),
          alunos: (row.students ?? []).map((student: any) => ({ inscricaoId: student.id, nome: student.name })),
        })),
        aviso: rows.length ? undefined : 'Nenhuma vaga reservada por empresa.',
        link: classId ? classLink(classId) : '/treinamentos/turmas',
      };
    },
  },

  // ------------------------------------------------------------- rascunhos
  {
    name: 'registrar_presenca',
    title: 'Marcando presença',
    description: 'Marca (ou desmarca) a presença de inscritos confirmados num dia da turma (dia 1 = primeiro dia). Mande inscricaoIds (de lista_de_presenca) ou todos=true para a turma inteira. presente=false desmarca.',
    inputSchema: obj({
      turmaId: int('Id da turma'), dia: int('Dia da turma (1, 2, ...)'),
      inscricaoIds: ints('Inscrições a marcar'), todos: bool('Todos os confirmados da turma'),
      presente: bool('true marca presença (padrão), false desmarca'),
    }, ['turmaId', 'dia']),
    permissions: ['create_classes'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const turma = await classOf(ctx, deps, input.turmaId);
      const days = daysOf(turma);
      const day = positiveInt(input.dia);
      if (!day || day > days) throw new ToolRefusal(`Dia inválido: a turma tem ${days} dia(s), de 1 a ${days}`);
      const subs = await confirmedOf(deps, turma.id);
      const wanted = Array.isArray(input.inscricaoIds) ? input.inscricaoIds.map(Number) : [];
      if (!input.todos && !wanted.length) throw new ToolRefusal('Informe as inscrições (inscricaoIds) ou todos=true');
      const chosen = input.todos ? subs : subs.filter((sub) => wanted.includes(sub.id));
      const unknown = input.todos ? [] : wanted.filter((id) => !subs.some((sub) => sub.id === id));
      if (unknown.length) throw new ToolRefusal(`Inscrição(ões) ${unknown.join(', ')} não estão confirmadas nesta turma (veja lista_de_presenca)`);
      const noTrainee = chosen.filter((sub) => !sub.traineeId);
      const present = input.presente !== false;
      const done: string[] = [];
      for (const sub of chosen.filter((item) => item.traineeId)) {
        await deps.api.call(ctx, 'POST', 'attendance-list/upsert', { body: { classId: turma.id, traineeId: sub.traineeId, day, IsPresent: present } });
        done.push(sub.trainee?.name ?? sub.name);
      }
      return {
        turma: turma.name, dia: day, presente: present, marcados: done.length, alunos: done,
        ...(noTrainee.length ? { naoMarcados: noTrainee.map((sub) => sub.name), aviso: 'Inscrições sem cadastro de aluno não entram na presença' } : {}),
        link: classLink(turma.id),
      };
    },
  },
  {
    name: 'registrar_resultado_prova',
    title: 'Registrando o resultado da prova',
    description: 'Registra o resultado (aprovado ou reprovado) de uma prova feita fora do sistema (em papel, prática) para um inscrito confirmado. O sistema não guarda nota numérica avulsa: só aprovado/reprovado. Se o aluno já tem prova registrada (ex.: prova online), recusa: altere pela tela.',
    inputSchema: obj({ inscricaoId: int('Id da inscrição (de listar_inscritos)'), aprovado: bool('true aprovado, false reprovado') }, ['inscricaoId', 'aprovado']),
    permissions: ['create_classes'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      if (typeof input.aprovado !== 'boolean') throw new ToolRefusal('Diga se foi aprovado (true) ou reprovado (false)');
      const sub = await deps.prisma.courseClassSubscription.findFirst({
        where: { id: positiveInt(input.inscricaoId) ?? 0, class: { companyId: ctx.companyId }, inactiveAt: null },
        select: { id: true, name: true, subscribeStatus: true, traineeId: true, classId: true, class: { select: { name: true, courseId: true } } },
      });
      if (!sub) throw new ToolRefusal('Inscrição não encontrada');
      if (sub.subscribeStatus !== 'confirmed' || !sub.traineeId) throw new ToolRefusal('Só inscrição confirmada (com aluno cadastrado) pode ter prova');
      const existing = await deps.prisma.courseClassExam.findFirst({ where: { traineeId: sub.traineeId, classId: sub.classId, inactiveAt: null }, select: { id: true, result: true } });
      if (existing) throw new ToolRefusal(`${sub.name} já tem prova registrada nesta turma (${existing.result ? 'aprovado' : 'reprovado'}). Para mudar, use a tela de exames.`);
      const created: any = await deps.api.call(ctx, 'POST', 'exames', {
        body: { traineeId: sub.traineeId, classId: sub.classId, courseId: sub.class!.courseId, result: input.aprovado, examResponses: [] },
      });
      return { provaId: Number(created?.id ?? created?.data?.id) || null, aluno: sub.name, turma: sub.class?.name, resultado: input.aprovado ? 'aprovado' : 'reprovado', link: classLink(sub.classId) };
    },
  },

  // ------------------------------------------------------------- sensíveis
  {
    name: 'emitir_certificados',
    title: 'Preparando a emissão de certificados',
    description: 'Emite os certificados de uma turma para os inscritos confirmados que ainda não têm. Se a turma tem prova, só os aprovados. Com exigirPresenca, só quem tem presença em todos os dias. inscricaoIds restringe a alguns alunos. Mostra quem fica de fora e por quê. Precisa da confirmação no cartão.',
    inputSchema: obj({
      turmaId: int('Id da turma'), inscricaoIds: ints('Só estas inscrições (opcional)'),
      exigirPresenca: bool('Só quem tem presença em todos os dias'),
    }, ['turmaId']),
    permissions: ['create_classes'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const turma = await classOf(ctx, deps, input.turmaId);
      if (!turma.certificateId) throw new ToolRefusal('A turma não tem modelo de certificado: escolha o modelo na tela da turma antes de emitir');
      const days = daysOf(turma);
      const wanted = Array.isArray(input.inscricaoIds) ? input.inscricaoIds.map(Number) : [];
      const subs = (await confirmedOf(deps, turma.id)).filter((sub) => !wanted.length || wanted.includes(sub.id));
      if (!subs.length) throw new ToolRefusal(wanted.length ? 'Nenhuma dessas inscrições está confirmada nesta turma' : 'A turma não tem inscritos confirmados');
      const traineeIds = subs.map((sub) => sub.traineeId).filter((id): id is number => !!id);
      const where = { classId: turma.id, traineeId: { in: traineeIds }, inactiveAt: null };
      const [certificates, exams, marks] = await Promise.all([
        deps.prisma.traineeCourseCertificate.findMany({ where, select: { traineeId: true } }),
        deps.prisma.courseClassExam.findMany({ where: { ...where, result: true }, select: { traineeId: true } }),
        deps.prisma.courseClassAttendanceList.findMany({ where: { ...where, IsPresent: true }, select: { traineeId: true, day: true } }),
      ]);
      const out: { name: string; reason: string }[] = [];
      const go: typeof subs = [];
      for (const sub of subs) {
        const name = sub.trainee?.name ?? sub.name;
        if (!sub.traineeId) out.push({ name, reason: 'sem cadastro de aluno' });
        else if (certificates.some((row) => row.traineeId === sub.traineeId)) out.push({ name, reason: 'já tem certificado' });
        else if (turma.allowExam && !exams.some((row) => row.traineeId === sub.traineeId)) out.push({ name, reason: 'sem prova aprovada' });
        else if (input.exigirPresenca && new Set(marks.filter((row) => row.traineeId === sub.traineeId && row.day <= days).map((row) => row.day)).size < days) out.push({ name, reason: 'faltou algum dia' });
        else go.push(sub);
      }
      if (!go.length) throw new ToolRefusal(`Ninguém para emitir: ${out.map((row) => `${row.name} (${row.reason})`).join('; ')}`);
      const goNames = go.map((sub) => sub.trainee?.name ?? sub.name);
      const details = [
        { label: 'Turma', value: `${turma.name} — ${turma.course?.name ?? ''} (${brDate(turma.initialDate)} a ${brDate(turma.finalDate)})` },
        { label: 'Recebem', value: names(goNames) },
      ];
      if (out.length) details.push({ label: 'Ficam de fora', value: names(out.map((row) => `${row.name} (${row.reason})`)) });
      return {
        summary: `Emitir ${go.length} certificado(s) da turma "${turma.name}"?`,
        details,
        payload: { classId: turma.id, className: turma.name, subscriptionIds: go.map((sub) => sub.id) },
      };
    },
    execute: async (ctx, payload, deps) => {
      // quem ganhou certificado entre o cartão e o clique não é reemitido
      const subs = await deps.prisma.courseClassSubscription.findMany({ where: { id: { in: payload.subscriptionIds }, classId: payload.classId, subscribeStatus: 'confirmed', inactiveAt: null }, select: { id: true, traineeId: true } });
      const issued = await deps.prisma.traineeCourseCertificate.findMany({ where: { classId: payload.classId, inactiveAt: null, traineeId: { in: subs.map((sub) => sub.traineeId!).filter(Boolean) } }, select: { traineeId: true } });
      const ids = subs.filter((sub) => sub.traineeId && !issued.some((row) => row.traineeId === sub.traineeId)).map((sub) => sub.id);
      if (!ids.length) return { message: `Nada a emitir: os alunos já têm certificado na turma "${payload.className}".`, link: classLink(payload.classId) };
      const out: any = await deps.api.call(ctx, 'POST', `classes/generate-certificates-selective/${payload.classId}`, { body: { subscriptionIds: ids } });
      await evict();
      const made = Number(out?.data?.newCertificates ?? ids.length);
      return { message: `${made} certificado(s) emitido(s) na turma "${payload.className}".`, link: classLink(payload.classId), data: { emitidos: made, inscricoes: ids } };
    },
  },
  {
    name: 'reenviar_certificado',
    title: 'Preparando o reenvio do certificado',
    description: 'Manda por e-mail ao aluno o link do certificado já emitido (pelo e-mail configurado da empresa). Mande certificadoId (de certificados_vencendo) ou alunoId + turmaId. Precisa da confirmação no cartão.',
    inputSchema: obj({ certificadoId: int('Id do certificado'), alunoId: int('Id do aluno'), turmaId: int('Id da turma') }),
    permissions: ['update_classes'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const id = positiveInt(input.certificadoId);
      const where: Prisma.TraineeCourseCertificateWhereInput = id
        ? { id, companyId: ctx.companyId, inactiveAt: null }
        : { traineeId: positiveInt(input.alunoId) ?? 0, classId: positiveInt(input.turmaId) ?? 0, companyId: ctx.companyId, inactiveAt: null };
      if (!id && !(positiveInt(input.alunoId) && positiveInt(input.turmaId))) throw new ToolRefusal('Informe o certificadoId ou o aluno e a turma');
      const cert = await deps.prisma.traineeCourseCertificate.findFirst({
        where, select: { id: true, key: true, traineeId: true, classId: true, expirationDate: true, trainee: { select: { name: true, email: true } }, course: { select: { name: true } }, class: { select: { name: true } } },
      });
      if (!cert) throw new ToolRefusal('Certificado não encontrado (ou cancelado)');
      if (!cert.trainee?.email) throw new ToolRefusal(`${cert.trainee?.name ?? 'O aluno'} não tem e-mail no cadastro: atualize o aluno antes de reenviar`);
      const company = await deps.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { email_conection: true } });
      if (!company?.email_conection) throw new ToolRefusal('A empresa não tem e-mail de envio configurado (Configurações da empresa → e-mail): não dá para reenviar');
      return {
        summary: `Reenviar o certificado de ${cert.trainee.name} (${cert.course?.name ?? 'curso'}) para ${cert.trainee.email}?`,
        details: [
          { label: 'Turma', value: cert.class?.name ?? '?' },
          { label: 'Validade', value: cert.expirationDate ? brDate(cert.expirationDate) : 'sem vencimento' },
        ],
        payload: { certificateId: cert.id, traineeId: cert.traineeId, key: cert.key, classId: cert.classId, name: cert.trainee.name, email: cert.trainee.email },
      };
    },
    execute: async (ctx, payload, deps) => {
      const cert = await deps.prisma.traineeCourseCertificate.findFirst({ where: { id: payload.certificateId, companyId: ctx.companyId, inactiveAt: null }, select: { id: true } });
      if (!cert) throw new ToolRefusal('O certificado foi cancelado: peça de novo');
      await deps.api.call(ctx, 'POST', 'trainee-certificate/send-email', { body: { traineeId: payload.traineeId, certificateKey: payload.key } });
      return { message: `Certificado de ${payload.name} enviado para ${payload.email}.`, link: classLink(payload.classId) };
    },
  },
  {
    name: 'cancelar_inscricao',
    title: 'Preparando o cancelamento da inscrição',
    description: 'Cancela (recusa) uma inscrição: libera a vaga. Não dá se o aluno já tem certificado, presença ou prova na turma. Não mexe no financeiro: avisa se há pagamento ou cobrança para estornar/cancelar lá. Precisa da confirmação no cartão.',
    inputSchema: obj({ inscricaoId: int('Id da inscrição (de listar_inscritos)'), motivo: str('Motivo do cancelamento (fica gravado na inscrição)') }, ['inscricaoId']),
    permissions: ['update_classes'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const sub = await deps.prisma.courseClassSubscription.findFirst({
        where: { id: positiveInt(input.inscricaoId) ?? 0, class: { companyId: ctx.companyId } },
        select: {
          id: true, name: true, cpf: true, subscribeStatus: true, traineeId: true, classId: true, inactiveAt: true, reservationId: true,
          class: { select: { name: true } }, reservation: { select: { customer: { select: { name: true } } } },
          financialRecords: { where: { inactiveAt: null }, select: { id: true, status: true, gateway: true } },
        },
      });
      if (!sub) throw new ToolRefusal('Inscrição não encontrada');
      if (sub.subscribeStatus === 'declined' || sub.inactiveAt) throw new ToolRefusal('Esta inscrição já está cancelada');
      if (sub.subscribeStatus === 'confirmed' && sub.traineeId) {
        const where = { traineeId: sub.traineeId, classId: sub.classId, inactiveAt: null };
        if (await deps.prisma.traineeCourseCertificate.findFirst({ where, select: { id: true } })) throw new ToolRefusal('O aluno já tem certificado emitido nesta turma: não dá para cancelar a inscrição');
        if (await deps.prisma.courseClassAttendanceList.findFirst({ where, select: { id: true } })) throw new ToolRefusal('O aluno já tem presença registrada nesta turma: não dá para cancelar a inscrição');
        if (await deps.prisma.courseClassExam.findFirst({ where, select: { id: true } })) throw new ToolRefusal('O aluno já fez prova nesta turma: não dá para cancelar a inscrição');
      }
      const details = [
        { label: 'Aluno', value: `${sub.name} (CPF ${cpfTail(sub.cpf) ?? '?'})` },
        { label: 'Situação atual', value: STATUS_LABEL[sub.subscribeStatus] ?? sub.subscribeStatus },
      ];
      if (sub.reservationId) details.push({ label: 'Vaga da empresa', value: `${sub.reservation?.customer?.name ?? 'reserva'}: a vaga volta para a reserva` });
      const paid = sub.financialRecords.filter((row) => row.status === 'received');
      const open = sub.financialRecords.filter((row) => ['waiting', 'processing', 'overdue'].includes(row.status));
      if (paid.length) details.push({ label: 'Atenção', value: `há pagamento recebido (${paid.map((row) => `#${row.id}`).join(', ')}): o estorno/reembolso é no financeiro` });
      if (open.length) details.push({ label: 'Atenção', value: `há cobrança em aberto (${open.map((row) => `#${row.id}`).join(', ')}): cancele no financeiro para não cobrar` });
      const reason = text(input.motivo, 200);
      if (reason) details.push({ label: 'Motivo', value: reason });
      return {
        summary: `Cancelar a inscrição de ${sub.name} na turma "${sub.class?.name}"?`,
        details,
        payload: { subscriptionId: sub.id, classId: sub.classId, name: sub.name, className: sub.class?.name, reason: reason || null },
      };
    },
    execute: async (ctx, payload, deps) => {
      await deps.api.call(ctx, 'PUT', `subscription/${payload.subscriptionId}`, { body: { subscribeStatus: 'declined', ...(payload.reason ? { declinedReason: payload.reason } : {}) } });
      await evict();
      return { message: `Inscrição de ${payload.name} cancelada na turma "${payload.className}". A vaga foi liberada.`, link: classLink(payload.classId), data: { inscricaoId: payload.subscriptionId } };
    },
  },
];
