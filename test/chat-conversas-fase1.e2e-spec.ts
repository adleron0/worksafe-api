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
 * Conversas (fase 1): tempo real por SSE com ticket, mídia (download do
 * WhatsApp para o armazenamento privado, envio de arquivo e áudio) e o
 * Instagram Direct espelhado na caixa única.
 */
describe('Conversas fase 1: tempo real, mídia e Instagram (e2e)', () => {
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

  // ---------------------------------------------------------------- tempo real

  it('tempo real: ticket de uso único, evento da mensagem nova e só para quem vê o número', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    const outsider = await makeSeller(company.id);

    await api().post('/chat/stream/ticket').expect(401);
    await api().post('/chat/stream/ticket').set(auth(company.id, ['usar_bots'])).expect(403);
    const { ticket } = (await api().post('/chat/stream/ticket').set(auth(company.id)).expect(200)).body;
    const other = (await api().post('/chat/stream/ticket').set(auth(company.id, ['view_conversas'], outsider.id)).expect(200)).body.ticket;

    const me = listen(ticket);
    const them = listen(other);
    await waitFor(() => me.events.some((e) => e.name === 'ready') && them.events.some((e) => e.name === 'ready'));
    expect(me.status()).toBe(200);

    // o ticket não vale de novo
    const again = listen(ticket);
    await waitFor(() => again.status() !== 0);
    expect(again.status()).toBe(401);
    again.close();

    await hook(id, secret, upsert('WA1', '5511988887777', { conversation: 'Bom dia, quero um orçamento' })).expect(200);
    await waitFor(() => me.events.some((e) => e.name === 'chat'));
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: id } });
    expect(me.events.find((e) => e.name === 'chat').data).toMatchObject({ kind: 'message', channelId: id, conversationId: conv.id, inbound: true, contactName: 'Carlos Cliente', preview: 'Bom dia, quero um orçamento' });

    // quem não está na equipe do número (e não vê tudo) não recebe nada
    await new Promise((r) => setTimeout(r, 200));
    expect(them.events.filter((e) => e.name === 'chat')).toHaveLength(0);

    // quando a conversa passa para ele, recebe
    await api().patch(`/chat/conversations/${conv.id}`).set(auth(company.id)).send({ assignedUserId: outsider.id }).expect(200);
    await waitFor(() => them.events.some((e) => e.name === 'chat' && e.data.kind === 'conversation'));
    me.close();
    them.close();
  });

  // ---------------------------------------------------------------- mídia

  it('mídia recebida: baixa do WhatsApp para o armazenamento e a tela recebe um link', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    const png = Buffer.from('imagem-de-teste');
    nock(EVO).post(/\/chat\/getBase64FromMediaMessage\/.*/, (body) => body.message.key.id === 'WAIMG').reply(200, { base64: png.toString('base64'), mimetype: 'image/jpeg' });
    await hook(id, secret, upsert('WAIMG', '5511988887777', { imageMessage: { caption: 'Foto do local', mimetype: 'image/jpeg' } })).expect(200);
    await media.idle();

    const message = await db.chat_Message.findFirstOrThrow({ where: { externalId: 'WAIMG' } });
    expect(message).toMatchObject({ type: 'image', text: 'Foto do local' });
    expect(message.media).toMatchObject({ state: 'ok', mimetype: 'image/jpeg', size: png.length });
    expect((message.media as any).key).toMatch(new RegExp(`^chat/${company.id}/${message.conversationId}/.+\\.jpg$`));

    const view = (await api().get(`/chat/conversations/${message.conversationId}`).set(auth(company.id)).expect(200)).body;
    const shown = view.messages.find((m: any) => m.id === message.id);
    expect(shown.media.url).toMatch(/^memory:\/\/chat\//);
    expect(shown.media.key).toBeUndefined();

    // falhou no servidor do WhatsApp: fica marcado, sem quebrar a conversa
    nock(EVO).post(/\/chat\/getBase64FromMediaMessage\/.*/).reply(400, { response: { message: ['not found'] } });
    await hook(id, secret, upsert('WAAUD', '5511988887777', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 7, ptt: true } })).expect(200);
    await media.idle();
    expect((await db.chat_Message.findFirstOrThrow({ where: { externalId: 'WAAUD' } })).media).toMatchObject({ state: 'failed', seconds: 7, ptt: true });
  });

  it('mídia enviada: foto com legenda pela fila e áudio gravado como voz', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, upsert('WA1', '5511988887777', { conversation: 'Oi' })).expect(200);
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: id } });
    const file = Buffer.from('foto-jpeg');

    let sentMedia: any = null;
    nock(EVO).post(/\/message\/sendMedia\/.*/, (body) => { sentMedia = body; return true; }).reply(201, { key: { id: 'OUTIMG' } });
    const sent = (await api().post(`/chat/conversations/${conv.id}/media`).set(auth(company.id)).field('caption', 'Segue a foto').attach('file', file, { filename: 'obra.jpg', contentType: 'image/jpeg' }).expect(200)).body;
    expect(sent).toMatchObject({ type: 'image', text: 'Segue a foto', status: 'sent', externalId: 'OUTIMG' });
    expect(sentMedia).toMatchObject({ number: '5511988887777', mediatype: 'image', mimetype: 'image/jpeg', media: file.toString('base64'), caption: '_Vendedor:_\nSegue a foto' });

    let sentAudio: any = null;
    nock(EVO).post(/\/message\/sendWhatsAppAudio\/.*/, (body) => { sentAudio = body; return true; }).reply(201, { key: { id: 'OUTAUD' } });
    const voice = Buffer.from('audio-webm');
    const audio = (await api().post(`/chat/conversations/${conv.id}/media`).set(auth(company.id)).field('ptt', 'true').attach('file', voice, { filename: 'gravacao.webm', contentType: 'audio/webm' }).expect(200)).body;
    expect(audio).toMatchObject({ type: 'audio', status: 'sent' });
    expect(sentAudio).toMatchObject({ number: '5511988887777', audio: voice.toString('base64') });

    const pdf = Buffer.from('%PDF-1.4');
    nock(EVO).post(/\/message\/sendMedia\/.*/, (body) => body.mediatype === 'document' && body.fileName === 'proposta.pdf').reply(201, { key: { id: 'OUTDOC' } });
    await api().post(`/chat/conversations/${conv.id}/media`).set(auth(company.id)).attach('file', pdf, { filename: 'proposta.pdf', contentType: 'application/pdf' }).expect(200);

    await api().post(`/chat/conversations/${conv.id}/media`).set(auth(company.id)).expect(400);
    await api().post(`/chat/conversations/${conv.id}/media`).set(auth(company.id, ['view_conversas', 'todas_conversas'])).attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' }).expect(403);
    const view = (await api().get(`/chat/conversations/${conv.id}`).set(auth(company.id)).expect(200)).body;
    expect(view.lastMessagePreview).toBe('📄 Documento');
  });

  it('assinatura: nome de quem respondeu na frente (primeiro nome, completo ou desligada); bot com o nome dele', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, upsert('WA1', '5511988887777', { conversation: 'Oi' })).expect(200);
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: id } });
    const texts: string[] = [];
    nock(EVO).post(/\/message\/sendText\/.*/).times(4).reply(201, (_uri, body: any) => { texts.push(body.text); return { key: { id: `OUT${texts.length}` } }; });

    expect((await api().get(`/chat/conversations/${conv.id}`).set(auth(company.id)).expect(200)).body.signature).toBe('Vendedor');
    const sent = (await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Bom dia!' }).expect(200)).body;
    expect(sent.text).toBe('Bom dia!');
    expect(texts[0]).toBe('_Vendedor:_\nBom dia!');

    const settings = (await api().get(`/chat/channels/${id}`).set(auth(company.id)).expect(200)).body.settings;
    expect(settings.assinatura).toEqual({ enabled: true, formato: 'primeiro' });
    await api().put(`/chat/channels/${id}`).set(auth(company.id)).send({ settings: { ...settings, assinatura: { enabled: true, formato: 'completo' } } }).expect(200);
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Segue o valor.' }).expect(200);
    expect(texts[1]).toBe('_Vendedor Teste:_\nSegue o valor.');

    await api().put(`/chat/channels/${id}`).set(auth(company.id)).send({ settings: { ...settings, assinatura: { enabled: false, formato: 'completo' } } }).expect(200);
    expect((await api().get(`/chat/conversations/${conv.id}`).set(auth(company.id)).expect(200)).body.signature).toBeNull();
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Sem nome agora.' }).expect(200);
    expect(texts[2]).toBe('Sem nome agora.');

    // mensagem do bot leva o nome do bot
    await api().put(`/chat/channels/${id}`).set(auth(company.id)).send({ settings: { ...settings, assinatura: { enabled: true, formato: 'primeiro' } } }).expect(200);
    const bot = await db.ai_Bot.create({ data: { companyId: company.id, key: 'bruno', name: 'Bot Operação', persona: 'Bruno', permissionKey: 'usar_bots', description: 'Operação', instructions: 'x', tools: [], provider: 'fake', model: 'fake' } as any });
    await db.chat_Message.create({ data: { companyId: company.id, channelId: id, conversationId: conv.id, direction: 'out', type: 'text', text: 'Olá! Sou o assistente.', status: 'queued', origin: 'bot', sentByBotId: bot.id, scheduledAt: new Date() } });
    await sendQueue();
    expect(texts[3]).toBe('_Bruno:_\nOlá! Sou o assistente.');
  });

  it('ocultar: apaga a conversa e os arquivos, não grava mais nada do contato e volta a aparecer quando mostra de novo', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    nock(EVO).post(/\/chat\/getBase64FromMediaMessage\/.*/).reply(200, { base64: Buffer.from('foto').toString('base64'), mimetype: 'image/jpeg' });
    await hook(id, secret, upsert('P1', '5511977771111', { conversation: 'Oi amor, chego tarde hoje' })).expect(200);
    await hook(id, secret, upsert('P2', '5511977771111', { imageMessage: { mimetype: 'image/jpeg' } })).expect(200);
    await media.idle();
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: id } });

    await api().post(`/chat/conversations/${conv.id}/hide`).set(auth(company.id, ['view_conversas', 'todas_conversas'])).expect(403);
    await api().post(`/chat/conversations/${conv.id}/hide`).set(auth(company.id)).expect(200);
    expect(await db.chat_Message.count({ where: { channelId: id } })).toBe(0);
    expect(await db.chat_Conversation.count({ where: { channelId: id } })).toBe(0);
    expect((await api().get('/chat/conversations').set(auth(company.id)).expect(200)).body.items).toHaveLength(0);

    // o que chegar depois não é gravado (nem enviado pelo celular)
    await hook(id, secret, upsert('P3', '5511977771111', { conversation: 'Tá bom' })).expect(200);
    await hook(id, secret, { event: 'messages.upsert', data: { key: { remoteJid: '5511977771111@s.whatsapp.net', fromMe: true, id: 'P4' }, message: { conversation: 'Beijo' }, messageTimestamp: Math.floor(Date.now() / 1000) } }).expect(200);
    expect(await db.chat_Message.count({ where: { channelId: id } })).toBe(0);
    expect((await api().post('/chat/conversations').set(auth(company.id)).send({ channelId: id, phone: '11977771111' }).expect(400)).body.message).toMatch(/oculto/);

    // ocultar pelo número antes de escrever, listar e mostrar de novo
    const list = (await api().post(`/chat/channels/${id}/hidden`).set(auth(company.id)).send({ phone: '(11) 96666-2222', name: 'Mãe' }).expect(200)).body;
    expect(list.map((c: any) => c.phone).sort()).toEqual(['5511966662222', '5511977771111']);
    await hook(id, secret, upsert('P5', '5511966662222', { conversation: 'Filho, liga pra mim' })).expect(200);
    expect(await db.chat_Message.count({ where: { channelId: id } })).toBe(0);

    const contact = list.find((c: any) => c.phone === '5511977771111');
    const after = (await api().delete(`/chat/channels/${id}/hidden/${contact.id}`).set(auth(company.id)).expect(200)).body;
    expect(after).toHaveLength(1);
    await hook(id, secret, upsert('P6', '5511977771111', { conversation: 'Voltei a aparecer' })).expect(200);
    expect((await api().get('/chat/conversations').set(auth(company.id)).expect(200)).body.items[0]).toMatchObject({ lastMessagePreview: 'Voltei a aparecer' });
    await api().get(`/chat/channels/${id}/hidden`).set(auth(company.id, ['view_conversas'])).expect(403);
  });

  // ---------------------------------------------------------------- Instagram

  const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const igWebhook = (body: unknown) => {
    const raw = JSON.stringify(body);
    return api().post('/ai/connectors/instagram/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw);
  };
  const dm = (mid: string, text: string, opts: { from?: string; attachments?: unknown[]; at?: number } = {}) => ({
    object: 'instagram',
    entry: [{ id: '1784', time: Date.now(), messaging: [{ sender: { id: opts.from ?? '555' }, recipient: { id: '1784' }, timestamp: opts.at ?? Date.now(), message: { mid, text, ...(opts.attachments ? { attachments: opts.attachments } : {}) } }] }],
  });

  it('Instagram: vira canal sozinho, traz o Direct que já existia, recebe e responde pela caixa', async () => {
    const { company, db } = await cenario();
    await db.ai_Connector.create({ data: { companyId: company.id, provider: 'instagram', accountId: '1784', username: 'worksafebrasil', accountType: 'BUSINESS', tokenEncrypted: encryptPayload('chave-do-sistema'), connectedByUserId: userId } });
    await db.ai_SocialMessage.create({ data: { companyId: company.id, channel: 'direct', conversationId: '777', externalId: 'old-1', direction: 'in', fromUsername: 'ana.silva', text: 'Vocês têm curso de NR-35?', sentAt: new Date(Date.now() - 3600000), origin: 'webhook' } });

    const channels = (await api().get('/chat/channels').set(auth(company.id)).expect(200)).body;
    const ig = channels.find((c: any) => c.type === 'instagram');
    expect(ig).toMatchObject({ name: 'Instagram', provider: 'meta', status: 'conectado', phone: 'worksafebrasil', memberIds: [userId] });
    await api().post(`/chat/channels/${ig.id}/connect`).set(auth(company.id)).send({ acceptTerms: true }).expect(400);

    let list = (await api().get('/chat/conversations').set(auth(company.id)).expect(200)).body;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ unread: 1, lastMessagePreview: 'Vocês têm curso de NR-35?', channel: { type: 'instagram' }, contact: { name: '@ana.silva' } });

    // mensagem nova pelo webhook da Meta
    await igWebhook(dm('mid-2', 'Quero me inscrever', { from: '777' })).expect(200);
    await bridge.idle();
    list = (await api().get('/chat/conversations').set(auth(company.id)).expect(200)).body;
    expect(list.items[0]).toMatchObject({ unread: 2, lastMessagePreview: 'Quero me inscrever' });
    const convId = list.items[0].id;

    const view = (await api().get(`/chat/conversations/${convId}`).set(auth(company.id)).expect(200)).body;
    expect(new Date(view.replyUntil).getTime()).toBeGreaterThan(Date.now() + 23 * 3600000);

    // resposta pela caixa sai pela Meta e fica nas duas tabelas
    nock(FB).post('/1784/messages', (body) => body.recipient.id === '777' && body.message.text === 'Vendedor:\nTemos sim! A próxima turma é dia 10.').query(true).reply(200, { recipient_id: '777', message_id: 'mid-out-1' });
    const sent = (await api().post(`/chat/conversations/${convId}/messages`).set(auth(company.id)).send({ text: 'Temos sim! A próxima turma é dia 10.' }).expect(200)).body;
    // assinada para o cliente, limpa na caixa
    expect(sent).toMatchObject({ direction: 'out', status: 'sent', externalId: 'ig:mid-out-1', sentByUserId: userId, text: 'Temos sim! A próxima turma é dia 10.' });
    expect(await db.ai_SocialMessage.count({ where: { externalId: 'mid-out-1', direction: 'out' } })).toBe(1);
    // o eco da Meta não duplica
    await igWebhook({ object: 'instagram', entry: [{ id: '1784', time: Date.now(), messaging: [{ sender: { id: '1784' }, recipient: { id: '777' }, timestamp: Date.now(), message: { mid: 'mid-out-1', text: 'Vendedor:\nTemos sim! A próxima turma é dia 10.', is_echo: true } }] }] }).expect(200);
    await bridge.idle();
    expect(await db.chat_Message.count({ where: { conversationId: convId, direction: 'out' } })).toBe(1);
    expect((await db.chat_Conversation.findUniqueOrThrow({ where: { id: convId } })).assignedUserId).toBe(userId);

    // ler na caixa marca como lida no Direct também
    await api().post(`/chat/conversations/${convId}/read`).set(auth(company.id)).expect(200);
    await bridge.idle();
    expect(await db.ai_SocialMessage.count({ where: { companyId: company.id, conversationId: '777', direction: 'in', readAt: null } })).toBe(0);
  });

  it('Instagram: foto recebida é baixada, janela de 24 h trava a resposta e conta desconectada avisa', async () => {
    const { company, db } = await cenario();
    await db.ai_Connector.create({ data: { companyId: company.id, provider: 'instagram', accountId: '1784', username: 'worksafebrasil', tokenEncrypted: encryptPayload('chave-do-sistema'), connectedByUserId: userId } });
    await api().get('/chat/channels').set(auth(company.id)).expect(200);

    nock('https://cdn.instagram.test').get('/foto.jpg').reply(200, Buffer.from('jpg'), { 'Content-Type': 'image/jpeg' });
    await igWebhook(dm('mid-img', '', { from: '888', attachments: [{ type: 'image', payload: { url: 'https://cdn.instagram.test/foto.jpg' } }] })).expect(200);
    await bridge.idle();
    const photo = await db.chat_Message.findFirstOrThrow({ where: { externalId: 'ig:mid-img' } });
    expect(photo).toMatchObject({ type: 'image', direction: 'in' });
    expect(photo.media).toMatchObject({ state: 'ok', mimetype: 'image/jpeg', sourceUrl: null });

    // cliente que escreveu há mais de 24 h
    await igWebhook(dm('mid-old', 'Oi', { from: '999', at: Date.now() - 30 * 3600000 })).expect(200);
    await bridge.idle();
    const old = await db.chat_Message.findFirstOrThrow({ where: { externalId: 'ig:mid-old' } });
    const res = await api().post(`/chat/conversations/${old.conversationId}/messages`).set(auth(company.id)).send({ text: 'Olá!' }).expect(400);
    expect(res.body.message).toMatch(/24 horas/);

    // começar conversa nova não existe no Instagram
    const igChannel = await db.chat_Channel.findFirstOrThrow({ where: { companyId: company.id, type: 'instagram' } });
    expect((await api().post('/chat/conversations').set(auth(company.id)).send({ channelId: igChannel.id, phone: '11999998888' }).expect(400)).body.message).toMatch(/Instagram/);

    // conta expirou em Bots → Conectores
    await db.ai_Connector.updateMany({ where: { companyId: company.id }, data: { status: 'expired', lastError: 'Token expirado' } });
    const channels = (await api().get('/chat/channels').set(auth(company.id)).expect(200)).body;
    expect(channels.find((c: any) => c.type === 'instagram')).toMatchObject({ status: 'caiu', statusReason: 'Token expirado' });
    expect((await api().post(`/chat/conversations/${photo.conversationId}/messages`).set(auth(company.id)).send({ text: 'Oi' }).expect(400)).body.message).toMatch(/desconectada/);
  });
});
