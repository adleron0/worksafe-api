import { asRefusal, brl, isDate, iso, money, orderActor, activityActor, positiveInt, proposalActor, text, todayBr } from './actors';
import { CacheService } from 'src/common/cache/cache.service';
import { ImageIntakeService } from '../images/image-intake.service';
import { ToolDefinition, ToolRefusal } from './tool.types';

/** As telas e o site leem blog e turmas de cache: gravar direto precisa limpar como as rotas limpam. */
const BLOG_CACHE = ['blog/posts:*', 'blog-posts-public:*', 'blog-post-slug:*', 'cache:*/blog/posts*', 'cache:*/blog-posts-public*', 'cache:*/blog-post-slug*'];
const CLASSES_CACHE = ['training-classes:*', 'cache:*/classes*'];
async function evict(patterns: string[]) {
  const cache = new CacheService();
  for (const pattern of patterns) await cache.reset(pattern).catch(() => undefined);
}

/**
 * Ferramentas que escrevem. As de rascunho criam algo que ainda não saiu
 * para fora; as sensíveis só descrevem a ação (prepare) e esperam o clique
 * da pessoa no cartão (execute roda depois, com as permissões atuais dela).
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const num = (description: string) => ({ type: 'number', description });

const SECTION_TITLE: Record<string, string> = {
  mao_de_obra: 'Mão de obra', locacao: 'Locação de equipamentos', material: 'Materiais', treinamento: 'Treinamentos', avulso: 'Outros',
};
const ITEM_TYPES = Object.keys(SECTION_TITLE);

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    tipo: str('mao_de_obra | locacao | material | treinamento | avulso', { enum: ITEM_TYPES }),
    descricao: str('Descrição do item'),
    quantidade: num('Quantidade (pessoas na mão de obra, unidades, alunos...)'),
    unidade: str('Unidade (un, dia, mês, kg...)'),
    profissionalId: int('mao_de_obra: id do profissional (de opcoes_proposta)'),
    dias: int('mao_de_obra: dias úteis de trabalho'),
    horasPorDia: num('mao_de_obra: horas por dia'),
    cursoId: int('treinamento: id do curso (de opcoes_proposta)'),
    custoUnitario: num('locacao/material/avulso: custo unitário em reais'),
    valorFinal: num('Opcional: valor final fixo do item, se a pessoa disse o preço'),
  },
  required: ['tipo', 'descricao'],
  additionalProperties: false,
};

/** Converte a entrada do bot no corpo que o serviço de propostas espera. */
export function proposalBody(input: Record<string, any>) {
  const items = Array.isArray(input.itens) ? input.itens : [];
  if (!items.length) throw new ToolRefusal('Inclua ao menos um item na proposta');
  const groups = new Map<string, any[]>();
  for (const raw of items) {
    const type = ITEM_TYPES.includes(raw?.tipo) ? raw.tipo : 'avulso';
    const item: Record<string, unknown> = { type, description: text(raw?.descricao, 300) || SECTION_TITLE[type], quantity: Number(raw?.quantidade) > 0 ? Number(raw.quantidade) : 1, unit: text(raw?.unidade, 30) || null };
    if (type === 'mao_de_obra') Object.assign(item, { professionalId: positiveInt(raw?.profissionalId), workDays: positiveInt(raw?.dias), hoursPerDay: Number(raw?.horasPorDia) > 0 ? Number(raw.horasPorDia) : null });
    else if (type === 'treinamento') Object.assign(item, { courseId: positiveInt(raw?.cursoId), extra: { students: Number(raw?.quantidade) || null } });
    else item.unitCost = Number(raw?.custoUnitario) > 0 ? Number(raw.custoUnitario) : 0;
    if (Number(raw?.valorFinal) > 0) item.finalValue = Number(raw.valorFinal);
    groups.set(type, [...(groups.get(type) ?? []), item]);
  }
  const kind = ['servico', 'treinamento', 'misto'].includes(input.tipo) ? input.tipo : groups.has('treinamento') && groups.size === 1 ? 'treinamento' : groups.has('treinamento') ? 'misto' : 'servico';
  return {
    kind,
    title: text(input.titulo, 200) || 'Proposta',
    customerId: positiveInt(input.clienteId) ?? undefined,
    workDays: positiveInt(input.prazoDiasUteis) ?? 0,
    description: text(input.descricao, 4000) || null,
    contactName: text(input.contatoNome, 160) || null,
    contactEmail: text(input.contatoEmail, 255) || null,
    sections: [...groups.entries()].map(([type, sectionItems]) => ({ title: SECTION_TITLE[type], kind: type, items: sectionItems })),
  };
}

