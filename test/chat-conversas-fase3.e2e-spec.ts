import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { InstagramMessagesService } from 'src/features/ai/connectors/instagram-messages.service';
import { ChatInstagramService } from 'src/features/chat/chat-instagram.service';
import { ChatMediaService } from 'src/features/chat/chat-media.service';
import { ChatSendService } from 'src/features/chat/chat-send.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Conversas (fase 3): respostas rápidas ("/" na conversa) e etiquetas das
 * conversas (com filtro na caixa).
 */
describe('Conversas fase 3: respostas rápidas e etiquetas (e2e)', () => {
  const PERMS = ['view_conversas', 'todas_conversas', 'responder_conversas', 'canais_conversas'];
  const EVO = 'http://evolution.test';
  const FB = 'https://graph.facebook.com/v27.0';
  const SECRET = 'segredo-do-app';
  let jwt: JwtService;
  let media: ChatMediaService;
  let bridge: ChatInstagramService;
  let sendQueue: () => Promise<void>;
  let userId = 0;

  beforeAll(async () => {
    process.env.EVOLUTION_URL = EVO;
    process.env.EVOLUTION_API_KEY = 'chave-global';
    process.env.CHAT_WEBHOOK_BASE = 'http://api.interna:3000';
    process.env.AI_DEFAULT_PROVIDER = 'fake';
    process.env.AI_MODEL_FAST = 'fake';
    process.env.AI_MODEL_STRONG = 'fake';
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    media = app.get(ChatMediaService, { strict: false });
    bridge = app.get(ChatInstagramService, { strict: false });
    const queue = app.get(ChatSendService, { strict: false });
    sendQueue = () => queue.tick();
    app.get(InstagramMessagesService, { strict: false }).autoDelayMs = 0;
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });
  afterAll(async () => {
    for (const key of ['EVOLUTION_URL', 'EVOLUTION_API_KEY', 'CHAT_WEBHOOK_BASE', 'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_WEBHOOK_TOKEN', 'INSTAGRAM_CONFIG_ID']) delete process.env[key];
    nock.cleanAll();
    nock.enableNetConnect();
    await shutdownTestApp();
  });
  beforeEach(async () => {
    await resetDb();
    await flushCache();
    process.env.INSTAGRAM_APP_ID = '999';
    process.env.INSTAGRAM_APP_SECRET = SECRET;
    process.env.INSTAGRAM_WEBHOOK_TOKEN = 'token-de-verificacao';
    process.env.INSTAGRAM_CONFIG_ID = '1511424607547228';
  });
  afterEach(() => nock.cleanAll());

  const auth = (companyId: number, permissions: string[] = PERMS, sub = userId) => {
    const payload = { sub, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());

  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    return { company, db: testDb() };
  }

  async function conectado(companyId: number) {
    const created = await api().post('/chat/channels').set(auth(companyId)).send({ name: 'WhatsApp Serviços', sector: 'servicos' }).expect(201);
    const id = created.body.id;
    let secret = '';
    nock(EVO).get(/\/instance\/connectionState\/.*/).reply(404, {});
    nock(EVO).post('/instance/create', (body) => { secret = body.webhook.headers['x-ws-chat-secret']; return true; }).reply(201, {});
    nock(EVO).get(/\/instance\/connect\/.*/).reply(200, { base64: 'data:image/png;base64,QR' });
    await api().post(`/chat/channels/${id}/connect`).set(auth(companyId)).send({ acceptTerms: true }).expect(200);
    await hook(id, secret, { event: 'connection.update', data: { state: 'open', wuid: '5511900000001@s.whatsapp.net' } }).expect(200);
    return { id, secret };
  }
  const hook = (channelId: number, secret: string, body: unknown) => api().post(`/chat/webhook/evolution/${channelId}`).set('x-ws-chat-secret', secret).send(body as object);
  const upsert = (id: string, phone: string, message: Record<string, unknown>) => ({
    event: 'messages.upsert',
    data: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id }, pushName: 'Carlos Cliente', message, messageTimestamp: Math.floor(Date.now() / 1000) },
  });

  /** Abre o fluxo de eventos e junta o que chegar. */
  function listen(ticket: string) {
    const port = (httpServer().address() as AddressInfo).port;
    const events: any[] = [];
    let status = 0;
    let buffer = '';
    const req = http.get({ host: '127.0.0.1', port, path: `/chat/stream?ticket=${ticket}` }, (res) => {
      status = res.statusCode ?? 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const name = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (name) events.push({ name, data: data ? JSON.parse(data) : null });
        }
      });
    });
    req.on('error', () => undefined);
    return { events, status: () => status, close: () => req.destroy() };
  }
  const waitFor = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('tempo esgotado esperando o evento');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('respostas rápidas: atalho limpo, sem repetir, setor válido, permissão e as mais usadas primeiro', async () => {
    const { company } = await cenario();
    const READ = ['view_conversas'];
    await api().post('/chat/quick-replies').set(auth(company.id, READ)).send({ shortcut: 'x', text: 'y' }).expect(403);
    const a = (await api().post('/chat/quick-replies').set(auth(company.id)).send({ shortcut: ' Orçamento Rápido ', title: 'Pedir dados do orçamento', text: 'Olá {primeiro_nome}! Me passa o endereço?', sector: 'servicos' }).expect(201)).body;
    expect(a).toMatchObject({ shortcut: 'orcamento-rapido', title: 'Pedir dados do orçamento', sector: 'servicos', uses: 0 });
    expect((await api().post('/chat/quick-replies').set(auth(company.id)).send({ shortcut: 'orcamento-rapido', text: 'outra' }).expect(409)).body.message).toMatch(/\/orcamento-rapido/);
    await api().post('/chat/quick-replies').set(auth(company.id)).send({ shortcut: 'z', text: '' }).expect(400);
    await api().post('/chat/quick-replies').set(auth(company.id)).send({ shortcut: 'z', text: 'ok', sector: 'marte' }).expect(400);
    const b = (await api().post('/chat/quick-replies').set(auth(company.id)).send({ shortcut: 'pix', text: 'Nossa chave PIX é o CNPJ.' }).expect(201)).body;
    expect(b.title).toBe('pix');
    await api().post(`/chat/quick-replies/${b.id}/used`).set(auth(company.id, READ)).expect(200);
    const list = (await api().get('/chat/quick-replies').set(auth(company.id, READ)).expect(200)).body;
    expect(list.map((r: any) => r.shortcut)).toEqual(['pix', 'orcamento-rapido']);
    expect((await api().put(`/chat/quick-replies/${a.id}`).set(auth(company.id)).send({ text: 'Texto novo' }).expect(200)).body).toMatchObject({ shortcut: 'orcamento-rapido', text: 'Texto novo' });
    await api().delete(`/chat/quick-replies/${a.id}`).set(auth(company.id)).expect(200);
    expect((await api().get('/chat/quick-replies').set(auth(company.id)).expect(200)).body).toHaveLength(1);
    // atalho de resposta apagada pode ser usado de novo
    await api().post('/chat/quick-replies').set(auth(company.id)).send({ shortcut: 'orcamento-rapido', text: 'de novo' }).expect(201);
  });

  it('etiquetas: criar (sem duplicar), marcar na conversa, filtrar a caixa e apagar', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, upsert('T1', '5511911110000', { conversation: 'Quero orçamento' })).expect(200);
    await hook(id, secret, upsert('T2', '5511922220000', { conversation: 'Outro assunto' })).expect(200);
    const [c1] = await db.chat_Conversation.findMany({ where: { channelId: id }, orderBy: { id: 'asc' } });

    const tag = (await api().post('/chat/tags').set(auth(company.id)).send({ name: '  Orçamento ' }).expect(201)).body;
    expect(tag).toMatchObject({ name: 'Orçamento', color: expect.stringMatching(/^#/) });
    expect((await api().post('/chat/tags').set(auth(company.id)).send({ name: 'orçamento' }).expect(201)).body.id).toBe(tag.id);
    const urgent = (await api().post('/chat/tags').set(auth(company.id)).send({ name: 'Urgente', color: '#E52127' }).expect(201)).body;
    expect(urgent.color).toBe('#E52127');

    await api().put(`/chat/conversations/${c1.id}/tags`).set(auth(company.id, ['view_conversas', 'todas_conversas'])).send({ tagIds: [tag.id] }).expect(403);
    const view = (await api().put(`/chat/conversations/${c1.id}/tags`).set(auth(company.id)).send({ tagIds: [tag.id, urgent.id, 99999] }).expect(200)).body;
    expect(view.tags.map((t: any) => t.name).sort()).toEqual(['Orçamento', 'Urgente']);

    const filtered = (await api().get(`/chat/conversations?tagId=${tag.id}`).set(auth(company.id)).expect(200)).body;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({ id: c1.id, tags: expect.arrayContaining([expect.objectContaining({ name: 'Urgente' })]) });
    expect((await api().get('/chat/tags').set(auth(company.id)).expect(200)).body.find((t: any) => t.id === tag.id).conversations).toBe(1);

    await api().delete(`/chat/tags/${urgent.id}`).set(auth(company.id, ['view_conversas', 'todas_conversas', 'responder_conversas'])).expect(403);
    await api().delete(`/chat/tags/${urgent.id}`).set(auth(company.id)).expect(200);
    expect((await api().get(`/chat/conversations/${c1.id}`).set(auth(company.id)).expect(200)).body.tags.map((t: any) => t.name)).toEqual(['Orçamento']);
    expect((await api().get('/chat/meta').set(auth(company.id)).expect(200)).body.tagColors).toContain('#149E5E');
  });
});
