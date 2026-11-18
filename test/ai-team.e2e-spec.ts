import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { FakeProvider } from 'src/features/ai/providers/fake.provider';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * A equipe conversando: um bot pergunta a um colega (que só consulta) e usa a
 * resposta; ou passa a conversa para o colega com o resumo. Tudo com o
 * fornecedor simulado.
 */
describe('Bots — equipe conversando (e2e)', () => {
  const ALL = ['usar_bots', 'usar_bot_treinamentos', 'usar_bot_marketing', 'usar_bot_gestao', 'list_classes', 'create_classes', 'update_classes', 'list_blog', 'create_blog', 'equipe_bots'];
  let jwt: JwtService;
  let catalog: ToolCatalogService;
  let userId = 0;

  beforeAll(async () => {
    process.env.AI_DEFAULT_PROVIDER = 'fake';
    process.env.AI_MODEL_FAST = 'fake';
    process.env.AI_MODEL_STRONG = 'fake';
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    catalog = app.get(ToolCatalogService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());

  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id, { name: 'Ana Gestora' })).id;
    const course = await makeCourse(company.id);
    const inicio = new Date(Date.now() + 10 * 86400000);
    await makeCourseClass(company.id, course.id, { name: 'NR-35 Dezembro', initialDate: inicio, finalDate: new Date(inicio.getTime() + 86400000), maxSubscriptions: 12, unlimitedSubscriptions: false, openClass: true, active: true });
    return { company, db: testDb() };
  }
  async function botOf(companyId: number, key: string, permissions = ALL) {
    const bots = (await api().get('/ai/bots').set(auth(companyId, permissions)).expect(200)).body;
    return bots.find((bot: any) => bot.key === key);
  }
  async function say(companyId: number, conversationId: number, text: string, permissions = ALL) {
    const { runId } = (await api().post(`/ai/conversations/${conversationId}/messages`).set(auth(companyId, permissions)).field('text', text).expect(201)).body;
    for (let i = 0; i < 200; i++) {
      const run = (await api().get(`/ai/runs/${runId}`).set(auth(companyId, permissions)).expect(200)).body;
      if (run.status !== 'running') return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('execução não terminou');
  }
  const toolNames = (index: number) => FakeProvider.requests[index].tools.map((tool) => tool.name);

  it('pergunta ao colega, que só consulta, e usa a resposta', async () => {
    const { company, db } = await cenario();
    const helena = await botOf(company.id, 'gestao');
    const conversation = (await api().post(`/ai/bots/${helena.id}/conversations`).set(auth(company.id)).expect(201)).body;
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'pedir_ao_colega', input: { colega: 'treinamentos', pedido: 'Quais turmas abertas temos?' } }] }),
      () => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }),
      () => ({ text: 'Uma turma aberta: NR-35 Dezembro.' }),
      () => ({ text: 'Consultei a Lia: temos a turma NR-35 Dezembro aberta.' }),
    ]);
    const run = await say(company.id, conversation.id, 'Como estão as turmas?');
    expect(run.status).toBe('done');
    expect(run.steps.map((step: any) => step.label)).toEqual(['Perguntando ao colega (treinamentos)']);

    // Helena vê a equipe; o colega não vê as ferramentas da equipe nem as que alteram
    expect(FakeProvider.requests[0].system).toContain('## Sua equipe');
    expect(FakeProvider.requests[0].system).toMatch(/- treinamentos: Lia/);
    expect(toolNames(0)).toEqual(expect.arrayContaining(['pedir_ao_colega', 'passar_para_colega']));
    expect(FakeProvider.requests[1].system).toContain('## Pedido de um colega');
    expect(FakeProvider.requests[1].system).not.toContain('## Sua equipe');
    expect(toolNames(1)).toContain('listar_turmas');
    expect(toolNames(1)).not.toContain('nova_turma_rascunho');
    expect(toolNames(1)).not.toContain('pedir_ao_colega');
    expect((FakeProvider.requests[1].messages[0] as any).text).toContain('[Helena pergunta]');
    const back = JSON.stringify(FakeProvider.requests[3].messages.at(-1));
    expect(back).toContain('NR-35 Dezembro');
    expect(back).toContain('Lia');

    // a conversa do colega fica à parte: não aparece na lista da pessoa
    const side = await db.ai_Conversation.findFirst({ where: { companyId: company.id, origin: 'colega' } });
    expect(side).toMatchObject({ botId: (await botOf(company.id, 'treinamentos')).id, userId });
    const lia = await botOf(company.id, 'treinamentos');
    expect((await api().get(`/ai/bots/${lia.id}/conversations`).set(auth(company.id)).expect(200)).body).toHaveLength(0);
  });

  it('passa a conversa para o colega com o resumo', async () => {
    const { company } = await cenario();
    const helena = await botOf(company.id, 'gestao');
    const nina = await botOf(company.id, 'marketing');
    const conversation = (await api().post(`/ai/bots/${helena.id}/conversations`).set(auth(company.id)).expect(201)).body;
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'passar_para_colega', input: { colega: 'marketing', resumo: 'Quer um post sobre a turma NR-35 Dezembro para o Instagram.', titulo: 'Post da NR-35' } }] }),
      () => ({ text: 'Passei para a Nina; continue por lá.' }),
    ]);
    expect((await say(company.id, conversation.id, 'Quero divulgar a turma de NR-35')).status).toBe('done');
    const view = (await api().get(`/ai/conversations/${conversation.id}`).set(auth(company.id)).expect(200)).body;
    const handoff = view.messages.find((message: any) => message.role === 'tool').results[0].handoff;
    expect(handoff).toMatchObject({ botId: nina.id, persona: 'Nina' });

    const opened = (await api().get(`/ai/conversations/${handoff.conversationId}`).set(auth(company.id)).expect(200)).body;
    expect(opened).toMatchObject({ botId: nina.id, title: 'Post da NR-35' });
    expect(opened.messages).toHaveLength(1);
    expect(opened.messages[0]).toMatchObject({ role: 'notice' });
    expect(opened.messages[0].text).toContain('Helena passou esta conversa para Nina');
    expect((await api().get(`/ai/bots/${nina.id}/conversations`).set(auth(company.id)).expect(200)).body.map((item: any) => item.id)).toContain(handoff.conversationId);

    // na primeira mensagem, a Nina já recebe o resumo
    FakeProvider.script([() => ({ text: 'Vou montar o post.' })]);
    expect((await say(company.id, handoff.conversationId, 'Pode ser algo animado')).status).toBe('done');
    const sent = JSON.stringify(FakeProvider.requests[0].messages);
    expect(sent).toContain('Quer um post sobre a turma NR-35 Dezembro');
    expect(FakeProvider.requests[0].messages.at(-1)).toMatchObject({ role: 'user', text: 'Pode ser algo animado' });
    expect((await api().get(`/ai/conversations/${handoff.conversationId}`).set(auth(company.id)).expect(200)).body.title).toBe('Post da NR-35');
  });

  it('respeita as permissões: sem equipe_bots não há colega; sem acesso ao colega, recusa; MCP não vê', async () => {
    const { company, db } = await cenario();
    const semEquipe = ALL.filter((item) => item !== 'equipe_bots');
    const helena = await botOf(company.id, 'gestao', semEquipe);
    const conversation = (await api().post(`/ai/bots/${helena.id}/conversations`).set(auth(company.id, semEquipe)).expect(201)).body;
    FakeProvider.script([() => ({ text: 'Ok.' })]);
    await say(company.id, conversation.id, 'Oi', semEquipe);
    expect(toolNames(0)).not.toContain('pedir_ao_colega');
    expect(FakeProvider.requests[0].system).not.toContain('## Sua equipe');

    // pede a um colega que a pessoa não usa (comercial) e a um que não existe
    const other = (await api().post(`/ai/bots/${helena.id}/conversations`).set(auth(company.id)).expect(201)).body;
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'pedir_ao_colega', input: { colega: 'comercial', pedido: 'Funil?' } }, { name: 'passar_para_colega', input: { colega: 'juridico', resumo: 'x' } }] }),
      () => ({ text: 'Não consegui.' }),
    ]);
    const run = await say(company.id, other.id, 'Funil?');
    expect(run.steps.map((step: any) => step.status)).toEqual(['refused', 'refused']);
    const results = JSON.stringify(FakeProvider.requests[1].messages.at(-1));
    expect(results).toContain('não tem acesso');
    expect(results).toContain('treinamentos (Lia)');
    expect(await db.ai_Conversation.count({ where: { companyId: company.id, origin: 'colega' } })).toBe(0);

    expect(catalog.visible(null, ALL).map((tool) => tool.name)).not.toContain('pedir_ao_colega');
  });
});
