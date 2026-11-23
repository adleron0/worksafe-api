import { Prisma } from '@prisma/client';
import { CacheService } from 'src/common/cache/cache.service';
import { isValidCPF } from 'src/validators/is-cpf.constraint';
import { seatsOfClass } from 'src/features/training/reservation/seats';
import { brl, isDate, iso, money, positiveInt, text, todayBr } from './actors';
import type { ToolDeps } from './tool.deps';
import { ToolContext, ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Alunos e inscrições pela Lia (e pelo MCP). A inscrição vai pela mesma rota
 * da tela (POST/PUT /subscription, com as regras do crud: CPF único na turma,
 * limite de vagas, reserva de empresa, aluno criado pelo CPF). O "já pago"
 * lança o recebível manual e dá a baixa pelas rotas do financeiro.
 * Nada aqui duplica regra: o que a tela recusa, a ferramenta recusa.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });

const PAYMENT_METHODS = ['pix', 'cartaoCredito', 'boleto', 'transferencia', 'dinheiro', 'outro'];
const PAYMENT_LABEL: Record<string, string> = { pix: 'Pix', cartaoCredito: 'cartão de crédito', boleto: 'boleto', transferencia: 'transferência', dinheiro: 'dinheiro', outro: 'outra forma' };
const STATUS_LABEL: Record<string, string> = { confirmed: 'confirmada', pending: 'pendente', declined: 'recusada' };
const CLASSES_CACHE = ['training-classes:*', 'cache:*/classes*', 'subscription:*', 'cache:*/subscription*'];

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
/** O CPF nunca vai inteiro para o modelo: só o final, para diferenciar homônimos. */
const cpfTail = (cpf: string | null | undefined) => (cpf && cpf.length >= 4 ? `***.***.*${cpf.slice(-4, -2)}-${cpf.slice(-2)}` : null);
const brDate = (value: Date | null | undefined) => (value ? iso(value)!.split('-').reverse().join('/') : '?');
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

async function evict() {
  const cache = new CacheService();
  for (const pattern of CLASSES_CACHE) await cache.reset(pattern).catch(() => undefined);
}

async function classOf(ctx: ToolContext, deps: ToolDeps, id: unknown) {
  const turma = await deps.prisma.courseClass.findFirst({
    where: { id: positiveInt(id) ?? 0, companyId: ctx.companyId, inactiveAt: null },
    select: { id: true, name: true, initialDate: true, finalDate: true, price: true, discountPrice: true, course: { select: { name: true } } },
  });
  if (!turma) throw new ToolRefusal('Turma não encontrada (veja o id em listar_turmas)');
  return turma;
}

/** Aluno da empresa: ligado a ela ou com inscrição numa turma dela. */
const traineeOfCompany = (companyId: number): Prisma.TraineeWhereInput => ({
  inactiveAt: null,
  OR: [{ traineeCompany: { some: { companyId } } }, { subscription: { some: { class: { companyId } } } }],
});

const seatsLine = (seats: Awaited<ReturnType<typeof seatsOfClass>>) =>
  !seats ? null : { limite: seats.max ?? 'ilimitado', confirmadas: seats.confirmed, reservadasParaEmpresas: seats.reserved, livres: seats.free ?? 'ilimitadas' };

const has = (ctx: ToolContext, ...permissions: string[]) => permissions.every((permission) => ctx.permissions.includes(permission));

