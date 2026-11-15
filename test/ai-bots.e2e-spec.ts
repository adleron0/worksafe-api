import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { FakeProvider } from 'src/features/ai/providers/fake.provider';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * Área de Bots: o motor chama o modelo (aqui, o fornecedor simulado), executa
 * as ferramentas com as permissões da pessoa, registra tudo e deixa as ações
 * sensíveis esperando o clique.
 */
describe('Bots de IA (e2e)', () => {
  const ALL = ['usar_bots', 'agendar_bots', 'usar_bot_treinamentos', 'usar_bot_marketing', 'usar_bot_gestao', 'list_classes', 'create_classes', 'update_classes', 'list_blog', 'create_blog', 'update_blog', 'view_auditoria_bots', 'update_bots'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    process.env.AI_DEFAULT_PROVIDER = 'fake';
    process.env.AI_MODEL_FAST = 'fake';
    process.env.AI_MODEL_STRONG = 'fake';
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); delete process.env.AI_BOTS_ENABLED; delete process.env.AI_MONTHLY_BUDGET_USD; });

  const auth = (companyId: number, permissions: string[] = ALL, sub = userId) => {
    const payload = { sub, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());

  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id, { name: 'Ana Gestora' })).id;
    const course = await makeCourse(company.id);
    const inicio = new Date(Date.now() + 10 * 86400000);
    const turma = await makeCourseClass(company.id, course.id, { name: 'NR-35 Dezembro', initialDate: inicio, finalDate: new Date(inicio.getTime() + 86400000), maxSubscriptions: 12, unlimitedSubscriptions: false, openClass: true, active: true });
    return { company, course, turma, db: testDb() };
  }
  async function botOf(companyId: number, key: string, permissions = ALL) {
    const bots = (await api().get('/ai/bots').set(auth(companyId, permissions)).expect(200)).body;
    return bots.find((bot: any) => bot.key === key);
  }
  async function waitRun(companyId: number, runId: number, permissions = ALL) {
    for (let i = 0; i < 100; i++) {
      const run = (await api().get(`/ai/runs/${runId}`).set(auth(companyId, permissions)).expect(200)).body;
      if (run.status !== 'running') return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('execução não terminou');
  }

  it('lista só os bots liberados e cria os padrões uma vez', async () => {
    const { company, db } = await cenario();
    const bots = (await api().get('/ai/bots').set(auth(company.id)).expect(200)).body;
    expect(bots.map((bot: any) => bot.key).sort()).toEqual(['gestao', 'marketing', 'treinamentos']);
    expect(bots.find((bot: any) => bot.key === 'treinamentos')).toMatchObject({ provider: 'fake', providerReady: true });
    expect(await db.ai_Bot.count({ where: { companyId: company.id } })).toBe(6);
    await api().get('/ai/bots').set(auth(company.id)).expect(200);
    expect(await db.ai_Bot.count({ where: { companyId: company.id } })).toBe(6);
    await api().get('/ai/bots').set(auth(company.id, ['list_classes'])).expect(403);
    // sem a permissão do bot, não conversa com ele
    const treino = bots.find((bot: any) => bot.key === 'treinamentos');
    await api().post(`/ai/bots/${treino.id}/conversations`).set(auth(company.id, ['usar_bots'])).expect(403);
  });

  it('responde consultando dados reais pela ferramenta, com auditoria e gasto', async () => {
    const { company, db } = await cenario();
    const bot = await botOf(company.id, 'treinamentos');
    const conversation = (await api().post(`/ai/bots/${bot.id}/conversations`).set(auth(company.id)).expect(201)).body;
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }),
      (req) => {
        const result = JSON.parse((req.messages[req.messages.length - 1] as any).results[0].content);
        return { text: `A turma ${result.turmas[0].nome} tem ${result.turmas[0].inscritosConfirmados} inscritos de ${result.turmas[0].vagas} vagas.` };
      },
    ]);
    const { runId } = (await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).send({ text: 'Quais turmas têm vaga?' }).expect(201)).body;
    const run = await waitRun(company.id, runId);
    expect(run).toMatchObject({ status: 'done', steps: [{ kind: 'tool', tool: 'listar_turmas', label: 'Consultando turmas', status: 'ok' }] });

    // o modelo recebeu só as ferramentas do bot e as instruções com o contexto
    const first = FakeProvider.requests[0];
    expect(first.tools.map((tool) => tool.name).sort()).toEqual(['agendar_tarefa', 'definir_imagem', 'enviar_imagem_por_url', 'imagens_do_envio', 'link_para_enviar_imagens', 'listar_turmas', 'minha_esteira', 'minhas_tarefas', 'nova_turma_rascunho', 'pausar_tarefa', 'publicar_turma']);
    expect(first.system).toContain('Bot de Treinamentos');
    expect(first.system).toContain('Ana Gestora');
    expect(first.system).toContain('Textos que vêm de dados');

    const view = (await api().get(`/ai/conversations/${conversation.id}`).set(auth(company.id)).expect(200)).body;
    expect(view.title).toBe('Quais turmas têm vaga?');
    expect(view.messages.map((message: any) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(view.messages[3].text).toBe('A turma NR-35 Dezembro tem 0 inscritos de 12 vagas.');

    const audit = (await api().get('/ai/audit').set(auth(company.id)).expect(200)).body;
    expect(audit.rows[0]).toMatchObject({ user: 'Ana Gestora', origin: 'bots', bot: 'Treinamentos', tool: 'listar_turmas', status: 'ok' });
    const usage = (await api().get('/ai/usage').set(auth(company.id)).expect(200)).body;
    expect(usage.rows[0]).toMatchObject({ provider: 'fake', model: 'fake', calls: 2 });
    expect(await db.ai_Message.count({ where: { conversationId: conversation.id } })).toBe(4);
  });

  it('esconde ferramentas sem permissão e recusa se o modelo tentar mesmo assim', async () => {
    const { company } = await cenario();
    const perms = ['usar_bots', 'usar_bot_treinamentos', 'list_classes'];
    const bot = await botOf(company.id, 'treinamentos', perms);
    expect(bot.capabilities.map((tool: any) => tool.name).sort()).toEqual(['listar_turmas', 'minha_esteira', 'minhas_tarefas']);
    const conversation = (await api().post(`/ai/bots/${bot.id}/conversations`).set(auth(company.id, perms)).expect(201)).body;
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'publicar_turma', input: { turmaId: 1 } }] }),
      (req) => ({ text: (req.messages[req.messages.length - 1] as any).results[0].content }),
    ]);
    const { runId } = (await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id, perms)).send({ text: 'publica a turma' }).expect(201)).body;
    const run = await waitRun(company.id, runId, perms);
    expect(FakeProvider.requests[0].tools.map((tool) => tool.name)).not.toContain('publicar_turma');
    expect(run.steps[0]).toMatchObject({ tool: 'publicar_turma', status: 'denied' });
    expect(await testDb().ai_PendingAction.count()).toBe(0);
  });

  it('rascunho direto; publicação só com o clique, que confere permissão e não repete', async () => {
    const { company, turma, db } = await cenario();
    const bot = await botOf(company.id, 'treinamentos');
    const conversation = (await api().post(`/ai/bots/${bot.id}/conversations`).set(auth(company.id)).expect(201)).body;
    const start = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 42 * 86400000).toISOString().slice(0, 10);
    let newId = 0;
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'nova_turma_rascunho', input: { turmaModeloId: turma.id, inicio: start, fim: end, nome: 'NR-35 Janeiro' } }] }),
      (req) => {
        newId = JSON.parse((req.messages[req.messages.length - 1] as any).results[0].content).id;
        return { toolCalls: [{ name: 'publicar_turma', input: { turmaId: newId } }] };
      },
      () => ({ text: 'Criei a turma em rascunho e deixei o cartão para publicar.' }),
    ]);
    const { runId } = (await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).send({ text: 'Abre uma turma igual em janeiro e publica' }).expect(201)).body;
    const run = await waitRun(company.id, runId);
    expect(run.steps.map((step: any) => [step.tool, step.status])).toEqual([['nova_turma_rascunho', 'ok'], ['publicar_turma', 'pending']]);
    const created = await db.courseClass.findUnique({ where: { id: newId } });
    expect(created).toMatchObject({ name: 'NR-35 Janeiro', active: false, openClass: false, courseId: turma.courseId, companyId: company.id });

    const view = (await api().get(`/ai/conversations/${conversation.id}`).set(auth(company.id)).expect(200)).body;
    expect(view.pendingActions).toHaveLength(1);
    const action = view.pendingActions[0];
    expect(action).toMatchObject({ tool: 'publicar_turma', status: 'pendente' });
    expect(action.summary).toContain('NR-35 Janeiro');

    // outra pessoa não confirma; sem a permissão também não
    const other = await makeSeller(company.id);
    await api().post(`/ai/actions/${action.id}/confirm`).set(auth(company.id, ALL, other.id)).expect(404);
    await api().post(`/ai/actions/${action.id}/confirm`).set(auth(company.id, ['usar_bots'])).expect(403);
    expect((await db.courseClass.findUnique({ where: { id: newId } }))!.openClass).toBe(false);

    const done = (await api().post(`/ai/actions/${action.id}/confirm`).set(auth(company.id)).expect(200)).body;
    expect(done).toMatchObject({ status: 'confirmada', message: 'Turma "NR-35 Janeiro" publicada e com inscrições abertas.' });
    expect(await db.courseClass.findUnique({ where: { id: newId } })).toMatchObject({ active: true, openClass: true });
    await api().post(`/ai/actions/${action.id}/confirm`).set(auth(company.id)).expect(409);

    // a conversa registra o que aconteceu, e o modelo fica sabendo na próxima mensagem
    const after = (await api().get(`/ai/conversations/${conversation.id}`).set(auth(company.id)).expect(200)).body;
    expect(after.messages[after.messages.length - 1]).toMatchObject({ role: 'notice', text: expect.stringContaining('Ação confirmada') });
    const statuses = (await db.ai_ToolCall.findMany({ orderBy: { id: 'asc' } })).map((row) => [row.tool, row.status]);
    expect(statuses).toEqual([['nova_turma_rascunho', 'ok'], ['publicar_turma', 'pending'], ['publicar_turma', 'ok']]);
  });

  it('cancelar a ação e ação expirada', async () => {
    const { company, turma, db } = await cenario();
    await db.courseClass.update({ where: { id: turma.id }, data: { openClass: false } });
    const bot = await botOf(company.id, 'treinamentos');
    const conversation = (await api().post(`/ai/bots/${bot.id}/conversations`).set(auth(company.id)).expect(201)).body;
    FakeProvider.script([() => ({ toolCalls: [{ name: 'publicar_turma', input: { turmaId: turma.id } }] }), () => ({ text: 'ok' }),
      () => ({ toolCalls: [{ name: 'publicar_turma', input: { turmaId: turma.id } }] }), () => ({ text: 'ok' })]);
    let { runId } = (await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).send({ text: 'publica' }).expect(201)).body;
    await waitRun(company.id, runId);
    const [first] = (await api().get('/ai/actions').set(auth(company.id)).expect(200)).body;
    await api().post(`/ai/actions/${first.id}/cancel`).set(auth(company.id)).expect(200);
    await api().post(`/ai/actions/${first.id}/confirm`).set(auth(company.id)).expect(409);

    ({ runId } = (await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).send({ text: 'publica de novo' }).expect(201)).body);
    await waitRun(company.id, runId);
    const [second] = (await api().get('/ai/actions').set(auth(company.id)).expect(200)).body;
    await db.ai_PendingAction.update({ where: { id: second.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await api().post(`/ai/actions/${second.id}/confirm`).set(auth(company.id)).expect(409);
    expect((await db.courseClass.findUnique({ where: { id: turma.id } }))!.openClass).toBe(false);
  });

  it('desligado, sem orçamento ou com execução em andamento: não envia', async () => {
    const { company, db } = await cenario();
    const bot = await botOf(company.id, 'gestao');
    const conversation = (await api().post(`/ai/bots/${bot.id}/conversations`).set(auth(company.id)).expect(201)).body;
    process.env.AI_BOTS_ENABLED = 'false';
    await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).send({ text: 'oi' }).expect(503);
    delete process.env.AI_BOTS_ENABLED;
    process.env.AI_MONTHLY_BUDGET_USD = '0';
    await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).send({ text: 'oi' }).expect(403);
    delete process.env.AI_MONTHLY_BUDGET_USD;
    await db.ai_Run.create({ data: { conversationId: conversation.id, userId, status: 'running' } });
    await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).send({ text: 'oi' }).expect(409);
    // conversa de outra pessoa
    const other = await makeSeller(company.id);
    await api().get(`/ai/conversations/${conversation.id}`).set(auth(company.id, ALL, other.id)).expect(404);
  });

  it('equipe: nome, cargo, rosto e quem está trabalhando ou esperando você', async () => {
    const { company, turma, db } = await cenario();
    const before = (await api().get('/ai/team').set(auth(company.id)).expect(200)).body;
    const lia = before.members.find((member: any) => member.key === 'treinamentos');
    expect(lia).toMatchObject({ persona: 'Lia', role: 'Coordenadora de Treinamentos', avatar: 'treinamentos', status: 'disponivel', pendingForMe: 0, today: { conversations: 0, actions: 0 } });
    expect(before.members.map((member: any) => member.persona).sort()).toEqual(['Helena', 'Lia', 'Nina']);

    const conversation = (await api().post(`/ai/bots/${lia.id}/conversations`).set(auth(company.id)).expect(201)).body;
    FakeProvider.script([() => ({ toolCalls: [{ name: 'publicar_turma', input: { turmaId: turma.id } }] }), () => ({ text: 'Deixei o cartão para você confirmar.' })]);
    const { runId } = (await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).send({ text: 'publica a turma' }).expect(201)).body;
    await waitRun(company.id, runId);
    let team = (await api().get('/ai/team').set(auth(company.id)).expect(200)).body;
    expect(team.members.find((member: any) => member.key === 'treinamentos')).toMatchObject({ status: 'aguardando', pendingForMe: 1, today: { conversations: 1, actions: 1 }, lastConversation: { id: conversation.id } });
    expect(team.activity[0]).toMatchObject({ persona: 'Lia', title: 'Preparando a publicação da turma', status: 'pending' });
    // o prompt apresenta a persona
    expect(FakeProvider.requests[0].system).toContain('Você é Lia, Coordenadora de Treinamentos');

    await db.ai_Run.create({ data: { conversationId: conversation.id, userId, status: 'running' } });
    team = (await api().get('/ai/team').set(auth(company.id)).expect(200)).body;
    expect(team.members.find((member: any) => member.key === 'treinamentos')).toMatchObject({ status: 'trabalhando', working: { people: 1, mine: { conversationId: conversation.id } } });
    await api().put(`/ai/bots/${lia.id}`).set(auth(company.id)).send({ persona: 'Lívia', role: 'Gerente de Turmas', avatar: 'marketing' }).expect(200);
    team = (await api().get('/ai/team').set(auth(company.id)).expect(200)).body;
    expect(team.members.find((member: any) => member.key === 'treinamentos')).toMatchObject({ persona: 'Lívia', role: 'Gerente de Turmas', avatar: 'marketing' });
  });

  it('equipe: pedidos e tarefas do dia, com quem pediu só para quem pode ver tudo', async () => {
    const { company, turma, db } = await cenario();
    const until = async (id: number) => { for (let i = 0; i < 100 && (await db.ai_Run.findUnique({ where: { id } }))?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 50)); };
    const bruno = (await makeSeller(company.id, { name: 'Bruno Vendas' })).id;
    const lia = await botOf(company.id, 'treinamentos');
    const BASICO = ['usar_bots', 'usar_bot_treinamentos', 'list_classes', 'update_classes'];
    // Bruno pede uma consulta; Ana pede a publicação (fica pendente)
    const conversaBruno = (await api().post(`/ai/bots/${lia.id}/conversations`).set(auth(company.id, BASICO, bruno)).expect(201)).body;
    FakeProvider.script([() => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }), () => ({ text: 'Tem vaga.' })]);
    let { runId } = (await api().post(`/ai/conversations/${conversaBruno.id}/messages`).set(auth(company.id, BASICO, bruno)).send({ text: 'Quais turmas têm vaga?' }).expect(201)).body;
    await until(runId);
    const conversaAna = (await api().post(`/ai/bots/${lia.id}/conversations`).set(auth(company.id)).expect(201)).body;
    FakeProvider.script([() => ({ toolCalls: [{ name: 'publicar_turma', input: { turmaId: turma.id } }] }), () => ({ text: 'Confirme no cartão.' })]);
    ({ runId } = (await api().post(`/ai/conversations/${conversaAna.id}/messages`).set(auth(company.id)).send({ text: 'publica a turma de dezembro' }).expect(201)).body);
    await waitRun(company.id, runId);

    // sem permissão de ver tudo: o cartão e a lista mostram só os pedidos da própria pessoa
    const teamBruno = (await api().get('/ai/team').set(auth(company.id, BASICO, bruno)).expect(200)).body;
    expect(teamBruno.members.find((member: any) => member.key === 'treinamentos').today).toEqual({ conversations: 1, actions: 1 });
    const minha = (await api().get(`/ai/team/${lia.id}/activity`).set(auth(company.id, BASICO, bruno)).expect(200)).body;
    expect(minha.seesAll).toBe(false);
    expect(minha.requests).toHaveLength(1);
    expect(minha.requests[0]).toMatchObject({ user: 'Você', mine: true, ask: 'Quais turmas têm vaga?', conversationId: conversaBruno.id, status: 'done' });
    expect(minha.tasks.map((task: any) => task.tool)).toEqual(['listar_turmas']);

    // com view_pedidos_bots: todos, com o nome de quem pediu; a conversa dos outros não abre
    const VER = [...BASICO, 'view_pedidos_bots'];
    const todas = (await api().get(`/ai/team/${lia.id}/activity?dias=7`).set(auth(company.id, VER)).expect(200)).body;
    expect(todas).toMatchObject({ seesAll: true, days: 7 });
    expect(todas.requests.map((item: any) => [item.user, item.ask])).toEqual([['Você', 'publica a turma de dezembro'], ['Bruno Vendas', 'Quais turmas têm vaga?']]);
    expect(todas.requests[1].conversationId).toBeNull();
    expect(todas.tasks.map((task: any) => [task.user, task.tool, task.status])).toEqual([['Você', 'publicar_turma', 'pending'], ['Bruno Vendas', 'listar_turmas', 'ok']]);
    const teamAna = (await api().get('/ai/team').set(auth(company.id, VER)).expect(200)).body;
    expect(teamAna.members.find((member: any) => member.key === 'treinamentos').today).toEqual({ conversations: 2, actions: 2 });

    // sem acesso ao bot, não vê nada dele
    await api().get(`/ai/team/${lia.id}/activity`).set(auth(company.id, ['usar_bots'], bruno)).expect(403);
  });

  it('configuração: instruções versionadas, voltar versão e ferramenta desconhecida', async () => {
    const { company } = await cenario();
    const config = (await api().get('/ai/bots/config').set(auth(company.id)).expect(200)).body;
    const bot = config.bots.find((item: any) => item.key === 'marketing');
    expect(config.tools.find((tool: any) => tool.name === 'publicar_post_blog')).toMatchObject({ risk: 'sensitive' });
    const original = bot.instructions;
    const updated = (await api().put(`/ai/bots/${bot.id}`).set(auth(company.id)).send({ instructions: 'Você escreve posts curtos e objetivos sobre segurança do trabalho.' }).expect(200)).body;
    expect(updated.version).toBe(2);
    await api().put(`/ai/bots/${bot.id}`).set(auth(company.id)).send({ tools: ['apagar_tudo'] }).expect(400);
    await api().put(`/ai/bots/${bot.id}`).set(auth(company.id)).send({ provider: 'skynet', model: 'x1' }).expect(400);
    const versions = (await api().get(`/ai/bots/${bot.id}/versions`).set(auth(company.id)).expect(200)).body;
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    const restored = (await api().post(`/ai/bots/${bot.id}/versions/1/restore`).set(auth(company.id)).expect(200)).body;
    expect(restored).toMatchObject({ version: 3, instructions: original });
    await api().put(`/ai/bots/${bot.id}`).set(auth(company.id, ['usar_bots'])).send({ name: 'X' }).expect(403);
  });

  it('o resultado da ferramenta não leva dados sensíveis e o rascunho de post limpa scripts', async () => {
    const { company, db } = await cenario();
    const bot = await botOf(company.id, 'marketing');
    const conversation = (await api().post(`/ai/bots/${bot.id}/conversations`).set(auth(company.id)).expect(201)).body;
    const html = `<h2>Trabalho em altura</h2><script>alert(1)</script><p>${'Conteúdo do post sobre trabalho em altura. '.repeat(10)}</p>`;
    FakeProvider.script([() => ({ toolCalls: [{ name: 'criar_rascunho_post_blog', input: { titulo: 'Trabalho em altura: o básico', conteudo: html } }] }), () => ({ text: 'feito' })]);
    const { runId } = (await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).send({ text: 'escreve um post' }).expect(201)).body;
    await waitRun(company.id, runId);
    const post = await db.blog_Post.findFirst({ where: { companyId: company.id } });
    expect(post).toMatchObject({ status: 'draft', slug: 'trabalho-em-altura-o-basico', authorId: userId });
    expect(post!.content).not.toContain('<script>');
  });
});
