import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { FakeProvider } from 'src/features/ai/providers/fake.provider';
import { BOT_DEFAULTS } from 'src/features/ai/bots/bot.defaults';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * Área de Bots: o motor chama o modelo (aqui, o fornecedor simulado), executa
 * as ferramentas com as permissões da pessoa, registra tudo e deixa as ações
 * sensíveis esperando o clique.
 */
describe('Bots de IA (e2e)', () => {
  let catalog: ToolCatalogService;
  const ALL = ['usar_bots', 'agendar_bots', 'usar_bot_treinamentos', 'usar_bot_marketing', 'usar_bot_gestao', 'list_classes', 'create_classes', 'update_classes', 'list_blog', 'create_blog', 'update_blog', 'view_auditoria_bots', 'update_bots'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    process.env.AI_DEFAULT_PROVIDER = 'fake';
    process.env.AI_MODEL_FAST = 'fake';
    process.env.AI_MODEL_STRONG = 'fake';
    const app = await bootTestApp();
    catalog = app.get(ToolCatalogService, { strict: false });
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

  it('toda ferramenta dos bots padrão existe no catálogo', () => {
    const missing = BOT_DEFAULTS.flatMap((bot) => bot.tools.filter((name) => !catalog.get(name)).map((name) => `${bot.key}:${name}`));
    expect(missing).toEqual([]);
  });

  it('lista só os bots liberados e cria os padrões uma vez', async () => {
    const { company, db } = await cenario();
    const bots = (await api().get('/ai/bots').set(auth(company.id)).expect(200)).body;
    expect(bots.map((bot: any) => bot.key).sort()).toEqual(['gestao', 'marketing', 'treinamentos']);
    expect(bots.find((bot: any) => bot.key === 'treinamentos')).toMatchObject({ provider: 'fake', providerReady: true });
    expect(await db.ai_Bot.count({ where: { companyId: company.id } })).toBe(8);
    await api().get('/ai/bots').set(auth(company.id)).expect(200);
    expect(await db.ai_Bot.count({ where: { companyId: company.id } })).toBe(8);
    await api().get('/ai/bots').set(auth(company.id, ['list_classes'])).expect(403);
    // sem a permissão do bot, não conversa com ele
    const treino = bots.find((bot: any) => bot.key === 'treinamentos');
    await api().post(`/ai/bots/${treino.id}/conversations`).set(auth(company.id, ['usar_bots'])).expect(403);
  });

  it('aceita PDF anexado (extrato) e manda ao modelo; recusa arquivo que não é PDF', async () => {
    const { company } = await cenario();
    const bot = await botOf(company.id, 'treinamentos');
    const conversation = (await api().post(`/ai/bots/${bot.id}/conversations`).set(auth(company.id)).expect(201)).body;
    FakeProvider.script([() => ({ text: 'Li o extrato.' })]);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF');
    const { runId } = (await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).field('text', 'Lê o extrato').attach('files', pdf, { filename: 'extrato-outubro.pdf', contentType: 'application/pdf' }).expect(201)).body;
    expect((await waitRun(company.id, runId)).status).toBe('done');
    const sent = FakeProvider.requests[0].messages[0] as any;
    expect(sent.images).toEqual([{ mediaType: 'application/pdf', base64: pdf.toString('base64') }]);
    const view = (await api().get(`/ai/conversations/${conversation.id}`).set(auth(company.id)).expect(200)).body;
    expect(view.messages[0].attachments).toEqual([{ name: 'extrato-outubro.pdf', mediaType: 'application/pdf', size: pdf.length }]);
    await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).field('text', 'e este?').attach('files', Buffer.from('não sou pdf'), { filename: 'falso.pdf', contentType: 'application/pdf' }).expect(400);
    await api().post(`/ai/conversations/${conversation.id}/messages`).set(auth(company.id)).field('text', 'e este?').attach('files', Buffer.from('planilha'), { filename: 'a.csv', contentType: 'text/csv' }).expect(400);
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
    expect(first.tools.map((tool) => tool.name).sort()).toEqual(['agendar_tarefa', 'buscar_aluno', 'cadastrar_aluno', 'cancelar_inscricao', 'certificados_vencendo', 'definir_imagem', 'emitir_certificados', 'enviar_imagem_por_url', 'esquecer', 'imagens_do_envio', 'inscrever_na_turma', 'lembrar', 'link_para_enviar_imagens', 'lista_de_presenca', 'listar_inscritos', 'listar_turmas', 'minha_esteira', 'minhas_tarefas', 'nova_turma_rascunho', 'pausar_tarefa', 'publicar_turma', 'reenviar_certificado', 'registrar_presenca', 'registrar_resultado_prova', 'vagas_empresas_turma', 'vincular_empresa_inscricao']);
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
    expect(bot.capabilities.map((tool: any) => tool.name).sort()).toEqual(['buscar_aluno', 'certificados_vencendo', 'esquecer', 'lembrar', 'lista_de_presenca', 'listar_inscritos', 'listar_turmas', 'minha_esteira', 'minhas_tarefas', 'vagas_empresas_turma']);
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

  it('criar bot: chave pelo nome, permissão no super e em quem criou, versão 1, rosto montado e excluir', async () => {
    const { company, db } = await cenario();
    const superProfile = await db.profile.create({ data: { name: 'super' } });
    const body = { persona: 'Ana Júlia', role: 'Analista de Compras', name: 'Compras', description: 'Pedidos de compra e fornecedores', avatar: 'r:ovo.ciano.oculos.cb.calma', provider: 'fake', model: 'fake', instructions: 'Você ajuda o time de compras a acompanhar pedidos e fornecedores.', tools: ['listar_propostas'] };
    await api().post('/ai/bots').set(auth(company.id, ['usar_bots'])).send(body).expect(403);
    await api().post('/ai/bots').set(auth(company.id)).send({ ...body, instructions: 'curta' }).expect(400);
    await api().post('/ai/bots').set(auth(company.id)).send({ ...body, tools: ['apagar_tudo'] }).expect(400);
    const created = (await api().post('/ai/bots').set(auth(company.id)).send(body).expect(201)).body;
    expect(created).toMatchObject({ key: 'ana_julia', permissionKey: 'usar_bot_ana_julia', version: 1, custom: true, avatar: 'r:ovo.ciano.oculos.cb.calma', persona: 'Ana Júlia', role: 'Analista de Compras', name: 'Compras' });
    const permission = await db.permission.findUniqueOrThrow({ where: { name: 'usar_bot_ana_julia' } });
    expect(permission.group).toBe('bots');
    expect(await db.profilePermission.count({ where: { profileId: superProfile.id, permissionId: permission.id } })).toBe(1);
    expect(await db.userPermission.count({ where: { userId, permissionId: permission.id } })).toBe(1);
    expect(await db.ai_BotVersion.count({ where: { botId: created.id, version: 1 } })).toBe(1);
    // mesmo nome de novo: chave com número; padrão não vira chave de bot criado
    const second = (await api().post('/ai/bots').set(auth(company.id)).send(body).expect(201)).body;
    expect(second.key).toBe('ana_julia_2');
    const gestaoClone = (await api().post('/ai/bots').set(auth(company.id)).send({ ...body, persona: 'Gestão' }).expect(201)).body;
    expect(gestaoClone.key).toBe('gestao_2');
    // rosto inválido cai no padrão; rosto montado pode ser trocado
    await api().put(`/ai/bots/${created.id}`).set(auth(company.id)).send({ avatar: 'r:<script>' }).expect(200);
    expect((await db.ai_Bot.findUniqueOrThrow({ where: { id: created.id } })).avatar).toBeNull();
    // personalidade de trabalho (Big Five) guardada no rosto entra no prompt
    await api().put(`/ai/bots/${created.id}`).set(auth(company.id)).send({ avatar: 'r:ovo.ciano.oculos.cb.analitico' }).expect(200);
    const conversa = (await api().post(`/ai/bots/${created.id}/conversations`).set(auth(company.id, [...ALL, 'usar_bot_ana_julia'])).expect(201)).body;
    FakeProvider.script([() => ({ text: 'Oi.' })]);
    const { runId } = (await api().post(`/ai/conversations/${conversa.id}/messages`).set(auth(company.id, [...ALL, 'usar_bot_ana_julia'])).send({ text: 'Oi' }).expect(201)).body;
    expect((await waitRun(company.id, runId, [...ALL, 'usar_bot_ana_julia'])).status).toBe('done');
    expect(FakeProvider.requests[0].system).toContain('## Seu jeito de trabalhar (analítico)');
    expect(FakeProvider.requests[0].system).toContain('confira números e somas');
    expect(FakeProvider.requests[0].system).toContain('Tom sóbrio e conciso');
    // traços sob medida: "t" + 5 níveis
    await api().put(`/ai/bots/${created.id}`).set(auth(company.id)).send({ avatar: 'r:ovo.ciano.oculos.cb.t51511' }).expect(200);
    const conversa2 = (await api().post(`/ai/bots/${created.id}/conversations`).set(auth(company.id, [...ALL, 'usar_bot_ana_julia'])).expect(201)).body;
    FakeProvider.script([() => ({ text: 'Oi.' })]);
    const run2 = (await api().post(`/ai/conversations/${conversa2.id}/messages`).set(auth(company.id, [...ALL, 'usar_bot_ana_julia'])).send({ text: 'Oi' }).expect(201)).body;
    await waitRun(company.id, run2.runId, [...ALL, 'usar_bot_ana_julia']);
    const system = FakeProvider.requests[0].system as string;
    expect(system).toContain('## Seu jeito de trabalhar\n');
    expect(system).toContain('proponha duas ou três alternativas');
    expect(system).toContain('Tom caloroso e entusiasmado');
    expect(system).toContain('destaque riscos');
    const config2 = (await api().get('/ai/bots/config').set(auth(company.id)).expect(200)).body;
    expect(config2.personalities.profiles.map((item: any) => item.id)).toContain('analitico');
    // quem tem a permissão conversa com ele
    const usable = (await api().get('/ai/bots').set(auth(company.id, ['usar_bots', 'usar_bot_ana_julia'])).expect(200)).body;
    expect(usable.map((bot: any) => bot.key)).toEqual(['ana_julia']);
    // padrão não exclui; criado exclui e some das listas
    const config = (await api().get('/ai/bots/config').set(auth(company.id)).expect(200)).body;
    const gestao = config.bots.find((item: any) => item.key === 'gestao');
    expect(gestao.custom).toBe(false);
    await api().delete(`/ai/bots/${gestao.id}`).set(auth(company.id)).expect(400);
    await api().delete(`/ai/bots/${created.id}`).set(auth(company.id, ['usar_bots'])).expect(403);
    await api().delete(`/ai/bots/${created.id}`).set(auth(company.id)).expect(200);
    const after = (await api().get('/ai/bots/config').set(auth(company.id)).expect(200)).body;
    expect(after.bots.map((item: any) => item.key)).not.toContain('ana_julia');
    await api().get('/ai/bots').set(auth(company.id, ['usar_bots', 'usar_bot_ana_julia'])).expect(200).expect([]);
    // a chave continua ocupada (conversas antigas guardadas)
    expect((await api().post('/ai/bots').set(auth(company.id)).send(body).expect(201)).body.key).toBe('ana_julia_3');
  });

  it('escolha de modelo: catálogo com preço e troca de todos os bots de uma vez', async () => {
    const { company, db } = await cenario();
    const config = (await api().get('/ai/bots/config').set(auth(company.id)).expect(200)).body;
    const hydrogen = config.models.find((model: any) => model.id === 'gemini-4-hydrogen');
    expect(hydrogen).toMatchObject({ provider: 'gemini', recommended: true, price: { input: 1.5, output: 7.5 } });
    expect(hydrogen.perThousand).toBeCloseTo(36.7, 1);
    expect(config.models.filter((model: any) => model.recommended)).toHaveLength(1);
    const total = config.bots.length;

    const result = (await api().put('/ai/bots/model').set(auth(company.id)).send({ provider: 'gemini', model: 'gemini-4-hydrogen' }).expect(200)).body;
    expect(result).toEqual({ changed: total, total });
    const rows = await db.ai_Bot.findMany({ where: { companyId: company.id } });
    expect(rows.every((row) => row.provider === 'gemini' && row.model === 'gemini-4-hydrogen' && row.version === 2)).toBe(true);
    // de novo não muda nada nem cria versão
    expect((await api().put('/ai/bots/model').set(auth(company.id)).send({ provider: 'gemini', model: 'gemini-4-hydrogen' }).expect(200)).body.changed).toBe(0);
    await api().put('/ai/bots/model').set(auth(company.id)).send({ provider: 'skynet', model: 'x1' }).expect(400);
    await api().put('/ai/bots/model').set(auth(company.id, ['usar_bots'])).send({ provider: 'gemini', model: 'gemini-4-hydrogen' }).expect(403);
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
