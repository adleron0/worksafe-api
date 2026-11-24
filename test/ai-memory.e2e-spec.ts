import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { FakeProvider } from 'src/features/ai/providers/fake.provider';
import { AgentService, SUMMARY_KEEP, SUMMARY_TRIGGER } from 'src/features/ai/engine/agent.service';
import { MemoryService } from 'src/features/ai/memory/memory.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Memória dos bots: resumo rolante da conversa longa e fatos curtos
 * (lembrar/esquecer), com a tela de ver, editar e limpar. Tudo com o
 * fornecedor simulado.
 */
describe('Bots — memória (e2e)', () => {
  const BASE = ['usar_bots', 'usar_bot_financeiro', 'usar_bot_gestao', 'list_financial', 'view_financial'];
  const GESTOR = [...BASE, 'memoria_bots'];
  let jwt: JwtService;
  let agent: AgentService;
  let memory: MemoryService;

  beforeAll(async () => {
    process.env.AI_DEFAULT_PROVIDER = 'fake';
    process.env.AI_MODEL_FAST = 'fake';
    process.env.AI_MODEL_STRONG = 'fake';
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    agent = app.get(AgentService);
    memory = app.get(MemoryService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, userId: number, permissions: string[] = GESTOR) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());

  async function cenario() {
    const company = await makeCompany();
    const ana = await makeSeller(company.id, { name: 'Ana Gestora' });
    const beto = await makeSeller(company.id, { name: 'Beto Auxiliar' });
    return { company, ana: ana.id, beto: beto.id, db: testDb() };
  }
  async function botOf(companyId: number, userId: number, key: string, permissions = GESTOR) {
    const bots = (await api().get('/ai/bots').set(auth(companyId, userId, permissions)).expect(200)).body;
    return bots.find((bot: any) => bot.key === key);
  }
  async function newConversation(companyId: number, userId: number, botId: number, permissions = GESTOR) {
    return (await api().post(`/ai/bots/${botId}/conversations`).set(auth(companyId, userId, permissions)).expect(201)).body;
  }
  async function say(companyId: number, userId: number, conversationId: number, text: string, permissions = GESTOR) {
    const { runId } = (await api().post(`/ai/conversations/${conversationId}/messages`).set(auth(companyId, userId, permissions)).field('text', text).expect(201)).body;
    for (let i = 0; i < 200; i++) {
      const run = (await api().get(`/ai/runs/${runId}`).set(auth(companyId, userId, permissions)).expect(200)).body;
      if (run.status !== 'running') return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('execução não terminou');
  }
  async function waitFor<T>(check: () => Promise<T | null | undefined | false>): Promise<T> {
    for (let i = 0; i < 100; i++) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('condição não aconteceu');
  }
  const resultOf = (index: number, name: string) => {
    const tool = FakeProvider.requests[index].messages.filter((message: any) => message.role === 'tool').pop() as any;
    return JSON.parse(tool.results.find((result: any) => result.name === name).content);
  };

  // ---------------------------------------------------------------- fatos

  it('anota um fato, ele aparece no prompt da próxima conversa e pode ser substituído', async () => {
    const { company, ana, db } = await cenario();
    const otavio = await botOf(company.id, ana, 'financeiro');
    const first = await newConversation(company.id, ana, otavio.id);
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'lembrar', input: { texto: 'Ana prefere valores sem centavos.' } }] }),
      () => ({ text: 'Anotei: valores sem centavos.' }),
    ]);
    const run = await say(company.id, ana, first.id, 'Me mostra os valores sem centavos, sempre.');
    expect(run.status).toBe('done');
    expect(run.steps.map((step: any) => step.label)).toEqual(['Anotando na memória']);
    // o bot vê as ferramentas e a explicação de quando anotar
    expect(FakeProvider.requests[0].tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['lembrar', 'esquecer']));
    expect(FakeProvider.requests[0].system).toContain('## O que você lembra (anotações)');
    expect(FakeProvider.requests[0].system).toContain('(nenhuma anotação ainda)');
    const saved = await db.ai_Memory.findMany();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ scope: 'pessoa', userId: ana, botId: otavio.id, text: 'Ana prefere valores sem centavos.', conversationId: first.id });

    // conversa nova: o fato entra no prompt, com número e data
    const second = await newConversation(company.id, ana, otavio.id);
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'lembrar', input: { texto: 'Ana prefere valores com centavos.', substitui: saved[0].id } }] }),
      () => ({ text: 'Anotei: agora com centavos.' }),
    ]);
    await say(company.id, ana, second.id, 'Mudei de ideia, quero com centavos.');
    expect(FakeProvider.requests[0].system).toMatch(new RegExp(`### Sobre Ana Gestora\\n- \\[#${saved[0].id}\\] \\(\\d{2}/\\d{2}/\\d{4}\\) Ana prefere valores sem centavos\\.`));
    expect(resultOf(1, 'lembrar')).toMatchObject({ anotado: true, id: saved[0].id, substituiu: 'Ana prefere valores sem centavos.' });
    const after = await db.ai_Memory.findMany();
    expect(after).toHaveLength(1); // substituiu, não acumulou
    expect(after[0].text).toBe('Ana prefere valores com centavos.');

    // a memória é de cada bot: Helena não vê o que o Otávio anotou
    const helena = await botOf(company.id, ana, 'gestao');
    const other = await newConversation(company.id, ana, helena.id);
    FakeProvider.script([() => ({ text: 'Oi.' })]);
    await say(company.id, ana, other.id, 'Oi');
    expect(FakeProvider.requests[0].system).not.toContain('centavos');
  });

  it('fato da empresa exige memoria_bots; sem ela vira pessoal, e cada pessoa só vê o seu', async () => {
    const { company, ana, beto, db } = await cenario();
    const otavio = await botOf(company.id, ana, 'financeiro');

    // Beto não tem memoria_bots: o que ele ensina para a empresa fica só para ele
    const conversaBeto = await newConversation(company.id, beto, otavio.id, BASE);
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'lembrar', input: { texto: 'Combustível vai em Veículos.', escopo: 'empresa' } }] }),
      () => ({ text: 'Anotei.' }),
    ]);
    await say(company.id, beto, conversaBeto.id, 'Combustível sempre em Veículos', BASE);
    expect(resultOf(1, 'lembrar')).toMatchObject({ anotado: true, escopo: 'pessoa', observacao: expect.stringContaining('só para ela') });

    // Ana tem: o fato vale para a empresa
    const conversaAna = await newConversation(company.id, ana, otavio.id);
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'lembrar', input: { texto: 'Despesa com o Posto Central vai em Combustível.', escopo: 'empresa' } }] }),
      () => ({ text: 'Anotei para a empresa.' }),
    ]);
    await say(company.id, ana, conversaAna.id, 'Para todos: Posto Central é Combustível');
    expect(FakeProvider.requests[0].system).not.toContain('Combustível vai em Veículos'); // fato pessoal do Beto
    const empresa = await db.ai_Memory.findFirst({ where: { scope: 'empresa' } });
    expect(empresa).toMatchObject({ userId: null, createdByUserId: ana });

    // Beto vê o da empresa no prompt, mas não pode apagá-lo
    const conversaBeto2 = await newConversation(company.id, beto, otavio.id, BASE);
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'esquecer', input: { id: empresa!.id } }] }),
      () => ({ text: 'Não consegui.' }),
    ]);
    await say(company.id, beto, conversaBeto2.id, 'Esquece a regra do Posto Central', BASE);
    expect(FakeProvider.requests[0].system).toContain('### Da empresa');
    expect(FakeProvider.requests[0].system).toContain('Posto Central vai em Combustível');
    expect(FakeProvider.requests[0].system).toContain('### Sobre Beto Auxiliar');
    const refused = FakeProvider.requests[1].messages.filter((message: any) => message.role === 'tool').pop() as any;
    expect(refused.results[0].isError).toBe(true);
    expect(refused.results[0].content).toContain('não pode apagar anotações da empresa');
    expect(await db.ai_Memory.count({ where: { scope: 'empresa' } })).toBe(1);

    // tela: Beto vê só o seu; Ana vê o seu e o da empresa
    const telaBeto = (await api().get(`/ai/bots/${otavio.id}/memory`).set(auth(company.id, beto, BASE)).expect(200)).body;
    expect(telaBeto.canManageCompany).toBe(false);
    expect(telaBeto.company).toBeNull();
    expect(telaBeto.mine.map((row: any) => row.text)).toEqual(['Combustível vai em Veículos.']);
    const telaAna = (await api().get(`/ai/bots/${otavio.id}/memory`).set(auth(company.id, ana)).expect(200)).body;
    expect(telaAna.mine).toEqual([]);
    expect(telaAna.company).toEqual([expect.objectContaining({ text: 'Despesa com o Posto Central vai em Combustível.', author: 'Você', expiresAt: expect.any(String) })]);

    // Beto não edita nem apaga o da empresa, nem o pessoal de outro
    await api().put(`/ai/memory/${empresa!.id}`).set(auth(company.id, beto, BASE)).send({ text: 'x' }).expect(403);
    await api().delete(`/ai/memory/${empresa!.id}`).set(auth(company.id, beto, BASE)).expect(403);
    await api().post(`/ai/bots/${otavio.id}/memory/clear`).set(auth(company.id, beto, BASE)).send({ escopo: 'empresa' }).expect(403);
    const pessoalBeto = telaBeto.mine[0].id;
    await api().delete(`/ai/memory/${pessoalBeto}`).set(auth(company.id, ana)).expect(404);

    // Beto edita e limpa o dele
    await api().put(`/ai/memory/${pessoalBeto}`).set(auth(company.id, beto, BASE)).send({ text: 'Combustível vai em Veículos (exceto gerador).' }).expect(200);
    await api().put(`/ai/memory/${pessoalBeto}`).set(auth(company.id, beto, BASE)).send({ text: 'x'.repeat(301) }).expect(400);
    expect((await db.ai_Memory.findUnique({ where: { id: pessoalBeto } }))!.text).toBe('Combustível vai em Veículos (exceto gerador).');
    expect((await api().post(`/ai/bots/${otavio.id}/memory/clear`).set(auth(company.id, beto, BASE)).send({ escopo: 'pessoa' }).expect(200)).body).toEqual({ removed: 1 });

    // Ana edita, apaga e limpa o da empresa
    await api().put(`/ai/memory/${empresa!.id}`).set(auth(company.id, ana)).send({ text: 'Posto Central: Combustível.' }).expect(200);
    expect((await api().post(`/ai/bots/${otavio.id}/memory/clear`).set(auth(company.id, ana)).send({ escopo: 'empresa' }).expect(200)).body).toEqual({ removed: 1 });
    expect(await db.ai_Memory.count()).toBe(0);
  });

  it('recusa fato longo, esquece pelo número e respeita o limite', async () => {
    const { company, ana, db } = await cenario();
    const otavio = await botOf(company.id, ana, 'financeiro');
    const conversation = await newConversation(company.id, ana, otavio.id);
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'lembrar', input: { texto: 'a'.repeat(301) } }] }),
      () => ({ toolCalls: [{ name: 'lembrar', input: { texto: 'Pagamentos às sextas.' } }] }),
      () => ({ toolCalls: [{ name: 'lembrar', input: { texto: 'pagamentos às sextas.' } }] }),
      () => ({ text: 'Anotei.' }),
    ]);
    await say(company.id, ana, conversation.id, 'Pago tudo às sextas');
    const longo = FakeProvider.requests[1].messages.filter((message: any) => message.role === 'tool').pop() as any;
    expect(longo.results[0].content).toContain('Resuma em até 300 caracteres');
    expect(resultOf(3, 'lembrar')).toMatchObject({ observacao: 'Isso já estava anotado.' });
    const fact = await db.ai_Memory.findFirstOrThrow();

    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'esquecer', input: { id: fact.id } }] }),
      () => ({ text: 'Esqueci.' }),
    ]);
    await say(company.id, ana, conversation.id, 'Esquece isso');
    expect(resultOf(1, 'esquecer')).toEqual({ esquecido: true, id: fact.id, texto: 'Pagamentos às sextas.' });
    expect(await db.ai_Memory.count()).toBe(0);

    // memória cheia (50 por pessoa): recusa e explica como liberar
    await db.ai_Memory.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ companyId: company.id, botId: otavio.id, scope: 'pessoa', userId: ana, text: `fato ${i}`, createdByUserId: ana })) });
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'lembrar', input: { texto: 'mais um' } }] }),
      () => ({ text: 'Cheia.' }),
    ]);
    await say(company.id, ana, conversation.id, 'Anota mais um');
    // no prompt entram no máximo 20 da pessoa
    expect((FakeProvider.requests[0].system.match(/- \[#\d+\]/g) ?? []).length).toBe(20);
    const cheia = FakeProvider.requests[1].messages.filter((message: any) => message.role === 'tool').pop() as any;
    expect(cheia.results[0].content).toContain('está cheia (50 anotações)');
  });

  it('fatos sem uso há 6 meses expiram; os usados no prompt renovam', async () => {
    const { company, ana, db } = await cenario();
    const otavio = await botOf(company.id, ana, 'financeiro');
    const old = new Date(Date.now() - 200 * 86400000);
    await db.ai_Memory.createMany({ data: [
      { companyId: company.id, botId: otavio.id, scope: 'pessoa', userId: ana, text: 'velho e usado', createdByUserId: ana, lastUsedAt: old },
      { companyId: company.id, botId: otavio.id, scope: 'empresa', userId: null, text: 'velho e esquecido', createdByUserId: ana, lastUsedAt: old },
    ] });
    // entrar no prompt renova o uso; simula que o da empresa ficou de fora
    await memory.forPrompt({ companyId: company.id, userId: ana }, otavio.id);
    await db.ai_Memory.updateMany({ where: { text: 'velho e esquecido' }, data: { lastUsedAt: old } });
    expect(await memory.expire()).toEqual({ removed: 1 });
    expect((await db.ai_Memory.findMany()).map((row) => row.text)).toEqual(['velho e usado']);
  });

  it('colega consultado não anota nada', async () => {
    const { company, ana } = await cenario();
    const helena = await botOf(company.id, ana, 'gestao', [...GESTOR, 'equipe_bots']);
    const conversation = await newConversation(company.id, ana, helena.id, [...GESTOR, 'equipe_bots']);
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'pedir_ao_colega', input: { colega: 'financeiro', pedido: 'Algum dado' } }] }),
      () => ({ text: 'Dado.' }),
      () => ({ text: 'Pronto.' }),
    ]);
    await say(company.id, ana, conversation.id, 'Pergunta ao Otávio', [...GESTOR, 'equipe_bots']);
    // o colega não recebe as ferramentas de memória nem a instrução de anotar
    expect(FakeProvider.requests[1].tools.map((tool) => tool.name)).not.toContain('lembrar');
    expect(FakeProvider.requests[1].system).not.toContain('anote com lembrar');
  });

  // ---------------------------------------------------------------- resumo rolante

  it('conversa longa: resume as antigas e manda resumo + últimas mensagens', async () => {
    const { company, ana, db } = await cenario();
    const otavio = await botOf(company.id, ana, 'financeiro');
    const conversation = await newConversation(company.id, ana, otavio.id);
    // 16 trocas = 32 mensagens (com uma ferramenta de resultado grande no começo)
    const big = JSON.stringify({ linhas: 'x'.repeat(5000) });
    const rows: { role: string; content: any }[] = [];
    for (let i = 0; i < 16; i++) {
      rows.push({ role: 'user', content: { text: `pergunta ${i}` } });
      if (i === 15) {
        rows.push({ role: 'assistant', content: { text: '', toolCalls: [{ id: 't1', name: 'fin_resumo', input: {} }] } });
        rows.push({ role: 'tool', content: { results: [{ toolCallId: 't1', name: 'fin_resumo', content: big }] } });
      }
      rows.push({ role: 'assistant', content: { text: `resposta ${i}` } });
    }
    for (const row of rows) await db.ai_Message.create({ data: { conversationId: conversation.id, role: row.role, content: row.content } });

    FakeProvider.script([
      () => ({ text: 'resposta 16' }),
      (req) => ({ text: req.messages[0].role === 'user' && (req.messages[0] as any).text.includes('pergunta 0') ? 'RESUMO: a Ana fez perguntas de 0 a 7.' : 'resumo errado' }),
    ]);
    const run = await say(company.id, ana, conversation.id, 'pergunta 16');
    expect(run.status).toBe('done');
    // a primeira ida ainda vê tudo (sem resumo); o resultado grande, antigo, entra cortado
    const answer = FakeProvider.requests[0];
    expect(answer.system).not.toContain('## Resumo do começo desta conversa');
    const tool = answer.messages.find((message: any) => message.role === 'tool') as any;
    expect(tool.results[0].content.length).toBeLessThan(1700);
    expect(tool.results[0].content).toContain('[resultado antigo cortado');

    // depois da resposta, o resumo rodou (sem ferramentas) e cobriu as antigas
    const summaryRequest = await waitFor(async () => FakeProvider.requests[1]);
    expect(summaryRequest.tools).toEqual([]);
    expect(summaryRequest.system).toContain('Você resume conversas');
    const saved = await waitFor(() => db.ai_Conversation.findFirst({ where: { id: conversation.id, summary: { not: null } } }));
    expect(saved.summary).toBe('RESUMO: a Ana fez perguntas de 0 a 7.');
    const kept = await db.ai_Message.count({ where: { conversationId: conversation.id, role: { in: ['user', 'assistant', 'tool'] }, id: { gt: saved.summaryUntilId! } } });
    expect(kept).toBeGreaterThanOrEqual(SUMMARY_KEEP);
    expect(kept).toBeLessThan(SUMMARY_TRIGGER);

    // próxima mensagem: resumo no prompt + só as mensagens depois do corte, começando por uma da pessoa
    FakeProvider.script([() => ({ text: 'resposta 17' })]);
    await say(company.id, ana, conversation.id, 'pergunta 17');
    const next = FakeProvider.requests[0];
    expect(next.system).toContain('## Resumo do começo desta conversa');
    expect(next.system).toContain('RESUMO: a Ana fez perguntas de 0 a 7.');
    expect(next.messages[0].role).toBe('user');
    expect(next.messages.some((message: any) => message.text === 'pergunta 0')).toBe(false);
    expect(next.messages[next.messages.length - 1]).toMatchObject({ role: 'user', text: 'pergunta 17' });
    expect(next.messages.length).toBe(kept + 1); // as mantidas + pergunta 17
    // a tela continua com a conversa inteira
    const screen = (await api().get(`/ai/conversations/${conversation.id}`).set(auth(company.id, ana)).expect(200)).body;
    expect(screen.messages.some((message: any) => message.text === 'pergunta 0')).toBe(true);
    // só uma chamada nesta mensagem: não resumiu de novo (abaixo do gatilho)
    expect(FakeProvider.requests).toHaveLength(1);
  });

  it('conversa curta não resume', async () => {
    const { company, ana, db } = await cenario();
    const otavio = await botOf(company.id, ana, 'financeiro');
    const conversation = await newConversation(company.id, ana, otavio.id);
    FakeProvider.script([() => ({ text: 'Oi.' })]);
    await say(company.id, ana, conversation.id, 'Oi');
    expect(FakeProvider.requests).toHaveLength(1);
    expect(await agent.summarize({ companyId: company.id, conversationId: conversation.id }, await db.ai_Bot.findUniqueOrThrow({ where: { id: otavio.id } }))).toBe(false);
    expect((await db.ai_Conversation.findUniqueOrThrow({ where: { id: conversation.id } })).summary).toBeNull();
  });
});