export const TRAINING_TOOLS: ToolDefinition[] = [
  // ------------------------------------------------------------- consultas
  {
    name: 'buscar_aluno',
    title: 'Procurando o aluno',
    description: 'Procura alunos pelo CPF (só números ou com pontos) ou pelo nome. Devolve o id do aluno, contato e as turmas em que já se inscreveu. Use antes de cadastrar ou inscrever, para não duplicar.',
    inputSchema: obj({ busca: str('CPF ou parte do nome') }, ['busca']),
    permissions: ['list_classes'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const term = text(input.busca, 80);
      const cpf = digits(term);
      const byCpf = cpf.length === 11;
      if (!byCpf && term.length < 3) throw new ToolRefusal('Informe o CPF ou ao menos 3 letras do nome');
      const match: Prisma.TraineeWhereInput = byCpf ? { cpf } : { name: { contains: term, mode: 'insensitive' } };
      const rows = await deps.prisma.trainee.findMany({
        where: { AND: [traineeOfCompany(ctx.companyId), match] }, orderBy: { name: 'asc' }, take: 10,
        select: {
          id: true, name: true, cpf: true, email: true, phone: true, occupation: true,
          subscription: {
            where: { class: { companyId: ctx.companyId } }, orderBy: { id: 'desc' }, take: 6,
            select: { id: true, subscribeStatus: true, class: { select: { id: true, name: true, initialDate: true } } },
          },
        },
      });
      // inscrição pendente do site ainda não tem aluno: aparece à parte
      const loose = await deps.prisma.courseClassSubscription.findMany({
        where: { class: { companyId: ctx.companyId }, traineeId: null, inactiveAt: null, ...(byCpf ? { cpf } : { name: { contains: term, mode: 'insensitive' } }) },
        orderBy: { id: 'desc' }, take: 10,
        select: { id: true, name: true, cpf: true, email: true, phone: true, subscribeStatus: true, class: { select: { id: true, name: true, initialDate: true } } },
      });
      return {
        alunos: rows.map((row) => ({
          alunoId: row.id, nome: row.name, cpfFinal: cpfTail(row.cpf), email: row.email, telefone: row.phone, profissao: row.occupation,
          inscricoes: row.subscription.map((sub) => ({ inscricaoId: sub.id, turmaId: sub.class?.id, turma: sub.class?.name, inicio: iso(sub.class?.initialDate), situacao: STATUS_LABEL[sub.subscribeStatus] })),
        })),
        inscricoesSemCadastro: loose.map((sub) => ({
          inscricaoId: sub.id, nome: sub.name, cpfFinal: cpfTail(sub.cpf), email: sub.email, telefone: sub.phone, turmaId: sub.class?.id, turma: sub.class?.name, situacao: STATUS_LABEL[sub.subscribeStatus],
        })),
        aviso: rows.length || loose.length ? undefined : 'Nenhum aluno encontrado: dá para cadastrar (cadastrar_aluno) ou inscrever direto (inscrever_na_turma).',
      };
    },
  },
  {
    name: 'listar_inscritos',
    title: 'Consultando os inscritos',
    description: 'Inscritos de uma turma com situação (confirmada/pendente), empresa, pagamento, presença, prova e certificado, mais as vagas (limite, confirmadas, reservadas para empresas, livres). Por padrão não mostra as recusadas.',
    inputSchema: obj({ turmaId: int('Id da turma (de listar_turmas)'), situacao: str('Filtrar', { enum: ['confirmadas', 'pendentes', 'todas'] }) }, ['turmaId']),
    permissions: ['list_classes'],
    risk: 'read',
    run: async (ctx, input, deps) => {
      const turma = await classOf(ctx, deps, input.turmaId);
      const status: Prisma.CourseClassSubscriptionWhereInput = input.situacao === 'confirmadas' ? { subscribeStatus: 'confirmed' } : input.situacao === 'pendentes' ? { subscribeStatus: 'pending' } : {};
      const subs = await deps.prisma.courseClassSubscription.findMany({
        where: { classId: turma.id, inactiveAt: null, ...status }, orderBy: [{ subscribeStatus: 'asc' }, { name: 'asc' }], take: 200,
        select: {
          id: true, name: true, cpf: true, email: true, phone: true, subscribeStatus: true, origin: true, traineeId: true, workedAt: true,
          customer: { select: { name: true } }, reservation: { select: { id: true, customer: { select: { name: true } } } },
          financialRecords: { where: { inactiveAt: null }, select: { status: true, value: true, receivedValue: true, paymentMethod: true } },
        },
      });
      const traineeIds = subs.map((sub) => sub.traineeId).filter((id): id is number => !!id);
      const where = { classId: turma.id, traineeId: { in: traineeIds }, inactiveAt: null };
      const [presences, exams, certificates] = traineeIds.length ? await Promise.all([
        deps.prisma.courseClassAttendanceList.groupBy({ by: ['traineeId'], where: { ...where, IsPresent: true }, _count: { _all: true } }),
        deps.prisma.courseClassExam.findMany({ where, select: { traineeId: true, result: true }, orderBy: { id: 'desc' } }),
        deps.prisma.traineeCourseCertificate.findMany({ where, select: { traineeId: true } }),
      ]) : [[], [], []];
      const days = turma.initialDate && turma.finalDate ? Math.round((turma.finalDate.getTime() - turma.initialDate.getTime()) / 86400000) + 1 : null;
      const payment = (records: { status: string; value: unknown; receivedValue: unknown; paymentMethod: string }[]) => {
        const paid = records.filter((row) => row.status === 'received');
        if (paid.length) return { situacao: 'pago', valor: money(paid.reduce((sum, row) => sum + Number(row.receivedValue ?? row.value ?? 0), 0)), forma: PAYMENT_LABEL[paid[0].paymentMethod] ?? paid[0].paymentMethod };
        if (records.some((row) => ['waiting', 'processing', 'overdue'].includes(row.status))) return { situacao: 'em aberto' };
        return { situacao: 'sem lançamento' };
      };
      const inscritos = subs.map((sub) => {
        const exam = sub.traineeId ? exams.find((row) => row.traineeId === sub.traineeId) : undefined;
        return {
          inscricaoId: sub.id, alunoId: sub.traineeId, nome: sub.name, cpfFinal: cpfTail(sub.cpf), email: sub.email, telefone: sub.phone,
          situacao: STATUS_LABEL[sub.subscribeStatus], empresa: sub.customer?.name ?? sub.reservation?.customer?.name ?? sub.workedAt ?? null,
          vagaDaEmpresa: sub.reservation ? sub.reservation.customer?.name ?? true : false, origem: sub.origin,
          pagamento: payment(sub.financialRecords as any),
          diasPresente: sub.traineeId ? presences.find((row) => row.traineeId === sub.traineeId)?._count._all ?? 0 : 0,
          prova: exam ? (exam.result ? 'aprovado' : 'reprovado') : null,
          certificado: sub.traineeId ? certificates.some((row) => row.traineeId === sub.traineeId) : false,
        };
      });
      return {
        turma: { id: turma.id, nome: turma.name, curso: turma.course?.name ?? null, inicio: iso(turma.initialDate), fim: iso(turma.finalDate), dias: days },
        vagas: seatsLine(await seatsOfClass(deps.prisma, turma.id)),
        totais: { confirmadas: subs.filter((sub) => sub.subscribeStatus === 'confirmed').length, pendentes: subs.filter((sub) => sub.subscribeStatus === 'pending').length },
        inscritos, link: `/treinamentos/turmas/${turma.id}`,
      };
    },
  },

  // ------------------------------------------------------------- rascunhos
  {
    name: 'cadastrar_aluno',
    title: 'Cadastrando o aluno',
    description: 'Cadastra um aluno (nome, CPF, e-mail, telefone). Se o CPF já existir, só devolve o aluno que já está lá (não sobrescreve os dados). Não inscreve em turma: para isso, inscrever_na_turma.',
    inputSchema: obj({ nome: str('Nome completo'), cpf: str('CPF'), email: str('E-mail'), telefone: str('Telefone com DDD'), profissao: str('Cargo/profissão') }, ['nome', 'cpf']),
    permissions: ['create_classes'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const cpf = digits(input.cpf);
      if (!isValidCPF(cpf)) throw new ToolRefusal('CPF inválido: confira os números com a pessoa');
      const name = text(input.nome, 100);
      if (name.length < 3) throw new ToolRefusal('Informe o nome completo');
      const email = text(input.email, 255).toLowerCase();
      if (email && !validEmail(email)) throw new ToolRefusal('E-mail inválido');
      const phone = digits(input.telefone).slice(0, 20);
      // mesmo jeito da reserva de vagas: aluno é um só por CPF, ligado à empresa
      const out = await deps.prisma.$transaction(async (tx) => {
        const found = await tx.trainee.findFirst({ where: { cpf }, select: { id: true, name: true, email: true, phone: true } });
        const row = found ?? await tx.trainee.create({ data: { name, cpf, email: email || null, phone: phone || null, occupation: text(input.profissao, 255) || null }, select: { id: true, name: true, email: true, phone: true } });
        await tx.traineeCompany.upsert({ where: { traineeId_companyId: { traineeId: row.id, companyId: ctx.companyId } }, create: { traineeId: row.id, companyId: ctx.companyId }, update: {} });
        return { row, existed: !!found };
      });
      return {
        alunoId: out.row.id, nome: out.row.name, email: out.row.email, telefone: out.row.phone, jaExistia: out.existed,
        aviso: out.existed ? 'Este CPF já estava cadastrado: os dados do cadastro foram mantidos.' : undefined,
      };
    },
  },
  {
    name: 'vincular_empresa_inscricao',
    title: 'Ligando a inscrição à empresa',
    description: 'Põe (ou tira) a empresa contratante de uma inscrição: é a empresa que sai no certificado. Ache o cliente com buscar_clientes. Para tirar, mande clienteId 0.',
    inputSchema: obj({ inscricaoId: int('Id da inscrição (de listar_inscritos)'), clienteId: int('Id do cliente; 0 tira a empresa') }, ['inscricaoId', 'clienteId']),
    permissions: ['update_classes'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const sub = await deps.prisma.courseClassSubscription.findFirst({ where: { id: positiveInt(input.inscricaoId) ?? 0, class: { companyId: ctx.companyId }, inactiveAt: null }, select: { id: true, name: true, reservationId: true } });
      if (!sub) throw new ToolRefusal('Inscrição não encontrada');
      if (sub.reservationId) throw new ToolRefusal('Esta inscrição ocupa uma vaga reservada de empresa: a empresa vem da reserva (mude pela tela de vagas da turma)');
      const customerId = positiveInt(input.clienteId);
      await deps.api.call(ctx, 'PUT', `subscription/${sub.id}`, { body: { customerId: customerId ?? 'null' } });
      const updated = await deps.prisma.courseClassSubscription.findUnique({ where: { id: sub.id }, select: { customer: { select: { name: true } } } });
      return { inscricaoId: sub.id, aluno: sub.name, empresa: updated?.customer?.name ?? null };
    },
  },

  // ------------------------------------------------------------- sensível
  {
    name: 'inscrever_na_turma',
    title: 'Preparando a inscrição',
    description: 'Inscreve uma pessoa numa turma como CONFIRMADA (cadastra o aluno pelo CPF se preciso). Se a pessoa já tem inscrição pendente na turma (feita pelo site), confirma essa. Com jaPago, lança o pagamento no financeiro já recebido (valor padrão: o preço da turma; pergunte a forma de pagamento). Precisa de nome, CPF, e-mail e telefone (ou alunoId de buscar_aluno). Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      turmaId: int('Id da turma (de listar_turmas)'),
      alunoId: int('Id do aluno já cadastrado (de buscar_aluno), no lugar de nome/CPF'),
      nome: str('Nome completo'), cpf: str('CPF'), email: str('E-mail'), telefone: str('Telefone com DDD'),
      profissao: str('Cargo/profissão'), trabalhaEm: str('Onde trabalha (texto livre, se não for cliente cadastrado)'),
      clienteId: int('Empresa contratante (cliente cadastrado, sai no certificado)'),
      reservaId: int('Vaga reservada de empresa nesta turma, se a pessoa ocupa uma'),
      jaPago: bool('true se a pessoa já pagou'),
      valorPago: num('Valor pago em reais (padrão: preço da turma)'),
      formaPagamento: str('Como pagou', { enum: PAYMENT_METHODS }),
      dataPagamento: str('Data do pagamento (AAAA-MM-DD; padrão: hoje)'),
      contaBancariaId: int('Conta bancária onde o dinheiro entrou (opcional)'),
      observacoes: str('Observação para o financeiro (ex.: "pago pelo WhatsApp")'),
    }, ['turmaId']),
    permissions: ['create_classes'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const turma = await classOf(ctx, deps, input.turmaId);
      let name = text(input.nome, 100);
      let cpf = digits(input.cpf);
      let email = text(input.email, 255).toLowerCase();
      let phone = digits(input.telefone).slice(0, 20);
      let occupation = text(input.profissao, 255);
      if (input.alunoId) {
        const trainee = await deps.prisma.trainee.findFirst({ where: { AND: [{ id: positiveInt(input.alunoId) ?? 0 }, traineeOfCompany(ctx.companyId)] }, select: { name: true, cpf: true, email: true, phone: true, occupation: true } });
        if (!trainee) throw new ToolRefusal('Aluno não encontrado');
        name ||= trainee.name; cpf ||= trainee.cpf; email ||= (trainee.email ?? '').toLowerCase(); phone ||= digits(trainee.phone); occupation ||= trainee.occupation ?? '';
      }
      if (!isValidCPF(cpf)) throw new ToolRefusal('CPF inválido ou faltando: confira os números com a pessoa');
      if (name.length < 3) throw new ToolRefusal('Informe o nome completo');
      if (!email || !validEmail(email)) throw new ToolRefusal('A inscrição exige um e-mail válido: peça à pessoa');
      if (phone.length < 10) throw new ToolRefusal('A inscrição exige telefone com DDD: peça à pessoa');

      const existing = await deps.prisma.courseClassSubscription.findFirst({
        where: { classId: turma.id, cpf, inactiveAt: null, subscribeStatus: { not: 'declined' } },
        select: { id: true, subscribeStatus: true, financialRecords: { where: { inactiveAt: null }, select: { id: true, status: true, gateway: true } } },
      });
      if (existing?.subscribeStatus === 'confirmed') throw new ToolRefusal(`Esta pessoa já está inscrita e confirmada nesta turma (inscrição ${existing.id})`);

      const details: { label: string; value: string }[] = [
        { label: 'Aluno', value: `${name} (CPF ${cpfTail(cpf)})` },
        { label: 'Contato', value: `${email} · ${phone}` },
      ];
      let customerId: number | null = null;
      if (input.clienteId) {
        const customer = await deps.prisma.customer.findFirst({ where: { id: positiveInt(input.clienteId) ?? 0, companyId: ctx.companyId }, select: { id: true, name: true } });
        if (!customer) throw new ToolRefusal('Cliente não encontrado');
        customerId = customer.id;
        details.push({ label: 'Empresa', value: customer.name });
      } else if (text(input.trabalhaEm)) details.push({ label: 'Trabalha em', value: text(input.trabalhaEm, 255) });
      let reservationId: number | null = null;
      if (input.reservaId) {
        const reservation = await deps.prisma.courseClassReservation.findFirst({ where: { id: positiveInt(input.reservaId) ?? 0, classId: turma.id, inactiveAt: null }, select: { id: true, customer: { select: { name: true } } } });
        if (!reservation) throw new ToolRefusal('Reserva não encontrada nesta turma');
        reservationId = reservation.id;
        details.push({ label: 'Vaga da empresa', value: reservation.customer?.name ?? `reserva ${reservation.id}` });
      }
      const seats = await seatsOfClass(deps.prisma, turma.id);
      if (!reservationId && seats && seats.free !== null && seats.free <= 0) throw new ToolRefusal(`A turma está lotada (${seats.occupied} de ${seats.max} vagas). Aumente o limite na tela da turma antes de inscrever.`);
      if (seats) details.push({ label: 'Vagas', value: seats.max === null ? `${seats.confirmed} confirmados (sem limite)` : `${seats.occupied} de ${seats.max} ocupadas antes desta` });
      if (turma.finalDate && iso(turma.finalDate)! < todayBr()) details.push({ label: 'Atenção', value: 'a turma já terminou' });

      let payment: Record<string, unknown> | null = null;
      if (input.jaPago === true) {
        if (!PAYMENT_METHODS.includes(input.formaPagamento)) throw new ToolRefusal('Informe a forma de pagamento (pix, cartão, boleto, transferência, dinheiro ou outro)');
        const value = Number(input.valorPago) > 0 ? Math.round(Number(input.valorPago) * 100) / 100 : Number(turma.discountPrice ?? turma.price ?? 0);
        if (!(value > 0)) throw new ToolRefusal('A turma não tem preço cadastrado: informe o valor pago');
        const paidAt = input.dataPagamento ? String(input.dataPagamento) : todayBr();
        if (!isDate(paidAt) || paidAt > todayBr()) throw new ToolRefusal('Data do pagamento inválida ou futura');
        if (!has(ctx, 'create_financeiro', 'update_financeiro')) {
          details.push({ label: 'Pagamento', value: `${brl(value)} no ${PAYMENT_LABEL[input.formaPagamento]} — NÃO será lançado no financeiro (você não tem permissão no financeiro)` });
        } else {
          let bank: string | null = null;
          if (input.contaBancariaId) {
            const row = await deps.prisma.financial_BankAccount.findFirst({ where: { id: positiveInt(input.contaBancariaId) ?? 0, companyId: ctx.companyId, inactiveAt: null }, select: { name: true } });
            if (!row) throw new ToolRefusal('Conta bancária não encontrada');
            bank = row.name;
          }
          payment = { value, method: input.formaPagamento, paidAt, bankAccountId: positiveInt(input.contaBancariaId), observations: text(input.observacoes, 200) || null };
          details.push({ label: 'Pagamento', value: `${brl(value)} no ${PAYMENT_LABEL[input.formaPagamento]} em ${paidAt.split('-').reverse().join('/')}${bank ? ` (${bank})` : ''}: lançado como recebido` });
        }
        const open = existing?.financialRecords.filter((row) => row.gateway !== 'manual' && ['waiting', 'processing', 'overdue'].includes(row.status)) ?? [];
        if (open.length) details.push({ label: 'Atenção', value: `há cobrança do site em aberto (${open.map((row) => `#${row.id}`).join(', ')}): cancele no financeiro para não cobrar duas vezes` });
      }
      if (existing) details.unshift({ label: 'Inscrição do site', value: `já existia pendente (${existing.id}): será confirmada` });

      return {
        summary: `${existing ? 'Confirmar' : 'Inscrever'} ${name} na turma "${turma.name}" (${brDate(turma.initialDate)} a ${brDate(turma.finalDate)})${payment ? `, já pago (${brl(payment.value)})` : ''}?`,
        details,
        payload: {
          classId: turma.id, className: turma.name, existingId: existing?.id ?? null,
          person: { name, cpf, email, phone, occupation: occupation || null, workedAt: text(input.trabalhaEm, 255) || null },
          customerId, reservationId, payment,
        },
      };
    },
    execute: async (ctx, payload, deps) => {
      const person = payload.person;
      const body: Record<string, unknown> = { name: person.name, email: person.email, phone: person.phone, subscribeStatus: 'confirmed' };
      if (person.occupation) body.occupation = person.occupation;
      if (person.workedAt) body.workedAt = person.workedAt;
      if (payload.customerId) body.customerId = payload.customerId;
      let subscriptionId: number;
      if (payload.existingId) {
        const current = await deps.prisma.courseClassSubscription.findFirst({ where: { id: payload.existingId, classId: payload.classId, inactiveAt: null }, select: { subscribeStatus: true } });
        if (!current) throw new ToolRefusal('A inscrição pendente não existe mais: peça de novo');
        if (current.subscribeStatus !== 'confirmed') await deps.api.call(ctx, 'PUT', `subscription/${payload.existingId}`, { body });
        subscriptionId = payload.existingId;
      } else {
        const created: any = await deps.api.call(ctx, 'POST', 'subscription', {
          body: { ...body, classId: payload.classId, cpf: person.cpf, ...(payload.reservationId ? { reservationId: payload.reservationId } : {}) },
        });
        subscriptionId = Number(created?.id ?? created?.data?.id);
      }
      const sub = await deps.prisma.courseClassSubscription.findFirst({ where: { id: subscriptionId, classId: payload.classId }, select: { id: true, traineeId: true, customerId: true } });
      if (!sub) throw new Error('Inscrição criada mas não encontrada');
      await evict();
      const link = `/treinamentos/turmas/${payload.classId}`;
      const done = `${person.name} ${payload.existingId ? 'confirmado(a)' : 'inscrito(a)'} na turma "${payload.className}"`;

      const pay = payload.payment;
      if (!pay) return { message: `${done}.`, link, data: { inscricaoId: sub.id, alunoId: sub.traineeId } };
      try {
        const record: any = await deps.api.call(ctx, 'POST', 'financial-records', {
          body: {
            description: `Inscrição — ${payload.className} — ${person.name}`.slice(0, 255), value: pay.value, dueDate: pay.paidAt, paymentMethod: pay.method,
            subscriptionId: sub.id, traineeId: sub.traineeId, ...(sub.customerId ? { customerId: sub.customerId } : {}), ...(pay.observations ? { observations: pay.observations } : {}),
          },
        });
        const recordId = Number(record?.id ?? record?.data?.id);
        await deps.api.call(ctx, 'PATCH', `financial-records/settle/${recordId}`, { body: { paidAt: pay.paidAt, paymentMethod: pay.method, ...(pay.bankAccountId ? { bankAccountId: pay.bankAccountId } : {}) } });
        return { message: `${done}, com o pagamento de ${brl(pay.value)} lançado como recebido.`, link, data: { inscricaoId: sub.id, alunoId: sub.traineeId, contaReceberId: recordId } };
      } catch (error) {
        // a inscrição já valeu: não desfaz; avisa o que faltou
        const reason = error instanceof ToolRefusal ? error.message : 'falha interna';
        if (!(error instanceof ToolRefusal)) console.error('[ai] pagamento da inscrição não lançado', error);
        return { message: `${done}, mas o pagamento NÃO foi lançado no financeiro (${reason}). Lance em Financeiro → Contas a receber.`, link, data: { inscricaoId: sub.id, alunoId: sub.traineeId } };
      }
    },
  },
];