const brDate = (value: Date | null) => (value ? iso(value)!.split('-').reverse().join('/') : '?');
const proposalLine = (row: any) => `${row.number}${row.revision ? ` rev. ${row.revision}` : ''} — ${row.title}`;

export const WRITE_TOOLS: ToolDefinition[] = [
  // ------------------------------------------------------------- rascunhos
  {
    name: 'criar_rascunho_proposta',
    title: 'Criando o rascunho da proposta',
    description: 'Cria uma proposta em RASCUNHO (não envia nada ao cliente). O preço sai da base de cálculo da empresa. Antes, confirme o cliente com buscar_clientes e os ids de profissionais/cursos com opcoes_proposta. Devolve número, total e link.',
    inputSchema: obj({
      clienteId: int('Id do cliente'),
      titulo: str('Título da proposta'),
      tipo: str('servico | treinamento | misto', { enum: ['servico', 'treinamento', 'misto'] }),
      descricao: str('Escopo, em texto'),
      prazoDiasUteis: int('Prazo em dias úteis'),
      contatoNome: str('Nome do contato no cliente'),
      contatoEmail: str('E-mail do contato no cliente (para quem a proposta será enviada)'),
      itens: { type: 'array', items: ITEM_SCHEMA, description: 'Itens da proposta' },
    }, ['clienteId', 'titulo', 'itens']),
    permissions: ['create_comercial'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const row: any = await asRefusal(() => deps.proposals.create(proposalActor(ctx), proposalBody(input)));
      return { id: row.id, numero: row.number, situacao: row.status, total: money(row.total ?? row.result?.total), link: `/comercial/propostas/${row.id}`, aviso: 'Criada como rascunho: revise na tela antes de enviar.' };
    },
  },
  {
    name: 'registrar_acompanhamento',
    title: 'Registrando o acompanhamento',
    description: 'Registra um contato feito com o cliente ou marca um retorno (ligação, whatsapp, email, reuniao, visita, tarefa, nota). Ligado a uma proposta (propostaId) ou a um cliente (clienteId).',
    inputSchema: obj({
      tipo: str('Tipo', { enum: ['ligacao', 'whatsapp', 'email', 'reuniao', 'visita', 'tarefa', 'nota'] }),
      assunto: str('Assunto curto'),
      anotacoes: str('Anotações'),
      propostaId: int('Id da proposta'),
      clienteId: int('Id do cliente (se não houver proposta)'),
      jaFeito: { type: 'boolean', description: 'true = contato já feito; false = retorno marcado' },
      resultado: str('Se já feito: o que ficou combinado'),
      data: str('Se marcado: data (AAAA-MM-DD)'),
      hora: str('Se marcado: hora (HH:MM, horário de Brasília)'),
    }, ['tipo']),
    permissions: ['update_acompanhamento'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const done = input.jaFeito === true;
      if (!done && !isDate(input.data)) throw new ToolRefusal('Para marcar um retorno, informe a data (AAAA-MM-DD); ou registre como contato já feito');
      const row: any = await asRefusal(() => deps.activities.create(activityActor(ctx), {
        type: input.tipo, subject: text(input.assunto, 200), notes: text(input.anotacoes, 4000), proposalId: positiveInt(input.propostaId) ?? undefined,
        customerId: positiveInt(input.clienteId) ?? undefined, done, result: text(input.resultado, 2000), dueDate: done ? undefined : input.data, dueTime: done ? undefined : text(input.hora, 5) || undefined,
      }));
      return { id: row.id, tipo: row.type, assunto: row.subject, marcadoPara: row.dueDate ?? null, feitoEm: row.doneAt ?? null };
    },
  },
  {
    name: 'escalar_equipe_os',
    title: 'Escalando a equipe na OS',
    description: 'Inclui funcionários do cadastro na equipe de uma OS (mantém quem já está). Antes, use quem_esta_livre. Devolve a equipe resultante e os avisos (conflito, férias, documento vencido) — os avisos não bloqueiam.',
    inputSchema: obj({
      osId: int('Id da OS'),
      pessoas: { type: 'array', items: obj({ funcionarioId: int('Id do funcionário'), profissionalId: int('Opcional: id da função (profissional) na obra') }, ['funcionarioId']) },
    }, ['osId', 'pessoas']),
    permissions: ['update_ordens_de_servico'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.osId);
      if (!id) throw new ToolRefusal('Informe o id da OS');
      const actor = orderActor(ctx);
      const order: any = await asRefusal(() => deps.orders.get(actor, id));
      const team = Array.isArray(order.team) ? [...order.team] : [];
      const present = new Set(team.map((member: any) => member.employeeId).filter(Boolean));
      for (const person of Array.isArray(input.pessoas) ? input.pessoas : []) {
        const employeeId = positiveInt(person?.funcionarioId);
        if (!employeeId || present.has(employeeId)) continue;
        team.push({ employeeId, professionalId: positiveInt(person?.profissionalId) ?? undefined });
        present.add(employeeId);
      }
      const options: any = await asRefusal(() => deps.orders.teamOptions(actor, id, {}));
      const updated: any = await asRefusal(() => deps.orders.update(actor, id, { team }));
      const warnings = (options.employees ?? [])
        .filter((employee: any) => present.has(employee.id) && ((employee.conflicts ?? []).length || (employee.documents ?? employee.pending ?? []).length || employee.unavailable))
        .map((employee: any) => ({ nome: employee.name, conflitos: employee.conflicts ?? [], pendencias: employee.documents ?? employee.pending ?? [], indisponivel: employee.unavailable ?? null }));
      return {
        os: updated.number, equipe: (updated.team ?? []).map((member: any) => ({ nome: member.name, funcao: member.role ?? null })),
        avisos: warnings, link: `/servicos/ordens-de-servico/${id}`,
      };
    },
  },
  {
    name: 'criar_rascunho_post_blog',
    title: 'Escrevendo o rascunho do post',
    description: 'Cria um post do blog em RASCUNHO (não publica). Conteúdo em HTML simples (<h2>, <p>, <ul>; imagens com <img src="URL">, só de imagens já no WorkSafe). Capa opcional (capaUrl, também do WorkSafe). Devolve o link para revisar.',
    inputSchema: obj({ titulo: str('Título'), resumo: str('Resumo de uma ou duas frases'), conteudo: str('Conteúdo em HTML simples'), capaUrl: str('URL da imagem de capa (de imagens_do_envio ou enviar_imagem_*)') }, ['titulo', 'conteudo']),
    permissions: ['create_blog'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const title = text(input.titulo, 255);
      if (title.length < 5) throw new ToolRefusal('Título curto demais');
      const content = String(input.conteudo ?? '')
        .replace(/<\s*(script|iframe|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        // imagem só do bucket do sistema: nada de imagem externa (rastreio, link quebrado)
        .replace(/<img\b[^>]*>/gi, (tag) => {
          const src = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
          if (!src || !ImageIntakeService.ownUrl(src)) return '';
          const alt = (/\salt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '').replace(/[<>"]/g, '');
          return `<img src="${src}" alt="${alt}">`;
        })
        .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
        .slice(0, 60000);
      if (input.capaUrl && !ImageIntakeService.ownUrl(input.capaUrl)) throw new ToolRefusal('A capa precisa ser uma imagem já no WorkSafe (suba antes com link_para_enviar_imagens)');
      if (content.length < 200) throw new ToolRefusal('Conteúdo curto demais para um post');
      const base = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'post';
      let slug = base;
      for (let n = 2; await deps.prisma.blog_Post.findFirst({ where: { companyId: ctx.companyId, slug }, select: { id: true } }); n++) slug = `${base}-${n}`;
      const row = await deps.prisma.blog_Post.create({ data: { companyId: ctx.companyId, authorId: ctx.userId, title, slug, excerpt: text(input.resumo, 500) || null, content, coverImage: input.capaUrl || null, status: 'draft' } });
      await evict(BLOG_CACHE);
      return { id: row.id, titulo: row.title, situacao: 'rascunho', link: "/blog/posts" };
    },
  },
  {
    name: 'nova_turma_rascunho',
    title: 'Preparando a nova turma',
    description: 'Abre uma nova turma copiando uma turma anterior (curso, preço, local, vagas, textos) com novas datas. A turma nasce FECHADA e fora do site; publicar é outra ação, com confirmação.',
    inputSchema: obj({ turmaModeloId: int('Id da turma a copiar (de listar_turmas)'), inicio: str('Início (AAAA-MM-DD)'), fim: str('Fim (AAAA-MM-DD)'), nome: str('Nome da nova turma (opcional)'), imagemUrl: str('Imagem da turma (opcional, já no WorkSafe); sem ela, usa a da turma modelo') }, ['turmaModeloId', 'inicio', 'fim']),
    permissions: ['create_classes'],
    risk: 'draft',
    run: async (ctx, input, deps) => {
      if (!isDate(input.inicio) || !isDate(input.fim) || input.fim < input.inicio) throw new ToolRefusal('Informe início e fim válidos (AAAA-MM-DD), com o fim depois do início');
      if (input.inicio < todayBr()) throw new ToolRefusal('A turma nova não pode começar no passado');
      if (input.imagemUrl && !ImageIntakeService.ownUrl(input.imagemUrl)) throw new ToolRefusal('A imagem precisa já estar no WorkSafe (suba antes com link_para_enviar_imagens)');
      const source = await deps.prisma.courseClass.findFirst({ where: { id: positiveInt(input.turmaModeloId) ?? 0, companyId: ctx.companyId } });
      if (!source) throw new ToolRefusal('Turma modelo não encontrada');
      const { id: _id, createdAt: _c, updatedAt: _u, inactiveAt: _i, faq, whyUs, ...rest } = source as any;
      const start = new Date(`${input.inicio}T12:00:00Z`);
      const end = new Date(`${input.fim}T12:00:00Z`);
      const created = await deps.prisma.courseClass.create({
        data: {
          ...rest, faq: faq ?? undefined, whyUs: whyUs ?? undefined,
          name: text(input.nome, 200) || source.name, initialDate: start, finalDate: end, imageUrl: input.imagemUrl || source.imageUrl,
          active: false, openClass: false, allowSubscriptions: false, allowCheckout: false, landingPagesDates: null,
          periodSubscriptionsInitialDate: null, periodSubscriptionsFinalDate: null,
        },
      });
      await evict(CLASSES_CACHE);
      return { id: created.id, nome: created.name, inicio: iso(created.initialDate), fim: iso(created.finalDate), situacao: 'fechada e fora do site', link: `/treinamentos/turmas/${created.id}` };
    },
  },

  // ------------------------------------------------------------- sensíveis
  {
    name: 'enviar_proposta',
    title: 'Preparando o envio da proposta',
    description: 'Envia uma proposta ao cliente: muda para "enviada" (gera o link público) e manda o link por e-mail para o contato CADASTRADO na proposta. Nunca envia para outro endereço. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({ propostaId: int('Id da proposta'), mensagem: str('Mensagem curta para o e-mail (opcional)') }, ['propostaId']),
    permissions: ['update_comercial'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const id = positiveInt(input.propostaId);
      if (!id) throw new ToolRefusal('Informe o id da proposta');
      const row: any = await asRefusal(() => deps.proposals.get(proposalActor(ctx), id));
      if (!['rascunho', 'enviada', 'visualizada'].includes(row.status)) throw new ToolRefusal(`A proposta está ${row.status}: não dá para enviar`);
      const email = row.contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.contactEmail) ? row.contactEmail : null;
      const details = [
        { label: 'Cliente', value: row.customer?.name ?? '—' },
        { label: 'Total', value: brl(row.total) },
        { label: 'E-mail', value: email ?? 'sem e-mail de contato: só o link será gerado' },
      ];
      return {
        summary: `Enviar a proposta ${proposalLine(row)} (${brl(row.total)})${email ? ` para ${email}` : ''}?`,
        details, payload: { proposalId: id, email, message: text(input.mensagem, 1000), wasDraft: row.status === 'rascunho' },
      };
    },
    execute: async (ctx, payload, deps) => {
      const actor = proposalActor(ctx);
      if (payload.wasDraft) await asRefusal(() => deps.proposals.setStatus(actor, payload.proposalId, { status: 'enviada' }));
      let emailed = false;
      if (payload.email) {
        await asRefusal(() => deps.proposals.sendEmail(actor, payload.proposalId, { to: payload.email, message: payload.message }));
        emailed = true;
      }
      const row: any = await deps.proposals.get(actor, payload.proposalId);
      return { message: `Proposta ${row.number} enviada${emailed ? ` para ${payload.email}` : ' (sem e-mail: copie o link na tela)'}.`, link: `/comercial/propostas/${row.id}` };
    },
  },
  {
    name: 'mudar_situacao_proposta',
    title: 'Preparando a mudança da proposta',
    description: 'Marca uma proposta enviada como aceita ou recusada, ou cancela. O aceite cria a venda e a OS. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({ propostaId: int('Id da proposta'), situacao: str('Nova situação', { enum: ['aceita', 'recusada', 'cancelada'] }), motivo: str('Motivo (recusa ou cancelamento)') }, ['propostaId', 'situacao']),
    permissions: ['update_comercial'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const id = positiveInt(input.propostaId);
      if (!id || !['aceita', 'recusada', 'cancelada'].includes(input.situacao)) throw new ToolRefusal('Informe a proposta e a nova situação (aceita, recusada ou cancelada)');
      const row: any = await asRefusal(() => deps.proposals.get(proposalActor(ctx), id));
      const verb = { aceita: 'Marcar como ACEITA', recusada: 'Marcar como recusada', cancelada: 'Cancelar' }[input.situacao as 'aceita'];
      return {
        summary: `${verb} a proposta ${proposalLine(row)} (${brl(row.total)})?`,
        details: [{ label: 'Cliente', value: row.customer?.name ?? '—' }, { label: 'Situação atual', value: row.status }, ...(input.motivo ? [{ label: 'Motivo', value: text(input.motivo, 300) }] : [])],
        payload: { proposalId: id, status: input.situacao, reason: text(input.motivo, 500) },
      };
    },
    execute: async (ctx, payload, deps) => {
      await asRefusal(() => deps.proposals.setStatus(proposalActor(ctx), payload.proposalId, { status: payload.status, reason: payload.reason, note: payload.reason }));
      const row: any = await deps.proposals.get(proposalActor(ctx), payload.proposalId);
      return { message: `Proposta ${row.number} agora está ${row.status}.`, link: `/comercial/propostas/${row.id}` };
    },
  },
  {
    name: 'mover_os',
    title: 'Preparando a passagem da OS',
    description: 'Passa uma OS para outra etapa (agendada, em_execucao, concluida, encerrada, cancelada). Agendar pede início previsto; cancelar pede motivo. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      osId: int('Id da OS'), etapa: str('Nova etapa', { enum: ['a_planejar', 'agendada', 'em_execucao', 'concluida', 'encerrada', 'cancelada'] }),
      inicioPrevisto: str('Para agendar: início (AAAA-MM-DD)'), fimPrevisto: str('Para agendar: término (AAAA-MM-DD)'), observacao: str('Observação ou motivo'),
    }, ['osId', 'etapa']),
    permissions: ['update_ordens_de_servico'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const id = positiveInt(input.osId);
      if (!id) throw new ToolRefusal('Informe o id da OS');
      const row: any = await asRefusal(() => deps.orders.get(orderActor(ctx), id));
      if (input.etapa === 'cancelada' && !text(input.observacao)) throw new ToolRefusal('Para cancelar, informe o motivo');
      return {
        summary: `Passar a OS ${row.number} (${row.title}) de "${row.status}" para "${input.etapa}"?`,
        details: [{ label: 'Cliente', value: row.customer?.name ?? '—' }, ...(input.inicioPrevisto ? [{ label: 'Início previsto', value: String(input.inicioPrevisto) }] : []), ...(input.observacao ? [{ label: 'Observação', value: text(input.observacao, 300) }] : [])],
        payload: { orderId: id, status: input.etapa, plannedStart: input.inicioPrevisto || undefined, plannedEnd: input.fimPrevisto || undefined, note: text(input.observacao, 500) || undefined },
      };
    },
    execute: async (ctx, payload, deps) => {
      const row: any = await asRefusal(() => deps.orders.move(orderActor(ctx), payload.orderId, { status: payload.status, plannedStart: payload.plannedStart, plannedEnd: payload.plannedEnd, note: payload.note }));
      return { message: `OS ${row.number ?? payload.orderId} agora está em ${row.status ?? payload.status}.`, link: `/servicos/ordens-de-servico/${payload.orderId}` };
    },
  },
  {
    name: 'publicar_turma',
    title: 'Preparando a publicação da turma',
    description: 'Abre a turma para inscrições e a mostra no site. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({ turmaId: int('Id da turma') }, ['turmaId']),
    permissions: ['update_classes'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const row = await deps.prisma.courseClass.findFirst({ where: { id: positiveInt(input.turmaId) ?? 0, companyId: ctx.companyId, inactiveAt: null }, include: { course: { select: { name: true } } } });
      if (!row) throw new ToolRefusal('Turma não encontrada');
      if (row.finalDate && iso(row.finalDate)! < todayBr()) throw new ToolRefusal('A turma já terminou');
      return {
        summary: `Publicar no site e abrir inscrições da turma "${row.name}" (${brDate(row.initialDate)} a ${brDate(row.finalDate)})?`,
        details: [{ label: 'Curso', value: row.course?.name ?? '—' }, { label: 'Preço', value: row.price === null ? '—' : brl(row.discountPrice ?? row.price) }],
        payload: { classId: row.id },
      };
    },
    execute: async (ctx, payload, deps) => {
      const row = await deps.prisma.courseClass.findFirst({ where: { id: payload.classId, companyId: ctx.companyId } });
      if (!row) throw new ToolRefusal('Turma não encontrada');
      await deps.prisma.courseClass.update({ where: { id: row.id }, data: { active: true, openClass: true, allowSubscriptions: true } });
      await evict(CLASSES_CACHE);
      return { message: `Turma "${row.name}" publicada e com inscrições abertas.`, link: `/treinamentos/turmas/${row.id}` };
    },
  },
  {
    name: 'publicar_post_blog',
    title: 'Preparando a publicação do post',
    description: 'Publica no site um post do blog que está em rascunho. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({ postId: int('Id do post') }, ['postId']),
    permissions: ['update_blog'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const row = await deps.prisma.blog_Post.findFirst({ where: { id: positiveInt(input.postId) ?? 0, companyId: ctx.companyId, inactiveAt: null } });
      if (!row) throw new ToolRefusal('Post não encontrado');
      if (row.status === 'published') throw new ToolRefusal('O post já está publicado');
      return { summary: `Publicar no site o post "${row.title}"?`, details: [{ label: 'Endereço', value: `/blog/${row.slug}` }], payload: { postId: row.id } };
    },
    execute: async (ctx, payload, deps) => {
      const row = await deps.prisma.blog_Post.findFirst({ where: { id: payload.postId, companyId: ctx.companyId } });
      if (!row) throw new ToolRefusal('Post não encontrado');
      await deps.prisma.blog_Post.update({ where: { id: row.id }, data: { status: 'published', publishedAt: row.publishedAt ?? new Date() } });
      await evict(BLOG_CACHE);
      return { message: `Post "${row.title}" publicado.`, link: "/blog/posts" };
    },
  },
];
