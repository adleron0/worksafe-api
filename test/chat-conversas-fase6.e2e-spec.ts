import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { InstagramMessagesService } from 'src/features/ai/connectors/instagram-messages.service';
import { ChatInstagramService } from 'src/features/chat/chat-instagram.service';
import { ChatMediaService } from 'src/features/chat/chat-media.service';
import { ChatSendService } from 'src/features/chat/chat-send.service';
import { ChatMetricsService } from 'src/features/chat/chat-metrics.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Conversas (fase 6): saúde do número (histórico de conexão, uso, avisos de
 * risco, conferência com o servidor) e métricas do atendimento (1ª resposta,
 * por setor, por atendente, por número).
 */
describe('Conversas fase 6: saúde e métricas (e2e)', () => {
  const PERMS = ['view_conversas', 'todas_conversas', 'responder_conversas', 'canais_conversas'];
  const EVO = 'http://evolution.test';
  const SECRET = 'segredo-do-app';
  let jwt: JwtService;
  let media: ChatMediaService;
  let bridge: ChatInstagramService;
  let sendQueue: () => Promise<void>;
  let metricsService: ChatMetricsService;
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
    metricsService = app.get(ChatMetricsService, { strict: false });
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



  it('saúde: histórico de conexão, uso do dia, fila e avisos; só quem cuida dos números vê', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await api().get(`/chat/channels/${id}/health`).set(auth(company.id, ['view_conversas', 'responder_conversas'])).expect(403);

    await hook(id, secret, upsert('H1', '5511944440000', { conversation: 'Bom dia' })).expect(200);
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: id } });
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'HOUT1' } });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Bom dia! Em que posso ajudar?' }).expect(200);
    await sendQueue();

    let health = (await api().get(`/chat/channels/${id}/health`).set(auth(company.id)).expect(200)).body;
    expect(health).toMatchObject({ status: 'conectado', level: 'ok', usage: { day: 1, hour: 1 }, queue: { queued: 0 }, week: { inbound: 1, outbound: 1, talked: 1, answered: 1, replyRate: 100 } });
    expect(health.events.map((e: { status: string }) => e.status)).toEqual(['conectado', 'aguardando']);

    // caiu: entra no histórico (uma vez só), vira erro e o tempo conectado cai
    await hook(id, secret, { event: 'connection.update', data: { state: 'close', statusReason: 428 } }).expect(200);
    await hook(id, secret, { event: 'connection.update', data: { state: 'close', statusReason: 428 } }).expect(200);
    health = (await api().get(`/chat/channels/${id}/health`).set(auth(company.id)).expect(200)).body;
    expect(health.status).toBe('caiu');
    expect(health.level).toBe('erro');
    expect(health.events.map((e: { status: string }) => e.status)).toEqual(['caiu', 'conectado', 'aguardando']);
    expect(health.week.drops).toBe(1);

    // a conferência com o servidor vê que voltou
    nock.cleanAll();
    nock(EVO).get(/\/instance\/connectionState\/.*/).reply(200, { instance: { state: 'open' } });
    await metricsService.watch();
    expect((await db.chat_Channel.findUniqueOrThrow({ where: { id } })).status).toBe('conectado');
    // e que caiu sem avisar
    nock(EVO).get(/\/instance\/connectionState\/.*/).reply(200, { instance: { state: 'close' } });
    await metricsService.watch();
    const down = await db.chat_Channel.findUniqueOrThrow({ where: { id } });
    expect(down.status).toBe('caiu');
    expect(await db.chat_ChannelEvent.count({ where: { channelId: id } })).toBe(5);

    // muita gente pedindo para parar vira aviso
    await db.chat_Contact.updateMany({ where: { channelId: id }, data: { optOut: true, optOutAt: new Date() } });
    for (const phone of ['5511900000011', '5511900000012']) await db.chat_Contact.create({ data: { companyId: company.id, channelId: id, externalId: `${phone}@s.whatsapp.net`, phone, optOut: true, optOutAt: new Date() } });
    health = (await api().get(`/chat/channels/${id}/health`).set(auth(company.id)).expect(200)).body;
    expect(health.week.optOuts).toBe(3);
    expect(health.warnings.some((w: { text: string }) => /pediram para não receber/.test(w.text))).toBe(true);
  });

  it('métricas: 1ª resposta, por setor, por atendente e por número; mensagem automática não conta como resposta', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await api().get('/chat/metrics').set(auth(company.id, ['view_conversas', 'responder_conversas'])).expect(403);

    await hook(id, secret, upsert('M1', '5511955550000', { conversation: 'Oi, preciso de um treinamento' })).expect(200);
    await hook(id, secret, upsert('M2', '5511955550000', { conversation: 'NR-35 para 10 pessoas' })).expect(200);
    await hook(id, secret, upsert('M3', '5511966660000', { conversation: 'Vocês fazem laudo?' })).expect(200);
    const [c1, c2] = await db.chat_Conversation.findMany({ where: { channelId: id }, orderBy: { id: 'asc' } });
    // a 1ª conversa: cliente escreveu há 10 min; resposta automática não conta; atendente respondeu agora
    const tenMin = new Date(Date.now() - 10 * 60000);
    await db.chat_Message.updateMany({ where: { conversationId: c1.id, direction: 'in' }, data: { sentAt: tenMin } });
    await db.chat_Message.create({ data: { companyId: company.id, channelId: id, conversationId: c1.id, direction: 'out', text: 'Estamos fora do horário', status: 'sent', origin: 'auto', sentAt: new Date(Date.now() - 9 * 60000) } });
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'MOUT1' } });
    await api().post(`/chat/conversations/${c1.id}/messages`).set(auth(company.id)).send({ text: 'Fazemos sim! Para quando?' }).expect(200);
    await sendQueue();
    await db.chat_Conversation.update({ where: { id: c2.id }, data: { sector: 'treinamentos' } });
    await db.chat_Conversation.update({ where: { id: c1.id }, data: { sector: 'treinamentos', assignedUserId: userId } });

    const m = (await api().get('/chat/metrics?days=7').set(auth(company.id)).expect(200)).body;
    expect(m.totals).toMatchObject({ conversations: 2, inbound: 3, outHuman: 1, newContacts: 2 });
    expect(m.firstResponse).toMatchObject({ turns: 2, answered: 1, unanswered: 1 });
    expect(m.firstResponse.medianSec).toBeGreaterThanOrEqual(590);
    expect(m.firstResponse.medianSec).toBeLessThan(700);
    expect(m.bySector).toEqual([expect.objectContaining({ sector: 'treinamentos', conversations: 2, inbound: 3, outbound: 2, unanswered: 1, medianSec: expect.any(Number) })]);
    expect(m.byUser).toEqual([expect.objectContaining({ userId, messages: 1, conversations: 1, firstResponses: 1, open: 1 })]);
    expect(m.byChannel).toEqual([expect.objectContaining({ channelId: id, conversations: 2, inbound: 3 })]);
    expect(m.byDay).toHaveLength(7);
    expect(m.byDay.reduce((s: number, d: { inbound: number }) => s + d.inbound, 0)).toBe(3);
    expect(m.byHour.reduce((s: number, h: { inbound: number }) => s + h.inbound, 0)).toBe(3);

    // filtro por número e outra empresa não vê nada
    const other = await makeCompany();
    const none = (await api().get(`/chat/metrics?channelId=${id}`).set(auth(other.id)).expect(200)).body;
    expect(none.totals).toBeNull();
  });
});
