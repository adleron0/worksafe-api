import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'crypto';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { InstagramMessagesService } from 'src/features/ai/connectors/instagram-messages.service';
import { ChatInstagramService } from 'src/features/chat/chat-instagram.service';
import { ChatMediaService } from 'src/features/chat/chat-media.service';
import { ChatSendService } from 'src/features/chat/chat-send.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * Conversas (fase 4): ações comerciais a partir da conversa — registrar o
 * contato no acompanhamento, agendar retorno, abrir/ligar negociação e links
 * para mandar ao cliente.
 */
describe('Conversas fase 4: ações comerciais (e2e)', () => {
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


  const COM = ['view_conversas', 'todas_conversas', 'responder_conversas', 'list_comercial', 'create_comercial', 'update_comercial', 'update_acompanhamento', 'list_classes'];

  async function comCliente(companyId: number, name = 'Construtora Beta', cnpj = '11222333000181') {
    const db = testDb();
    const rank = (await db.dOM_Ranks.findFirst({ where: { companyId } })) ?? (await db.dOM_Ranks.create({ data: { name: 'A', companyId } }));
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    return db.customer.create({ data: { name, corporateName: `${name} Ltda`, cnpj, companyId, rankId: rank.id, stateId: state.id, cityId: city.id } });
  }

  async function conversaComCliente() {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, upsert('A1', '5511933330000', { conversation: 'Quero orçamento de linha de vida' })).expect(200);
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: id } });
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'OUT1' } });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Claro! Qual o endereço da obra?' }).expect(200);
    await sendQueue();
    const customer = await comCliente(company.id);
    return { company, db, conv, customer, channelId: id };
  }

  it('registrar o contato: pede cliente e permissão, guarda o trecho da conversa e marca o retorno', async () => {
    const { company, db, conv, customer } = await conversaComCliente();
    await api().post(`/chat/conversations/${conv.id}/activity`).set(auth(company.id, COM)).send({ result: 'x' }).expect(400);
    await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id)).send({ customerId: customer.id }).expect(200);
    await api().post(`/chat/conversations/${conv.id}/activity`).set(auth(company.id, ['view_conversas', 'todas_conversas', 'responder_conversas'])).send({}).expect(403);

    const tomorrow = new Date(Date.now() + 86400000 - 3 * 3600000).toISOString().slice(0, 10);
    const done = (await api().post(`/chat/conversations/${conv.id}/activity`).set(auth(company.id, COM))
      .send({ result: 'Pediu orçamento da linha de vida', next: { dueDate: tomorrow, dueTime: '10:00', subject: 'Mandar a proposta' } }).expect(201)).body;
    const row = await db.commercial_Activity.findUniqueOrThrow({ where: { id: done.id } });
    expect(row).toMatchObject({ type: 'whatsapp', customerId: customer.id, chatConversationId: conv.id, subject: 'Conversa pelo WhatsApp', result: 'Pediu orçamento da linha de vida' });
    expect(row.doneAt).not.toBeNull();
    expect(row.notes).toMatch(/Carlos Cliente: Quero orçamento de linha de vida/);
    expect(row.notes).toMatch(/: Claro! Qual o endereço da obra\?/);
    const next = await db.commercial_Activity.findUniqueOrThrow({ where: { id: done.nextId } });
    expect(next).toMatchObject({ subject: 'Mandar a proposta', dueTime: '10:00', chatConversationId: conv.id, doneAt: null });

    // sem o trecho
    const plain = (await api().post(`/chat/conversations/${conv.id}/activity`).set(auth(company.id, COM)).send({ excerpt: false, notes: 'Só anotação' }).expect(201)).body;
    expect((await db.commercial_Activity.findUniqueOrThrow({ where: { id: plain.id } })).notes).toBe('Só anotação');

    const commercial = (await api().get(`/chat/conversations/${conv.id}/commercial`).set(auth(company.id, COM)).expect(200)).body;
    expect(commercial.activities[0]).toMatchObject({ subject: 'Mandar a proposta', dueDate: tomorrow, fromHere: true, overdue: false });
    // sem permissão do comercial, a ficha não mostra
    expect((await api().get(`/chat/conversations/${conv.id}/commercial`).set(auth(company.id)).expect(200)).body).toEqual({ deals: null, activities: null });
  });

  it('agendar retorno: exige o dia e aparece atrasado quando passa', async () => {
    const { company, db, conv, customer } = await conversaComCliente();
    await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id)).send({ customerId: customer.id }).expect(200);
    await api().post(`/chat/conversations/${conv.id}/return`).set(auth(company.id, COM)).send({ subject: 'Ligar' }).expect(400);
    const created = (await api().post(`/chat/conversations/${conv.id}/return`).set(auth(company.id, COM)).send({ dueDate: '2026-01-05', dueTime: '09:30', type: 'ligacao' }).expect(201)).body;
    expect(await db.commercial_Activity.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ type: 'ligacao', subject: 'Retornar a conversa', chatConversationId: conv.id, doneAt: null });
    const commercial = (await api().get(`/chat/conversations/${conv.id}/commercial`).set(auth(company.id, COM)).expect(200)).body;
    expect(commercial.activities[0]).toMatchObject({ id: created.id, overdue: true });
  });

  it('negociação: abre pela conversa, liga só do mesmo cliente, solta e some ao trocar de cliente', async () => {
    const { company, db, conv, customer } = await conversaComCliente();
    await api().post(`/chat/conversations/${conv.id}/deal`).set(auth(company.id, COM)).send({}).expect(400);
    await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id)).send({ customerId: customer.id }).expect(200);
    await api().post(`/chat/conversations/${conv.id}/deal`).set(auth(company.id, COM.filter((p) => p !== 'create_comercial'))).send({}).expect(403);
    const deal = (await api().post(`/chat/conversations/${conv.id}/deal`).set(auth(company.id, COM)).send({ title: 'Linha de vida galpão', excerpt: true }).expect(201)).body;
    expect(deal.number).toMatch(/^NG-/);
    expect((await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } })).dealId).toBe(deal.id);
    expect((await db.commercial_Deal.findUniqueOrThrow({ where: { id: deal.id } })).notes).toMatch(/Começou na conversa \(WhatsApp\)/);
    const commercial = (await api().get(`/chat/conversations/${conv.id}/commercial`).set(auth(company.id, COM)).expect(200)).body;
    expect(commercial.deals.current).toMatchObject({ id: deal.id, title: 'Linha de vida galpão' });
    expect(commercial.deals.options.map((d: any) => d.id)).toEqual([deal.id]);

    // o contato registrado depois já entra na negociação
    const act = (await api().post(`/chat/conversations/${conv.id}/activity`).set(auth(company.id, COM)).send({}).expect(201)).body;
    expect((await db.commercial_Activity.findUniqueOrThrow({ where: { id: act.id } })).dealId).toBe(deal.id);

    const other = await comCliente(company.id, 'Outra Empresa', '11444777000161');
    const foreign = await db.commercial_Deal.create({ data: { companyId: company.id, number: 'NG-X-1', year: 2026, sequence: 99, customerId: other.id, title: 'Outra', sellerId: userId } });
    await api().put(`/chat/conversations/${conv.id}/deal`).set(auth(company.id, COM)).send({ dealId: foreign.id }).expect(400);
    await api().put(`/chat/conversations/${conv.id}/deal`).set(auth(company.id, COM)).send({ dealId: null }).expect(200);
    expect((await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } })).dealId).toBeNull();
    await api().put(`/chat/conversations/${conv.id}/deal`).set(auth(company.id, COM)).send({ dealId: deal.id }).expect(200);
    await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id)).send({ customerId: other.id }).expect(200);
    expect((await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } })).dealId).toBeNull();
  });

  it('links para mandar: turmas abertas do site, propostas enviadas e a negociação', async () => {
    const { company, db, conv, customer } = await conversaComCliente();
    await db.company.update({ where: { id: company.id }, data: { lp_domain: 'site.exemplo.com.br', system_domain: 'sistema.exemplo.com.br' } });
    await api().patch(`/chat/conversations/${conv.id}/contact`).set(auth(company.id)).send({ customerId: customer.id }).expect(200);
    const course = await makeCourse(company.id);
    const soon = new Date(Date.now() + 10 * 86400000);
    const open = await makeCourseClass(company.id, course.id, { name: 'NR-35 Dezembro', initialDate: soon, finalDate: soon, discountPrice: 450 });
    const closed = await makeCourseClass(company.id, course.id, { name: 'NR-35 Fechada', initialDate: soon, finalDate: soon, openClass: false });
    await makeCourseClass(company.id, course.id, { name: 'NR-35 Antiga', initialDate: new Date('2025-01-10'), finalDate: new Date('2025-01-11') });
    await db.commercial_Proposal.create({ data: { companyId: company.id, customerId: customer.id, number: 'PC-T-1', year: 2026, sequence: 1, title: 'Linha de vida', referenceDate: new Date(), snapshot: {}, status: 'enviada' as never, total: 12500, publicKey: 'chave-da-proposta' } });
    await db.commercial_Proposal.create({ data: { companyId: company.id, customerId: customer.id, number: 'PC-T-2', year: 2026, sequence: 2, title: 'Rascunho', referenceDate: new Date(), snapshot: {}, total: 10 } });

    const links = (await api().get(`/chat/conversations/${conv.id}/links`).set(auth(company.id, COM)).expect(200)).body;
    expect(links.classes.map((c: any) => c.name)).toEqual(expect.arrayContaining(['NR-35 Dezembro', 'NR-35 Fechada']));
    expect(links.classes.find((c: any) => c.name === 'NR-35 Antiga')).toBeUndefined();
    expect(links.classes.find((c: any) => c.id === open.id)).toMatchObject({ open: true, price: 450, url: `https://site.exemplo.com.br/turma/${open.id}` });
    expect(links.classes.find((c: any) => c.id === closed.id)).toMatchObject({ open: false, url: null });
    expect(links.proposals).toEqual([expect.objectContaining({ number: 'PC-T-1', url: 'https://sistema.exemplo.com.br/proposta/chave-da-proposta', total: 12500 })]);
    expect(links.deal).toBeNull();

    const deal = (await api().post(`/chat/conversations/${conv.id}/deal`).set(auth(company.id, COM)).send({}).expect(201)).body;
    await api().post(`/commercial/deals/${deal.id}/link`).set(auth(company.id, COM)).expect(201);
    const after = (await api().get(`/chat/conversations/${conv.id}/links`).set(auth(company.id, COM)).expect(200)).body;
    expect(after.deal.url).toMatch(/^https:\/\/sistema\.exemplo\.com\.br\/negociacao\//);
    // sem permissão nas áreas, não vê nada
    expect((await api().get(`/chat/conversations/${conv.id}/links`).set(auth(company.id)).expect(200)).body).toMatchObject({ classes: [], proposals: [], deal: null });
  });
});
