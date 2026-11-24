import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { FakeProvider } from 'src/features/ai/providers/fake.provider';
import { monthOf } from 'src/features/ai/engine/usage.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * Economia nos bots: modo econômico por etapa (o principal decide quando grava),
 * consulta repetida no mesmo pedido, teto da empresa e por bot, gasto por bot.
 */
describe('Bots de IA: economia (e2e)', () => {
  const ALL = ['usar_bots', 'usar_bot_treinamentos', 'list_classes', 'create_classes', 'update_classes', 'view_auditoria_bots', 'update_bots'];
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
  beforeEach(async () => { await resetDb(); await flushCache(); delete process.env.AI_MONTHLY_BUDGET_USD; FakeProvider.withRaw = false; FakeProvider.disabled.clear(); });

  const auth = (companyId: number, permissions: string[] = ALL) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());

  async function cenario(economyMode = true, economyProvider = 'fake') {
    const company = await makeCompany();
    userId = (await makeSeller(company.id, { name: 'Ana Gestora' })).id;
    const course = await makeCourse(company.id);
    const inicio = new Date(Date.now() + 10 * 86400000);
    const turma = await makeCourseClass(company.id, course.id, { name: 'NR-35 Dezembro', initialDate: inicio, finalDate: new Date(inicio.getTime() + 86400000), maxSubscriptions: 12, unlimitedSubscriptions: false, openClass: false, active: true });
    const bots = (await api().get('/ai/bots').set(auth(company.id)).expect(200)).body;
    const lia = bots.find((bot: any) => bot.key === 'treinamentos');
    const saved = (await api().put(`/ai/bots/${lia.id}`).set(auth(company.id)).send({ provider: 'fake', model: 'fake-principal', economyProvider, economyModel: 'fake-eco', economyMode }).expect(200)).body;
    expect(saved).toMatchObject({ model: 'fake-principal', economyModel: 'fake-eco', economyMode });
    const conversation = (await api().post(`/ai/bots/${lia.id}/conversations`).set(auth(company.id)).expect(201)).body;
    return { company, turma, bot: lia, conversation, db: testDb() };
  }
  async function say(companyId: number, conversationId: number, text: string, status = 201) {
    const res = await api().post(`/ai/conversations/${conversationId}/messages`).set(auth(companyId)).send({ text }).expect(status);
    if (status !== 201) return null;
    for (let i = 0; i < 100; i++) {
      const run = (await api().get(`/ai/runs/${res.body.runId}`).set(auth(companyId)).expect(200)).body;
      if (run.status !== 'running') return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('execução não terminou');
  }
  const models = () => FakeProvider.requests.map((req) => req.model);

  it('consulta e conversa vão no econômico; a execução conta os passos e o custo de cada um', async () => {
    const { company, conversation, db } = await cenario();
    FakeProvider.script([() => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }), () => ({ text: 'Tem a NR-35 Dezembro.' })]);
    const run = await say(company.id, conversation.id, 'Quais turmas tem?');
    expect(run.status).toBe('done');
    expect(models()).toEqual(['fake-eco', 'fake-eco']);
    const row = await db.ai_Run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row).toMatchObject({ primarySteps: 0, economySteps: 2, escalations: 0 });
    expect(Number(row.economyCostUsd)).toBeCloseTo(Number(row.costUsd), 6);
    expect(Number(row.costUsd)).toBeGreaterThan(0);
  });

  it('modo desligado: tudo no principal', async () => {
    const { company, conversation } = await cenario(false);
    FakeProvider.script([() => ({ text: 'Oi!' })]);
    await say(company.id, conversation.id, 'oi');
    expect(models()).toEqual(['fake-principal']);
  });

  it('escala para o principal quando o econômico pede ferramenta draft ou sensível', async () => {
    const { company, turma, conversation, db } = await cenario();
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'publicar_turma', input: { turmaId: turma.id } }] }), // econômico: descartado
      () => ({ toolCalls: [{ name: 'publicar_turma', input: { turmaId: turma.id } }] }), // principal decide e chama
      () => ({ text: 'Deixei o cartão para você confirmar.' }), // econômico escreve a resposta
    ]);
    const run = await say(company.id, conversation.id, 'publica a turma');
    expect(run.status).toBe('done');
    expect(models()).toEqual(['fake-eco', 'fake-principal', 'fake-eco']);
    expect(run.steps.map((step: any) => [step.tool, step.status])).toEqual([['publicar_turma', 'pending']]);
    // a resposta descartada não entra na conversa nem no histórico
    const assistants = await db.ai_Message.findMany({ where: { conversationId: conversation.id, role: 'assistant' }, orderBy: { id: 'asc' } });
    expect(assistants.map((message) => message.model)).toEqual(['fake-principal', 'fake-eco']);
    expect(FakeProvider.requests[1].messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    expect(await db.ai_Run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ primarySteps: 1, economySteps: 2, escalations: 1 });
    // o custo da tentativa descartada também conta
    const usage = (await api().get('/ai/usage').set(auth(company.id)).expect(200)).body;
    expect(usage.rows.find((item: any) => item.model === 'fake-eco').calls).toBe(2);
  });

  it('duas recusas ou erros de ferramenta seguidos: o resto do pedido vai no principal', async () => {
    const { company, conversation } = await cenario();
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'nao_existe', input: {} }] }),
      () => ({ toolCalls: [{ name: 'nao_existe', input: {} }] }),
      () => ({ text: 'Não consegui.' }),
    ]);
    await say(company.id, conversation.id, 'faz algo');
    expect(models()).toEqual(['fake-eco', 'fake-eco', 'fake-principal']);
  });

  it('consulta repetida igual no mesmo pedido não roda de novo (argumentos em outra ordem também)', async () => {
    const { company, conversation, db } = await cenario(false);
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'listar_turmas', input: { abertas: true, dias: 30 } }] }),
      () => ({ toolCalls: [{ name: 'listar_turmas', input: { dias: 30, abertas: true } }] }),
      () => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }),
      () => ({ text: 'ok' }),
    ]);
    const run = await say(company.id, conversation.id, 'turmas?');
    expect(run.steps.map((step: any) => step.status)).toEqual(['ok', 'ok', 'ok']);
    const same = FakeProvider.requests[2].messages.filter((message) => message.role === 'tool') as any[];
    expect(same[1].results[0].content).toBe(same[0].results[0].content);
    // só duas consultas de verdade (a repetida veio guardada)
    expect(await db.ai_ToolCall.count({ where: { tool: 'listar_turmas' } })).toBe(2);
    // em outro pedido, consulta de novo
    FakeProvider.script([() => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }), () => ({ text: 'ok' })]);
    await say(company.id, conversation.id, 'de novo');
    expect(await db.ai_ToolCall.count({ where: { tool: 'listar_turmas' } })).toBe(3);
  });

  it('teto da empresa: parar ou passar todos para o econômico; aviso de X% uma vez por mês', async () => {
    const { company, turma, bot, conversation, db } = await cenario(false);
    const initial = (await api().get('/ai/budget').set(auth(company.id)).expect(200)).body;
    expect(initial).toMatchObject({ monthlyBudgetUsd: null, warnPercent: 80, onExceed: 'parar', budget: 50, spent: 0, mode: 'ok' });
    await api().get('/ai/budget').set(auth(company.id, ['usar_bots', 'view_auditoria_bots'])).expect(403);
    await api().put('/ai/budget').set(auth(company.id)).send({ onExceed: 'economico' }).expect(400); // sem modelo econômico
    await api().put('/ai/budget').set(auth(company.id)).send({ warnPercent: 0 }).expect(400);

    await db.ai_Usage.create({ data: { companyId: company.id, month: monthOf(), provider: 'fake', model: 'fake-principal', calls: 1, costUsd: 1 } });
    const saved = (await api().put('/ai/budget').set(auth(company.id)).send({ monthlyBudgetUsd: 1, warnPercent: 50 }).expect(200)).body;
    expect(saved).toMatchObject({ monthlyBudgetUsd: 1, budget: 1, spent: 1, percent: 100, warning: true, mode: 'stop' });
    await say(company.id, conversation.id, 'oi', 403);

    // a variável do servidor continua como limite superior
    await api().put('/ai/budget').set(auth(company.id)).send({ monthlyBudgetUsd: 10 }).expect(200);
    process.env.AI_MONTHLY_BUDGET_USD = '0.5';
    expect((await api().get('/ai/budget').set(auth(company.id)).expect(200)).body).toMatchObject({ budget: 0.5, envCap: 0.5, mode: 'stop' });
    delete process.env.AI_MONTHLY_BUDGET_USD;

    await api().put('/ai/budget').set(auth(company.id)).send({ monthlyBudgetUsd: 1, onExceed: 'economico', economyProvider: 'fake', economyModel: 'fake-barato' }).expect(200);
    FakeProvider.script([() => ({ toolCalls: [{ name: 'publicar_turma', input: { turmaId: turma.id } }] }), () => ({ text: 'ok' })]);
    const run = await say(company.id, conversation.id, 'publica');
    expect(run.status).toBe('done');
    // estourado: tudo no econômico da empresa, sem escalar (nem para ação sensível)
    expect(models()).toEqual(['fake-barato', 'fake-barato']);
    expect(await db.ai_Run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ economySteps: 2, primarySteps: 0, escalations: 0 });

    // aviso uma vez só no mês
    const warnings = await db.ai_Report.findMany({ where: { companyId: company.id } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].title).toMatch(/Gasto com IA chegou a \d+% do teto/);
    expect((await db.ai_Settings.findUniqueOrThrow({ where: { companyId: company.id } })).warnedMonth).toBe(monthOf());

    // teto por bot
    await api().put('/ai/budget').set(auth(company.id)).send({ monthlyBudgetUsd: 100, onExceed: 'parar', botBudgets: { [bot.id]: 0.001 } }).expect(200);
    await say(company.id, conversation.id, 'oi', 403);
    await api().put('/ai/budget').set(auth(company.id)).send({ botBudgets: {} }).expect(200);
    FakeProvider.script([() => ({ text: 'oi' })]);
    expect((await say(company.id, conversation.id, 'oi'))!.status).toBe('done');
  });

  it('gasto do mês por bot, agendamentos e MCP em linhas próprias, e por modelo', async () => {
    const { company, bot, conversation, db } = await cenario();
    FakeProvider.script([() => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }), () => ({ text: 'ok' })]);
    await say(company.id, conversation.id, 'turmas?');
    const scheduled = await db.ai_Conversation.create({ data: { companyId: company.id, userId, botId: bot.id, origin: 'schedule', title: 'Agenda' } });
    await db.ai_Run.create({ data: { conversationId: scheduled.id, userId, status: 'done', costUsd: 0.5, primarySteps: 1 } });
    await db.ai_ToolCall.create({ data: { companyId: company.id, userId, origin: 'mcp', tool: 'listar_turmas', input: {}, status: 'ok' } });

    await api().get('/ai/usage/bots').set(auth(company.id, ['usar_bots'])).expect(403);
    const out = (await api().get('/ai/usage/bots').set(auth(company.id)).expect(200)).body;
    expect(out.month).toBe(monthOf());
    const lia = out.rows.find((row: any) => row.kind === 'bot');
    expect(lia).toMatchObject({ botId: bot.id, runs: 1, economySteps: 2, primarySteps: 0, escalations: 0, economyMode: true, economyModel: 'fake-eco' });
    expect(lia.costUsd).toBeGreaterThan(0);
    expect(out.rows.find((row: any) => row.kind === 'schedule')).toMatchObject({ label: 'Agendamentos', runs: 1, costUsd: 0.5 });
    expect(out.rows.find((row: any) => row.kind === 'mcp')).toMatchObject({ runs: 1, costUsd: 0 });
    expect(out.byModel.map((row: any) => row.model)).toEqual(['fake-eco']);
  });

  it('aplica o econômico a vários bots; ligar sem modelo é recusado', async () => {
    const { company, db } = await cenario(false);
    const bots = (await api().get('/ai/bots/config').set(auth(company.id)).expect(200)).body.bots;
    const outro = bots.find((item: any) => item.key !== 'treinamentos' && !item.economyModel);
    await api().put(`/ai/bots/${outro.id}`).set(auth(company.id)).send({ economyMode: true }).expect(400);
    const ids = bots.map((item: any) => item.id);
    expect((await api().put('/ai/bots/economy').set(auth(company.id)).send({ botIds: ids, economyProvider: 'fake', economyModel: 'fake-eco', economyMode: true }).expect(200)).body).toEqual({ changed: ids.length });
    expect(await db.ai_Bot.count({ where: { companyId: company.id, economyMode: true, economyModel: 'fake-eco' } })).toBe(ids.length);
    // não muda o modelo principal nem cria versão
    const lia = await db.ai_Bot.findFirstOrThrow({ where: { companyId: company.id, key: 'treinamentos' } });
    expect(lia.model).toBe('fake-principal');
    await api().put('/ai/bots/economy').set(auth(company.id)).send({ botIds: [] }).expect(400);
  });
  it('econômico em outro fornecedor: troca no meio do pedido e escala de volta para o principal', async () => {
    const { company, turma, conversation, db } = await cenario(true, 'fake2');
    FakeProvider.withRaw = true;
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }), // fake2 (econômico) consulta
      () => ({ toolCalls: [{ name: 'publicar_turma', input: { turmaId: turma.id } }] }), // fake2 quer publicar: descartado
      () => ({ toolCalls: [{ name: 'publicar_turma', input: { turmaId: turma.id } }] }), // fake (principal) decide
      () => ({ text: 'Deixei o cartão.' }), // fake2 responde
    ]);
    const run = await say(company.id, conversation.id, 'vê e publica');
    expect(run.status).toBe('done');
    expect(FakeProvider.requests.map((req) => `${req.provider}/${req.model}`)).toEqual(['fake2/fake-eco', 'fake2/fake-eco', 'fake/fake-principal', 'fake2/fake-eco']);
    // o principal recebe o histórico do outro fornecedor convertido (sem o raw dele)...
    expect(FakeProvider.requests[2].messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect((FakeProvider.requests[2].messages[1] as any).toolCalls[0].name).toBe('listar_turmas');
    expect(FakeProvider.requests[2].rawSeen).toBe(0);
    // ...e o econômico, na volta, reaproveita só o raw dele (não o do principal)
    expect(FakeProvider.requests[3].messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    expect(FakeProvider.requests[3].rawSeen).toBe(1);
    expect(run.steps.map((step: any) => [step.tool, step.status])).toEqual([['listar_turmas', 'ok'], ['publicar_turma', 'pending']]);
    const assistants = await db.ai_Message.findMany({ where: { conversationId: conversation.id, role: 'assistant' }, orderBy: { id: 'asc' } });
    expect(assistants.map((message) => message.provider)).toEqual(['fake2', 'fake', 'fake2']);
    expect(await db.ai_Run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ primarySteps: 1, economySteps: 3, escalations: 1 });
  });

  it('econômico sem chave: usa o principal e a tela avisa', async () => {
    const { company, bot, conversation } = await cenario(true, 'fake2');
    FakeProvider.disabled.add('fake2');
    const config = (await api().get('/ai/bots/config').set(auth(company.id)).expect(200)).body.bots.find((item: any) => item.id === bot.id);
    expect(config).toMatchObject({ economyProvider: 'fake2', economyMode: true, economyReady: false });
    FakeProvider.script([() => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }), () => ({ text: 'ok' })]);
    expect((await say(company.id, conversation.id, 'turmas?'))!.status).toBe('done');
    expect(FakeProvider.requests.map((req) => req.provider)).toEqual(['fake', 'fake']);
  });

  it('precisão máxima: tudo no principal sem apagar o econômico dos bots; o teto com "econômico" ainda vale', async () => {
    const { company, bot, conversation, db } = await cenario(true);
    expect((await api().put('/ai/budget').set(auth(company.id)).send({ maxPrecision: true }).expect(200)).body).toMatchObject({ maxPrecision: true });
    FakeProvider.script([() => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }), () => ({ text: 'ok' })]);
    await say(company.id, conversation.id, 'turmas?');
    expect(models()).toEqual(['fake-principal', 'fake-principal']);
    expect(await db.ai_Bot.findUniqueOrThrow({ where: { id: bot.id } })).toMatchObject({ economyMode: true, economyModel: 'fake-eco' });

    // estourou o teto com "passar para o econômico": a proteção vale mesmo com precisão máxima
    await db.ai_Usage.create({ data: { companyId: company.id, month: monthOf(), provider: 'fake', model: 'x', calls: 1, costUsd: 5 } });
    await api().put('/ai/budget').set(auth(company.id)).send({ monthlyBudgetUsd: 1, onExceed: 'economico', economyProvider: 'fake2', economyModel: 'fake-barato' }).expect(200);
    FakeProvider.script([() => ({ text: 'ok' })]);
    await say(company.id, conversation.id, 'oi');
    expect(FakeProvider.requests.map((req) => `${req.provider}/${req.model}`)).toEqual(['fake2/fake-barato']);

    // desligando, volta ao econômico do bot
    await api().put('/ai/budget').set(auth(company.id)).send({ maxPrecision: false, monthlyBudgetUsd: 100 }).expect(200);
    FakeProvider.script([() => ({ text: 'ok' })]);
    await say(company.id, conversation.id, 'oi');
    expect(models()).toEqual(['fake-eco']);
  });
});
