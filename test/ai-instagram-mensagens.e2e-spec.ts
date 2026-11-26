import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'crypto';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { InstagramMessagesService } from 'src/features/ai/connectors/instagram-messages.service';
import { FakeProvider } from 'src/features/ai/providers/fake.provider';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { ToolContext } from 'src/features/ai/tools/tool.types';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Instagram, parte 2: limites e modos por ação, Direct (webhook assinado,
 * janela de 24 horas, resposta pela tela, pela ferramenta e automática) e
 * comentários. Meta simulada (nock) no login unificado (graph.facebook.com).
 */
describe('Instagram: limites, Direct e comentários (e2e)', () => {
  const PERMS = ['usar_bots', 'usar_mcp', 'conectores_bots', 'instagram_bots', 'instagram_mensagens_bots', 'usar_bot_marketing'];
  const FB = 'https://graph.facebook.com/v27.0';
  const SECRET = 'segredo-do-app';
  let jwt: JwtService;
  let catalog: ToolCatalogService;
  let messages: InstagramMessagesService;
  let userId = 0;

  beforeAll(async () => {
    process.env.AI_DEFAULT_PROVIDER = 'fake';
    process.env.AI_MODEL_FAST = 'fake';
    process.env.AI_MODEL_STRONG = 'fake';
    process.env.PUBLIC_IMAGES_DRIVER = 'memory';
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    catalog = app.get(ToolCatalogService, { strict: false });
    messages = app.get(InstagramMessagesService, { strict: false });
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });
  afterAll(async () => {
    for (const key of ['PUBLIC_IMAGES_DRIVER', 'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_CONFIG_ID', 'INSTAGRAM_WEBHOOK_TOKEN']) delete process.env[key];
    nock.cleanAll();
    nock.enableNetConnect();
    await shutdownTestApp();
  });
  beforeEach(async () => {
    await resetDb();
    await flushCache();
    process.env.INSTAGRAM_APP_ID = '999';
    process.env.INSTAGRAM_APP_SECRET = SECRET;
    process.env.INSTAGRAM_CONFIG_ID = '1511424607547228';
    process.env.INSTAGRAM_WEBHOOK_TOKEN = 'token-de-verificacao';
  });
  afterEach(() => nock.cleanAll());

  const auth = (companyId: number, permissions: string[] = PERMS) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());

  /** Empresa com o Instagram já conectado (login unificado). */
  async function cenario(opts: { connected?: boolean } = {}) {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const db = testDb();
    if (opts.connected !== false) {
      await db.ai_Connector.create({ data: { companyId: company.id, provider: 'instagram', accountId: '1784', username: 'worksafebrasil', accountType: 'BUSINESS', tokenEncrypted: encryptPayload('chave-do-sistema'), connectedByUserId: userId } });
    }
    return { company, db };
  }
  const ctxOf = (companyId: number, permissions = PERMS): ToolContext => ({ userId, companyId, permissions, origin: 'bots' });
  const call = async (ctx: ToolContext, tool: string, input: Record<string, unknown>) => {
    const out = await catalog.call(ctx, tool, input, null);
    return { ...out, data: JSON.parse(out.content) };
  };
  const settings = (companyId: number, body: unknown) => api().put('/ai/connectors/instagram/settings').set(auth(companyId)).send(body as object);

  function sign(raw: string) {
    return `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  }
  function webhook(body: unknown, signature?: string) {
    const raw = JSON.stringify(body);
    const req = api().post('/ai/connectors/instagram/webhook').set('Content-Type', 'application/json');
    if (signature !== '') req.set('X-Hub-Signature-256', signature ?? sign(raw));
    return req.send(raw);
  }
  const dm = (mid: string, text: string, opts: { from?: string; echo?: boolean; at?: number } = {}) => ({
    object: 'instagram',
    entry: [{
      id: '1784', time: Date.now(),
      messaging: [{
        sender: { id: opts.echo ? '1784' : opts.from ?? '555' }, recipient: { id: opts.echo ? opts.from ?? '555' : '1784' }, timestamp: opts.at ?? Date.now(),
        message: { mid, text, ...(opts.echo ? { is_echo: true } : {}) },
      }],
    }],
  });
  async function grant(names: string[]) {
    const db = testDb();
    for (const name of names) {
      const permission = await db.permission.upsert({ where: { name }, create: { name, group: 'bots' }, update: {} });
      await db.userPermission.create({ data: { userId, permissionId: permission.id } });
    }
  }

  // ---------------------------------------------------------------- configurações

  it('configurações: padrões, gravação parcial, validação e permissão', async () => {
    const { company } = await cenario();
    const defaults = (await api().get('/ai/connectors/instagram/settings').set(auth(company.id)).expect(200)).body;
    expect(defaults).toEqual({
      post: { enabled: true, mode: 'confirmar', limitePorDia: 5 },
      story: { enabled: true, mode: 'confirmar', limitePorDia: 10 },
      ler_mensagens: { enabled: true },
      responder_mensagens: { enabled: true, mode: 'confirmar', limitePorDia: 50, horario: { inicio: '08:00', fim: '18:00', diasUteis: true }, instrucoes: '' },
      comentarios: { enabled: true, mode: 'confirmar', limitePorDia: 50 },
    });

    const saved = (await settings(company.id, { post: { limitePorDia: 3, mode: 'automatico' }, responder_mensagens: { horario: { inicio: '09:00' }, instrucoes: ' Datas e vagas de turmas. ' } }).expect(200)).body;
    expect(saved.post).toEqual({ enabled: true, mode: 'automatico', limitePorDia: 3 });
    expect(saved.responder_mensagens).toMatchObject({ mode: 'confirmar', horario: { inicio: '09:00', fim: '18:00', diasUteis: true }, instrucoes: 'Datas e vagas de turmas.' });
    expect((await api().get('/ai/connectors/instagram/settings').set(auth(company.id)).expect(200)).body.post.limitePorDia).toBe(3);

    const bad = async (body: unknown, message: RegExp) => expect((await settings(company.id, body).expect(400)).body.message).toMatch(message);
    await bad({ post: { mode: 'sozinho' } }, /modo precisa ser "confirmar" ou "automatico"/);
    await bad({ post: { limitePorDia: 101 } }, /de 0 a 100/);
    await bad({ story: { limitePorDia: 2.5 } }, /número inteiro/);
    await bad({ post: { limitePorDia: 60 }, story: { limitePorDia: 50 } }, /no máximo 100 publicações/);
    await bad({ responder_mensagens: { horario: { inicio: '8h' } } }, /HH:MM/);
    await bad({ responder_mensagens: { horario: { inicio: '19:00' } } }, /início precisa ser antes do fim/);
    await bad({ ler_mensagens: { enabled: 'sim' } }, /sim ou não/);
    await bad({ whatsapp: {} }, /Ação desconhecida/);
    await bad([1], /objeto/);

    await api().put('/ai/connectors/instagram/settings').set(auth(company.id, ['instagram_bots'])).send({}).expect(403);
    await api().get('/ai/connectors/instagram/settings').set(auth(company.id, ['instagram_bots'])).expect(403);

    const other = await cenario({ connected: false });
    expect((await settings(other.company.id, { post: { limitePorDia: 1 } }).expect(400)).body.message).toMatch(/Conecte o Instagram antes/);
  });

  // ---------------------------------------------------------------- posts

  it('posts respeitam ação ligada e limite do dia; modo automático pula o cartão', async () => {
    const { company, db } = await cenario();
    const img = 'https://imagens.teste.local/instagram/a.jpg';
    const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await settings(company.id, { post: { limitePorDia: 1 }, story: { enabled: false } }).expect(200);

    await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'feed', media: [img], scheduledAt: `${day}T10:00` }).expect(201);
    const limit = (await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'carousel', media: [img, img], scheduledAt: `${day}T23:30` }).expect(400)).body;
    expect(limit.message).toMatch(/Limite do dia atingido: 1 posts no feed e carrosséis por dia/);
    // outro dia, tudo bem (fuso de Brasília: 23h30 do dia anterior ainda é outro dia)
    const before = new Date(new Date(`${day}T12:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
    await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'feed', media: [img], scheduledAt: `${before}T23:30` }).expect(201);

    const story = (await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'story', media: [img] }).expect(400)).body;
    expect(story.message).toMatch(/Publicar stories está desligado/);

    const ctx = ctxOf(company.id);
    const refused = await call(ctx, 'instagram_agendar_post', { tipo: 'feed', imagens: [img], quando: `${day}T18:00` });
    expect(refused.status).toBe('refused');
    expect(refused.data.recusado).toMatch(/Limite do dia/);
    expect((await call(ctx, 'instagram_agendar_post', { tipo: 'story', imagens: [img] })).data.recusado).toMatch(/desligado/);

    // confirmar (padrão): cartão
    const later = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
    const pending = await call(ctx, 'instagram_agendar_post', { tipo: 'feed', imagens: [img], legenda: 'Oi', quando: `${later}T18:00` });
    expect(pending.status).toBe('pending');

    // automático: sai direto, sem ação pendente
    await settings(company.id, { post: { mode: 'automatico', limitePorDia: 5 } }).expect(200);
    const count = await db.ai_SocialPost.count();
    const auto = await call(ctx, 'instagram_agendar_post', { tipo: 'feed', imagens: [img], legenda: 'Direto', quando: `${later}T19:00` });
    expect(auto.status).toBe('ok');
    expect(auto.data).toMatchObject({ situacao: 'feito_automaticamente' });
    expect(await db.ai_SocialPost.count()).toBe(count + 1);
    expect(await db.ai_PendingAction.count()).toBe(1);
    expect((await db.ai_ToolCall.findFirstOrThrow({ orderBy: { id: 'desc' } })).outputSummary).toMatch(/^\[automático\]/);
    expect(catalog.definitions([catalog.get('instagram_agendar_post')!])[0].description).toMatch(/sai direto \(modo automático\) ou vira um cartão/);
  });

  // ---------------------------------------------------------------- webhook

  it('webhook: verificação, assinatura conferida e mensagens gravadas sem duplicar', async () => {
    const { company, db } = await cenario();
    const ok = await api().get('/ai/connectors/instagram/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-de-verificacao', 'hub.challenge': '1158201444' }).expect(200);
    expect(ok.text).toBe('1158201444');
    expect(ok.headers['content-type']).toMatch(/text\/plain/);
    await api().get('/ai/connectors/instagram/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '1' }).expect(403);

    await webhook(dm('m1', 'Oi'), 'sha256=0000').expect(403);
    await webhook(dm('m1', 'Oi'), '').expect(403);
    expect(await db.ai_SocialMessage.count()).toBe(0);

    expect((await webhook(dm('m1', 'Oi, tem turma de NR-35?')).expect(200)).body).toMatchObject({ ok: true, stored: 1 });
    expect((await webhook(dm('m1', 'Oi, tem turma de NR-35?')).expect(200)).body).toMatchObject({ stored: 0 }); // reenvio da Meta
    await webhook(dm('m2', 'Temos sim!', { echo: true })).expect(200);
    await webhook({ ...dm('m3', 'x'), entry: [{ ...dm('m3', 'x').entry[0], id: '0000' }] }).expect(200); // conta de ninguém
    await messages.idle();

    const rows = await db.ai_SocialMessage.findMany({ orderBy: { id: 'asc' } });
    expect(rows.map((row) => [row.externalId, row.direction, row.conversationId, row.companyId, row.status])).toEqual([
      ['m1', 'in', '555', company.id, 'received'],
      ['m2', 'out', '555', company.id, 'sent'],
    ]);

    // as outras rotas continuam lendo JSON normalmente
    await settings(company.id, { post: { limitePorDia: 2 } }).expect(200);
  });

  // ---------------------------------------------------------------- Direct pela tela

  it('Direct pela tela: sincroniza, lista, responde dentro das 24 h e recusa fora', async () => {
    const { company, db } = await cenario();
    const now = Date.now();
    nock(FB).get('/1784/conversations').query((q) => q.platform === 'instagram' && q.access_token === 'chave-do-sistema').reply(200, {
      data: [
        { id: 'conv1', updated_time: new Date(now).toISOString(), participants: { data: [{ id: '1784', username: 'worksafebrasil' }, { id: '555', username: 'joao.silva' }] },
          messages: { data: [
            { id: 's2', created_time: new Date(now - 60000).toISOString().replace('Z', '+0000'), from: { id: '555', username: 'joao.silva' }, message: 'Qual o valor?' },
            { id: 's1', created_time: new Date(now - 3600000).toISOString(), from: { id: '1784', username: 'worksafebrasil' }, message: 'Bom dia!' },
          ] } },
        { id: 'conv2', updated_time: new Date(now - 2 * 86400000).toISOString(), participants: { data: [{ id: '1784' }, { id: '777', username: 'maria' }] },
          messages: { data: [{ id: 's3', created_time: new Date(now - 2 * 86400000).toISOString(), from: { id: '777', username: 'maria' }, message: 'Obrigada' }] } },
      ],
    });
    const list = (await api().get('/ai/instagram/conversations?sync=1').set(auth(company.id)).expect(200)).body;
    expect(list.syncError).toBeNull();
    expect(list.conversations.map((c: any) => [c.id, c.username, c.unread, c.canReply])).toEqual([['555', 'joao.silva', 1, true], ['777', 'maria', 1, false]]);
    expect(list.conversations[0].lastMessage).toMatchObject({ text: 'Qual o valor?', direction: 'in' });

    const conv = (await api().get('/ai/instagram/conversations/555').set(auth(company.id)).expect(200)).body;
    expect(conv.messages.map((m: any) => [m.direction, m.text])).toEqual([['out', 'Bom dia!'], ['in', 'Qual o valor?']]);
    expect(conv.canReply).toBe(true);

    // fora das 24 h: recusa antes de chamar a Meta
    const late = (await api().post('/ai/instagram/conversations/777/reply').set(auth(company.id)).send({ text: 'Oi Maria' }).expect(400)).body;
    expect(late.message).toMatch(/só permite responder no Direct até 24 horas depois da última mensagem do cliente/);

    const sent: any[] = [];
    nock(FB).post('/1784/messages', (body) => { sent.push(body); return true; }).query({ access_token: 'chave-do-sistema' }).reply(200, { recipient_id: '555', message_id: 'out1' });
    const reply = (await api().post('/ai/instagram/conversations/555/reply').set(auth(company.id)).send({ text: 'O valor está na página da turma.' }).expect(200)).body;
    expect(reply).toMatchObject({ ok: true, conversationId: '555', username: 'joao.silva' });
    expect(sent).toEqual([{ recipient: { id: '555' }, message: { text: 'O valor está na página da turma.' } }]);
    const out = await db.ai_SocialMessage.findUniqueOrThrow({ where: { externalId: 'out1' } });
    expect(out).toMatchObject({ direction: 'out', origin: 'system', repliedByUserId: userId });
    // o eco da Meta não duplica
    await webhook(dm('out1', 'O valor está na página da turma.', { echo: true })).expect(200);
    expect(await db.ai_SocialMessage.count({ where: { externalId: 'out1' } })).toBe(1);
    // responder marca como lida
    expect((await api().get('/ai/instagram/conversations').set(auth(company.id)).expect(200)).body.conversations[0].unread).toBe(0);
    expect((await api().post('/ai/instagram/conversations/777/read').set(auth(company.id)).expect(200)).body).toEqual({ ok: true, marked: 1 });

    // limite do dia e texto grande
    await settings(company.id, { responder_mensagens: { limitePorDia: 1 } }).expect(200);
    expect((await api().post('/ai/instagram/conversations/555/reply').set(auth(company.id)).send({ text: 'De novo' }).expect(400)).body.message).toMatch(/Limite do dia atingido: 1 respostas/);
    await settings(company.id, { responder_mensagens: { limitePorDia: 50 } }).expect(200);
    expect((await api().post('/ai/instagram/conversations/555/reply').set(auth(company.id)).send({ text: 'á'.repeat(600) }).expect(400)).body.message).toMatch(/Encurte o texto/);

    // ação desligada e permissão
    await settings(company.id, { ler_mensagens: { enabled: false } }).expect(200);
    expect((await api().get('/ai/instagram/conversations').set(auth(company.id)).expect(400)).body.message).toMatch(/Ler mensagens do Direct está desligado/);
    await api().get('/ai/instagram/conversations').set(auth(company.id, ['instagram_bots'])).expect(403);
  });

  // ---------------------------------------------------------------- Direct pela ferramenta

  it('a Nina responde no Direct com cartão (e recusa fora das 24 h); no MCP também aparece', async () => {
    const { company, db } = await cenario();
    await webhook(dm('m1', 'Tem turma em dezembro?')).expect(200);
    await webhook(dm('m9', 'Oi', { from: '888', at: Date.now() - 30 * 3600000 })).expect(200);
    await messages.idle();
    const ctx = ctxOf(company.id);

    const convs = await call(ctx, 'instagram_conversas', {});
    nock.cleanAll();
    expect(convs.data.conversas.map((c: any) => [c.id, c.podeResponder])).toEqual([['555', true], ['888', false]]);
    expect(convs.data.aviso).toMatch(/Não consegui atualizar pela Meta/); // sem nock da sincronização: avisa e segue

    const read = await call(ctx, 'instagram_ler_conversa', { id: '555' });
    expect(read.data.mensagens).toEqual([expect.objectContaining({ de: 'cliente', texto: 'Tem turma em dezembro?' })]);

    const late = await call(ctx, 'instagram_responder_mensagem', { id: '888', texto: 'Oi!' });
    expect(late.status).toBe('refused');
    expect(late.data.recusado).toMatch(/24 horas/);

    const pending = await call(ctx, 'instagram_responder_mensagem', { id: '555', texto: 'Temos sim, dia 10/12.' });
    expect(pending.status).toBe('pending');
    expect(await db.ai_SocialMessage.count({ where: { direction: 'out' } })).toBe(0);
    nock(FB).post('/1784/messages').query(true).reply(200, { recipient_id: '555', message_id: 'out7' });
    const done = (await api().post(`/ai/actions/${pending.pendingActionId}/confirm`).set(auth(company.id)).expect(200)).body;
    expect(done).toMatchObject({ status: 'confirmada', message: 'Resposta enviada no Direct.' });
    expect(await db.ai_SocialMessage.findUniqueOrThrow({ where: { externalId: 'out7' } })).toMatchObject({ direction: 'out', text: 'Temos sim, dia 10/12.' });

    // sem a permissão nova, não vê nem chama
    const names = catalog.visible(null, ['usar_mcp', 'instagram_bots']).map((tool) => tool.name);
    expect(names).not.toContain('instagram_conversas');
    expect((await call(ctxOf(company.id, ['instagram_bots']), 'instagram_conversas', {})).status).toBe('denied');
    // MCP: as novas aparecem com a permissão
    expect(catalog.visible(null, ['usar_mcp', 'instagram_mensagens_bots']).map((tool) => tool.name).sort()).toEqual(['instagram_comentarios', 'instagram_conversas', 'instagram_ler_conversa', 'instagram_ocultar_comentario', 'instagram_responder_comentario', 'instagram_responder_mensagem', 'minha_esteira']);
  });

  // ---------------------------------------------------------------- resposta automática

  it('o Direct não responde mais sozinho pelos Conectores (agora é o bot das Conversas)', async () => {
    const { company, db } = await cenario();
    await grant(['instagram_mensagens_bots', 'usar_bot_marketing', 'list_classes']);
    await settings(company.id, { responder_mensagens: { mode: 'automatico' } }).expect(200);
    FakeProvider.script([]);
    await webhook(dm('m1', 'Quando é a próxima turma?')).expect(200);
    await messages.idle();
    expect(FakeProvider.requests).toHaveLength(0);
    expect((await db.ai_SocialMessage.findUniqueOrThrow({ where: { externalId: 'm1' } })).status).toBe('received');
  });

  // ---------------------------------------------------------------- comentários

  it('comentários: lista, responde com cartão, oculta e grava o webhook', async () => {
    const { company, db } = await cenario();
    nock(FB).get('/1784/media').query((q) => q.fields === 'id,caption,permalink,timestamp,comments_count').reply(200, {
      data: [{ id: '1801', caption: 'Turma de NR-35', permalink: 'https://www.instagram.com/p/a/', timestamp: '2026-11-20T12:00:00+0000', comments_count: 2 }, { id: '1802', comments_count: 0 }],
    });
    nock(FB).get('/1801/comments').query(true).reply(200, {
      data: [{ id: '17870913679156914', text: 'Tem turma em janeiro?', username: 'ana', timestamp: '2026-11-21T10:00:00+0000', replies: { data: [{ id: '178', text: 'Tem sim', username: 'worksafebrasil' }] } }],
    });
    const screen = (await api().get('/ai/instagram/comments').set(auth(company.id)).expect(200)).body;
    expect(screen.posts).toHaveLength(1);
    expect(screen.posts[0]).toMatchObject({ id: '1801', caption: 'Turma de NR-35' });
    expect(screen.posts[0].comments[0]).toMatchObject({ id: '17870913679156914', username: 'ana', hidden: false, replies: [{ id: '178', text: 'Tem sim' }] });

    const ctx = ctxOf(company.id);
    nock(FB).get('/1801/comments').query(true).reply(200, { data: [{ id: '17870913679156914', text: 'Tem turma em janeiro?', username: 'ana' }] });
    const tool = await call(ctx, 'instagram_comentarios', { postId: '1801' });
    expect(tool.data.posts[0].comentarios[0]).toMatchObject({ id: '17870913679156914', de: '@ana' });

    // responder: cartão → confirma → Meta
    nock(FB).get('/17870913679156914').query(true).reply(200, { id: '17870913679156914', text: 'Tem turma em janeiro?', username: 'ana', media: { id: '1801' } });
    const pending = await call(ctx, 'instagram_responder_comentario', { id: '17870913679156914', texto: 'Tem sim! Te chamamos no Direct.' });
    expect(pending.status).toBe('pending');
    const replies: any[] = [];
    nock(FB).post('/17870913679156914/replies').query((q) => { replies.push(q); return true; }).reply(200, { id: '17999' });
    await api().post(`/ai/actions/${pending.pendingActionId}/confirm`).set(auth(company.id)).expect(200);
    expect(replies[0]).toMatchObject({ message: 'Tem sim! Te chamamos no Direct.', access_token: 'chave-do-sistema' });
    expect(await db.ai_SocialMessage.findUniqueOrThrow({ where: { externalId: 'comment:17999' } })).toMatchObject({ channel: 'comment', direction: 'out', conversationId: '1801', parentId: '17870913679156914', origin: 'system' });

    // ocultar: sempre com cartão
    nock(FB).get('/17870913679156915').query(true).reply(200, { id: '17870913679156915', text: 'Ganhe dinheiro fácil', username: 'golpe', hidden: false, media: { id: '1801' } });
    const hide = await call(ctx, 'instagram_ocultar_comentario', { id: '17870913679156915', motivo: 'golpe' });
    expect(hide.status).toBe('pending');
    const hidden: any[] = [];
    nock(FB).post('/17870913679156915').query((q) => { hidden.push(q); return true; }).reply(200, { success: true });
    await api().post(`/ai/actions/${hide.pendingActionId}/confirm`).set(auth(company.id)).expect(200);
    expect(hidden[0]).toMatchObject({ hide: 'true' });

    // pela tela
    nock(FB).post('/17870913679156916').query((q) => q.hide === 'false').reply(200, { success: true });
    expect((await api().post('/ai/instagram/comments/17870913679156916/hide').set(auth(company.id)).send({ hide: false }).expect(200)).body).toEqual({ ok: true, commentId: '17870913679156916', hidden: false });

    // modo automático para comentários: responde sem cartão
    await settings(company.id, { comentarios: { mode: 'automatico' } }).expect(200);
    nock(FB).get('/17870913679156917').query(true).reply(200, { id: '17870913679156917', text: 'Top!', username: 'bia', media: { id: '1801' } });
    nock(FB).post('/17870913679156917/replies').query(true).reply(200, { id: '18000' });
    expect((await call(ctx, 'instagram_responder_comentario', { id: '17870913679156917', texto: 'Obrigado, Bia!' })).status).toBe('ok');

    // desligado
    await settings(company.id, { comentarios: { enabled: false } }).expect(200);
    expect((await call(ctx, 'instagram_comentarios', {})).data.recusado).toMatch(/Comentários estão desligados/);

    // webhook de comentário (login unificado: changes + comment_id)
    await webhook({ object: 'instagram', entry: [{ id: '1784', time: Date.now(), changes: [{ field: 'comments', value: { comment_id: '18111', text: 'Quero me inscrever', from: { id: '42', username: 'carlos' }, media: { id: '1801' } } }] }] }).expect(200);
    expect(await db.ai_SocialMessage.findUniqueOrThrow({ where: { externalId: 'comment:18111' } })).toMatchObject({ channel: 'comment', direction: 'in', fromUsername: 'carlos', conversationId: '1801' });
  });
});
