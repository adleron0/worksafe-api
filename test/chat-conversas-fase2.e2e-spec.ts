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
 * Conversas (fase 2): histórico dos últimos dias ao conectar (entra quieto)
 * e a ficha do cliente na conversa (vincular, resumo por permissão, nome e
 * "não quer receber").
 */
describe('Conversas fase 2: histórico e ficha do cliente (e2e)', () => {
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

  const ts = (daysAgo: number) => Math.floor((Date.now() - daysAgo * 86400000) / 1000);
  const hist = (id: string, phone: string, message: Record<string, unknown>, daysAgo: number, fromMe = false) => ({
    key: { remoteJid: phone.includes('@') ? phone : `${phone}@s.whatsapp.net`, fromMe, id }, pushName: fromMe ? undefined : 'Ana Cliente', message, messageTimestamp: ts(daysAgo),
  });

  it('histórico: últimos 30 dias entram resolvidos, sem não lidas nem resposta; mídia baixa quando pedir; mensagem nova reabre', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    const res = await hook(id, secret, { event: 'messages.set', data: [
      hist('H1', '5511944440000', { conversation: 'Bom dia, vocês fazem laudo?' }, 5),
      hist('H2', '5511944440000', { conversation: 'Fazemos sim!' }, 5, true),
      hist('H3', '5511944440000', { imageMessage: { mimetype: 'image/jpeg', mediaKey: 'k', jpegThumbnail: 'AAAA' } }, 4),
      hist('H4', '5511944440000', { conversation: 'mensagem antiga demais' }, 45),
      hist('H5', '120363000000@g.us', { conversation: 'grupo' }, 2),
      hist('H6', '5511944440000', { protocolMessage: {} }, 3),
    ] }).expect(200);
    expect(res.body).toMatchObject({ imported: 3 });
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: id }, include: { contact: true } });
    expect(conv).toMatchObject({ status: 'resolvida', unread: 0, lastMessagePreview: '📷 Foto' });
    expect(conv.contact.firstInboundAt).not.toBeNull();
    const photo = await db.chat_Message.findFirstOrThrow({ where: { externalId: 'H3' } });
    expect(photo).toMatchObject({ origin: 'history', type: 'image' });
    expect(photo.media).toMatchObject({ state: 'history' });
    expect(JSON.stringify(photo.media)).not.toContain('jpegThumbnail');
    expect(await db.chat_Message.count({ where: { channelId: id, origin: 'auto' } })).toBe(0);
    // repetido não duplica
    await hook(id, secret, { event: 'messages.set', data: [hist('H1', '5511944440000', { conversation: 'Bom dia, vocês fazem laudo?' }, 5)] }).expect(200);
    expect(await db.chat_Message.count({ where: { channelId: id } })).toBe(3);

    // baixar a foto do histórico quando alguém pedir
    nock(EVO).post(/\/chat\/getBase64FromMediaMessage\/.*/, (body) => body.message.key.id === 'H3' && body.message.message.imageMessage.mediaKey === 'k').reply(200, { base64: Buffer.from('jpg').toString('base64'), mimetype: 'image/jpeg' });
    await api().post(`/chat/conversations/${conv.id}/messages/${photo.id}/media`).set(auth(company.id)).expect(200);
    await media.idle();
    expect((await db.chat_Message.findUniqueOrThrow({ where: { id: photo.id } })).media).toMatchObject({ state: 'ok' });

    // quem já conversou antes não conta como contato novo (sem pedir confirmação)
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'OUTH' } });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Oi Ana, voltando ao assunto' }).expect(200);

    // mensagem nova do cliente reabre
    await hook(id, secret, upsert('L1', '5511944440000', { conversation: 'Oi de novo' })).expect(200);
    expect(await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } })).toMatchObject({ status: 'aberta', unread: 1 });

    // sem histórico configurado (0 dias), nada entra
    await db.chat_Channel.update({ where: { id }, data: { historyDays: 0 } });
    expect((await hook(id, secret, { event: 'messages.set', data: [hist('H9', '5511955550000', { conversation: 'x' }, 1)] }).expect(200)).body).toMatchObject({ imported: 0 });
  });

  it('ficha do cliente: buscar, vincular, resumo por permissão, nome, não quer receber e desvincular', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, upsert('W1', '5511933330000', { conversation: 'Oi' })).expect(200);
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: id } });
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    const customer = await db.customer.create({ data: { name: 'Construtora Beta', corporateName: 'Construtora Beta Ltda', cnpj: '11222333000181', companyId: company.id, rankId: rank.id, stateId: state.id, cityId: city.id } });
    await db.commercial_Proposal.create({ data: { companyId: company.id, customerId: customer.id, number: 'PC-T-1', year: 2026, sequence: 1, title: 'Linha de vida galpão', referenceDate: new Date(), snapshot: {}, status: 'enviada' as never, total: 12500 } });
    await db.financialRecords.create({ data: { companyId: company.id, customerId: customer.id, accrualDate: new Date().toISOString().slice(0, 7), gateway: 'manual', paymentMethod: 'boleto', status: 'waiting', value: 800, dueDate: new Date(Date.now() - 2 * 86400000), description: 'Parcela 1' } as any });

    const CHAT = ['view_conversas', 'todas_conversas', 'responder_conversas'];
    await api().get('/chat/customers?search=beta').set(auth(company.id, CHAT)).expect(403);
    const found = (await api().get('/chat/customers?search=beta').set(auth(company.id, [...CHAT, 'list_clientes'])).expect(200)).body;
    expect(found).toEqual([expect.objectContaining({ id: customer.id, name: 'Construtora Beta', place: expect.stringContaining('/') })]);
    expect((await api().get('/chat/customers?search=112223').set(auth(company.id, [...CHAT, 'list_clientes'])).expect(200)).body).toHaveLength(1);

    const linked = (await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id, CHAT)).send({ customerId: customer.id, name: 'Ana da Beta' }).expect(200)).body;
    expect(linked).toMatchObject({ customer: { id: customer.id, name: 'Construtora Beta' }, contact: { name: 'Ana da Beta' } });
    expect(linked.messages.some((m: any) => m.text === 'Vinculado ao cliente Construtora Beta')).toBe(true);
    await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id, CHAT)).send({ customerId: 999999 }).expect(400);
    await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id, ['view_conversas', 'todas_conversas'])).send({ name: 'x' }).expect(403);

    // resumo só com o que a pessoa pode ver
    const bare = (await api().get(`/chat/conversations/${conv.id}/customer`).set(auth(company.id, CHAT)).expect(200)).body;
    expect(bare).toMatchObject({ customer: { id: customer.id }, proposals: null, orders: null, receivables: null, subscriptions: null });
    const full = (await api().get(`/chat/conversations/${conv.id}/customer`).set(auth(company.id, [...CHAT, 'list_comercial', 'list_financeiro', 'list_ordens_de_servico', 'list_classes'])).expect(200)).body;
    expect(full.proposals).toEqual([expect.objectContaining({ number: 'PC-T-1', status: 'enviada', total: 12500 })]);
    expect(full.receivables).toMatchObject({ count: 1, total: 800, overdue: 1 });
    expect(full.orders).toEqual([]);
    expect(full.subscriptions).toEqual([]);

    // não quer receber: trava o envio; voltar libera
    await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id, CHAT)).send({ optOut: true }).expect(200);
    expect((await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id, CHAT)).send({ text: 'Olá' }).expect(400)).body.message).toMatch(/não receber/);
    await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id, CHAT)).send({ optOut: false }).expect(200);
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'OUTB' } });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id, CHAT)).send({ text: 'Olá' }).expect(200);

    const unlinked = (await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id, CHAT)).send({ customerId: null }).expect(200)).body;
    expect(unlinked.customer).toBeNull();
    expect((await api().get(`/chat/conversations/${conv.id}/customer`).set(auth(company.id, CHAT)).expect(200)).body).toEqual({ customer: null });
  });
});
