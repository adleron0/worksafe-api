import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { InstagramMessagesService } from 'src/features/ai/connectors/instagram-messages.service';
import { ChatInstagramService } from 'src/features/chat/chat-instagram.service';
import { ChatMediaService } from 'src/features/chat/chat-media.service';
import { ChatSendService } from 'src/features/chat/chat-send.service';
import { createHmac } from 'crypto';
import { ChatTranscribeService } from 'src/features/chat/chat-transcribe.service';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Conversas (fase 7): transcrição de áudio, ferramentas no MCP e o adaptador
 * do WhatsApp oficial (Cloud API da Meta).
 */
describe('Conversas fase 7: extras (e2e)', () => {
  const PERMS = ['view_conversas', 'todas_conversas', 'responder_conversas', 'canais_conversas'];
  const EVO = 'http://evolution.test';
  const SECRET = 'segredo-do-app';
  let jwt: JwtService;
  let media: ChatMediaService;
  let bridge: ChatInstagramService;
  let sendQueue: () => Promise<void>;
  let transcriber: ChatTranscribeService;
  let catalog: ToolCatalogService;
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
    transcriber = app.get(ChatTranscribeService, { strict: false });
    catalog = app.get(ToolCatalogService, { strict: false });
    process.env.GROQ_API_KEY = 'gsk-teste';
    delete process.env.OPENAI_API_KEY;
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });
  afterAll(async () => {
    for (const key of ['GROQ_API_KEY', 'EVOLUTION_URL', 'EVOLUTION_API_KEY', 'CHAT_WEBHOOK_BASE', 'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_WEBHOOK_TOKEN', 'INSTAGRAM_CONFIG_ID']) delete process.env[key];
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




  const GROQ = 'https://api.groq.com';
  const GRAPH = 'https://graph.facebook.com/v21.0';

  it('transcrição: áudio do cliente vira texto sozinho; dá para pedir de novo; o número pode desligar', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    nock(EVO).post(/\/chat\/getBase64FromMediaMessage\/.*/).reply(201, { base64: Buffer.from('OggS-audio').toString('base64'), mimetype: 'audio/ogg; codecs=opus' });
    let sentModel = '';
    nock(GROQ).post('/openai/v1/audio/transcriptions', (body) => { sentModel = /whisper-large-v3-turbo/.test(String(body)) ? 'ok' : String(body).slice(0, 80); return true; }).reply(200, { text: ' Preciso de um orçamento  de NR-35 ' });
    await hook(id, secret, upsert('AU1', '5511977770000', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 4, ptt: true } })).expect(200);
    await media.idle();
    await transcriber.idle();
    const msg = await db.chat_Message.findFirstOrThrow({ where: { externalId: 'AU1' } });
    expect(msg.media).toMatchObject({ state: 'ok', transcript: 'Preciso de um orçamento de NR-35', transcriptState: 'ok', transcriptBy: 'groq' });
    expect(sentModel).toBe('ok');

    // aparece para a tela
    const conv = (await api().get(`/chat/conversations/${msg.conversationId}`).set(auth(company.id)).expect(200)).body;
    expect(conv.messages.find((m: { id: number }) => m.id === msg.id).media.transcript).toBe('Preciso de um orçamento de NR-35');

    // pedir de novo na tela; texto que não é áudio não pode
    nock(GROQ).post('/openai/v1/audio/transcriptions').reply(200, { text: 'Outra versão' });
    const again = (await api().post(`/chat/conversations/${msg.conversationId}/messages/${msg.id}/transcribe`).set(auth(company.id)).expect(200)).body;
    expect(again).toMatchObject({ transcript: 'Outra versão', state: 'ok' });
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'TX1' } });
    await api().post(`/chat/conversations/${msg.conversationId}/messages`).set(auth(company.id)).send({ text: 'Já vejo!' }).expect(200);
    const text = await db.chat_Message.findFirstOrThrow({ where: { conversationId: msg.conversationId, direction: 'out' } });
    await api().post(`/chat/conversations/${msg.conversationId}/messages/${text.id}/transcribe`).set(auth(company.id)).expect(400);

    // número com a transcrição desligada: não transcreve sozinho
    await api().put(`/chat/channels/${id}`).set(auth(company.id)).send({ settings: { transcrever: false } }).expect(200);
    nock(EVO).post(/\/chat\/getBase64FromMediaMessage\/.*/).reply(201, { base64: Buffer.from('OggS-2').toString('base64'), mimetype: 'audio/ogg' });
    await hook(id, secret, upsert('AU2', '5511977770000', { audioMessage: { mimetype: 'audio/ogg', ptt: true } })).expect(200);
    await media.idle();
    await transcriber.idle();
    const second = await db.chat_Message.findFirstOrThrow({ where: { externalId: 'AU2' } });
    expect((second.media as { transcript?: string }).transcript).toBeUndefined();
  });

  it('MCP: lista e lê as conversas que a pessoa vê; mandar mensagem só depois de confirmar', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, upsert('MC1', '5511988880000', { conversation: 'Vocês têm turma de NR-33 em dezembro?' })).expect(200);
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: id } });
    const ctx = { userId, companyId: company.id, permissions: ['view_conversas', 'todas_conversas', 'responder_conversas', 'usar_mcp'], origin: 'mcp' as const };

    const listed = await catalog.call(ctx, 'conversas_listar', { caixa: 'sem_dono' }, null);
    expect(listed.status).toBe('ok');
    const list = JSON.parse(listed.content);
    expect(list.conversas).toEqual([expect.objectContaining({ id: conv.id, contato: 'Carlos Cliente', ultimaMensagem: 'Vocês têm turma de NR-33 em dezembro?', deQuem: 'cliente' })]);

    const read = JSON.parse((await catalog.call(ctx, 'conversas_ler', { conversa: conv.id }, null)).content);
    expect(read.mensagens).toEqual([expect.objectContaining({ de: 'cliente', texto: 'Vocês têm turma de NR-33 em dezembro?' })]);

    // sem permissão de ver conversas: negado
    expect((await catalog.call({ ...ctx, permissions: ['usar_mcp'] }, 'conversas_listar', {}, null)).status).toBe('denied');
    // outra empresa não acha a conversa
    const other = await makeCompany();
    expect((await catalog.call({ ...ctx, companyId: other.id }, 'conversas_ler', { conversa: conv.id }, null)).status).toBe('refused');

    const prepared = await catalog.call(ctx, 'conversas_enviar_mensagem', { conversa: conv.id, texto: 'Temos sim, dia 12!' }, null);
    expect(prepared.status).toBe('pending');
    expect(await db.chat_Message.count({ where: { conversationId: conv.id, direction: 'out' } })).toBe(0);
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'MCOUT' } });
    const done = await catalog.confirm({ userId, companyId: company.id, permissions: ctx.permissions }, prepared.pendingActionId!);
    expect(done.result?.message).toMatch(/fila/);
    await sendQueue();
    expect(await db.chat_Message.findFirst({ where: { conversationId: conv.id, direction: 'out' } })).toMatchObject({ text: expect.stringContaining('Temos sim, dia 12!'), status: 'sent' });
  });

  it('WhatsApp oficial: conecta com as credenciais, confere o webhook, recebe, responde dentro de 24 h e trata status', async () => {
    const { company, db } = await cenario();
    const created = await api().post('/chat/channels').set(auth(company.id)).send({ name: 'WhatsApp Oficial', sector: 'comercial' }).expect(201);
    const id = created.body.id;
    const creds = { phoneNumberId: '1234567890', wabaId: '999', token: 'EAAG-token-permanente-de-teste', appSecret: 'segredo-do-app-oficial' };
    await api().post(`/chat/channels/${id}/cloud`).set(auth(company.id)).send({ ...creds, phoneNumberId: 'abc' }).expect(400);
    nock(GRAPH).get('/1234567890').query(true).reply(200, { display_phone_number: '+55 11 4000-1234', verified_name: 'WorkSafe Brasil' });
    const connected = (await api().post(`/chat/channels/${id}/cloud`).set(auth(company.id)).send(creds).expect(200)).body;
    expect(connected).toMatchObject({ status: 'conectado', phone: '551140001234', profileName: 'WorkSafe Brasil' });
    expect(connected.webhookUrl).toMatch(new RegExp(`/chat/webhook/cloud/${id}$`));
    const channel = await db.chat_Channel.findUniqueOrThrow({ where: { id } });
    expect(channel).toMatchObject({ provider: 'cloud', status: 'conectado' });
    expect(channel.cloudConfig).not.toContain('EAAG'); // criptografado
    const listedChannel = (await api().get(`/chat/channels/${id}`).set(auth(company.id)).expect(200)).body;
    expect(listedChannel.cloudConfig).toBeUndefined();
    // o QR code não vale para número oficial
    await api().post(`/chat/channels/${id}/connect`).set(auth(company.id)).send({ acceptTerms: true }).expect(400);

    // verificação do endereço pela Meta
    await api().get(`/chat/webhook/cloud/${id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '42' }).expect(403);
    const ok = await api().get(`/chat/webhook/cloud/${id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': connected.verifyToken, 'hub.challenge': '42' }).expect(200);
    expect(ok.text).toBe('42');

    const post = (payload: unknown, secretKey = creds.appSecret) => {
      const raw = JSON.stringify(payload);
      return api().post(`/chat/webhook/cloud/${id}`).set('Content-Type', 'application/json').set('x-hub-signature-256', `sha256=${createHmac('sha256', secretKey).update(raw).digest('hex')}`).send(raw);
    };
    const inbound = (msg: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ id: '999', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1234567890' }, contacts: [{ wa_id: '5511912345678', profile: { name: 'Ana Compradora' } }], messages: [msg] } }] }] });
    await post(inbound({ from: '5511912345678', id: 'wamid.A1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Quero cotar um resgate' } }), 'assinatura-errada').expect(403);
    const got = (await post(inbound({ from: '5511912345678', id: 'wamid.A1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Quero cotar um resgate' } })).expect(200)).body;
    expect(got.stored).toBe(1);
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: id }, include: { contact: true } });
    expect(conv.contact).toMatchObject({ phone: '5511912345678', pushName: 'Ana Compradora' });

    // imagem: baixa pela Meta (link + arquivo com o token)
    nock(GRAPH).get('/MEDIA1').reply(200, { url: 'https://lookaside.fbsbx.com/whatsapp/arquivo', mime_type: 'image/jpeg' });
    nock('https://lookaside.fbsbx.com').get('/whatsapp/arquivo').reply(200, Buffer.from('jpeg-bytes'), { 'Content-Type': 'image/jpeg' });
    await post(inbound({ from: '5511912345678', id: 'wamid.A2', timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'a obra' } })).expect(200);
    await media.idle();
    const image = await db.chat_Message.findFirstOrThrow({ where: { externalId: 'wamid.A2' } });
    expect(image).toMatchObject({ type: 'image', text: 'a obra' });
    expect(image.media).toMatchObject({ state: 'ok', mimetype: 'image/jpeg' });

    // resposta sai pela Cloud API
    let sentTo = '';
    nock(GRAPH).post('/1234567890/messages', (body) => { sentTo = body.to; return body.type === 'text' && /Mando hoje/.test(body.text.body); }).reply(200, { messages: [{ id: 'wamid.OUT1' }] });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Mando hoje a proposta.' }).expect(200);
    await sendQueue();
    expect(sentTo).toBe('5511912345678');
    const out = await db.chat_Message.findFirstOrThrow({ where: { externalId: 'wamid.OUT1' } });
    expect(out.status).toBe('sent');

    // status: entregue, lida, e uma falha com o motivo da Meta
    await post({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '1234567890' }, statuses: [{ id: 'wamid.OUT1', status: 'delivered' }, { id: 'wamid.OUT1', status: 'read' }] } }] }] }).expect(200);
    expect((await db.chat_Message.findUniqueOrThrow({ where: { id: out.id } })).status).toBe('read');

    // fora da janela de 24 h: não manda e explica
    await db.chat_Message.updateMany({ where: { conversationId: conv.id, direction: 'in' }, data: { sentAt: new Date(Date.now() - 25 * 3600000) } });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Conseguiu ver?' }).expect(200);
    await sendQueue();
    const late = await db.chat_Message.findFirstOrThrow({ where: { conversationId: conv.id, text: { contains: 'Conseguiu ver?' } } });
    expect(late.status).toBe('failed');
    expect(late.error).toMatch(/24 h/);
  });
});
