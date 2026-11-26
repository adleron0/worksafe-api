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
import { makeCompany, makeSeller } from './setup/factories';
import { FakeProvider } from 'src/features/ai/providers/fake.provider';
import { BotService } from 'src/features/ai/bots/bot.service';
import { ChatBotService } from 'src/features/chat/chat-bot.service';

/**
 * Conversas (fase 5): bots — rascunho no modo "sugere resposta" (e o
 * aproveitamento), triagem, atende, passar para bot e retomar, fora do horário.
 * Tudo com o fornecedor simulado (nenhuma IA de verdade é chamada).
 */
describe('Conversas fase 5: bots (e2e)', () => {
  const PERMS = ['view_conversas', 'todas_conversas', 'responder_conversas', 'canais_conversas'];
  const EVO = 'http://evolution.test';
  const FB = 'https://graph.facebook.com/v27.0';
  const SECRET = 'segredo-do-app';
  let jwt: JwtService;
  let media: ChatMediaService;
  let bridge: ChatInstagramService;
  let sendQueue: () => Promise<void>;
  let bots: ChatBotService;
  let botDefaults: BotService;
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
    bots = app.get(ChatBotService, { strict: false });
    bots.delayMs = 0;
    botDefaults = app.get(BotService, { strict: false });
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



  async function grant(names: string[]) {
    const db = testDb();
    for (const name of names) {
      const permission = await db.permission.upsert({ where: { name }, create: { name, group: 'conversas' }, update: {} });
      await db.userPermission.create({ data: { userId, permissionId: permission.id } });
    }
  }

  /** Número conectado com o bot do Comercial no modo pedido. */
  async function comBot(mode: string, settings?: Record<string, unknown>) {
    const { company, db } = await cenario();
    await grant(['responder_conversas', 'usar_bot_comercial']);
    await botDefaults.ensureDefaults(company.id);
    const bot = await db.ai_Bot.findFirstOrThrow({ where: { companyId: company.id, key: 'comercial' } });
    const { id, secret } = await conectado(company.id);
    await api().put(`/chat/channels/${id}`).set(auth(company.id)).send({ botMode: mode, defaultBotId: bot.id, ...(settings ? { settings } : {}) }).expect(200);
    return { company, db, bot, channelId: id, secret };
  }
  const inbound = async (channelId: number, secret: string, id: string, text: string, phone = '5511933330000') => {
    await hook(channelId, secret, upsert(id, phone, { conversation: text })).expect(200);
    await bots.idle();
  };

  it('sugere resposta: rascunho na conversa, enviar igual, editar, descartar e o aproveitamento', async () => {
    const { company, db, bot, channelId, secret } = await comBot('sugere', { bot: { instrucoes: 'Laudo de linha de vida custa a partir de R$ 900.' } });
    FakeProvider.script([() => ({ text: 'Olá! Fazemos sim. O laudo começa em R$ 900. Qual a cidade da obra?' })]);
    await inbound(channelId, secret, 'S1', 'Vocês fazem laudo de linha de vida?');
    expect(JSON.stringify(FakeProvider.requests[0].messages[0])).toContain('Laudo de linha de vida custa a partir de R$ 900.');
    expect(FakeProvider.requests[0].tools.map((t) => t.name)).not.toContain('conversa_responder'); // só sugere: não manda nada
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId } });
    const view = (await api().get(`/chat/conversations/${conv.id}`).set(auth(company.id)).expect(200)).body;
    expect(view.suggestion).toMatchObject({ text: 'Olá! Fazemos sim. O laudo começa em R$ 900. Qual a cidade da obra?', bot: { id: bot.id } });
    expect(await db.chat_Message.count({ where: { conversationId: conv.id, direction: 'out' } })).toBe(0);

    // enviada como estava
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'OUT1' } });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: view.suggestion.text, suggestionId: view.suggestion.id }).expect(200);
    expect(await db.chat_BotSuggestion.findUniqueOrThrow({ where: { id: view.suggestion.id } })).toMatchObject({ status: 'enviada', decidedByUserId: userId });
    await sendQueue();

    // editada
    FakeProvider.script([() => ({ text: 'Em Recife atendemos sim!' })]);
    await inbound(channelId, secret, 'S2', 'Recife');
    const s2 = (await api().get(`/chat/conversations/${conv.id}`).set(auth(company.id)).expect(200)).body.suggestion;
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'OUT2' } });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Em Recife atendemos sim! Posso marcar uma visita?', suggestionId: s2.id }).expect(200);
    expect(await db.chat_BotSuggestion.findUniqueOrThrow({ where: { id: s2.id } })).toMatchObject({ status: 'editada', finalText: 'Em Recife atendemos sim! Posso marcar uma visita?' });
    await sendQueue();

    // descartada, e "sem sugestão" não grava nada
    FakeProvider.script([() => ({ text: 'Pode ser amanhã às 9h.' })]);
    await inbound(channelId, secret, 'S3', 'Pode ser amanhã?');
    const s3 = (await api().get(`/chat/conversations/${conv.id}`).set(auth(company.id)).expect(200)).body.suggestion;
    await api().post(`/chat/conversations/${conv.id}/suggestion/${s3.id}/discard`).set(auth(company.id)).expect(200);
    FakeProvider.script([() => ({ text: 'SEM SUGESTÃO: preciso da agenda da equipe.' })]);
    await inbound(channelId, secret, 'S4', 'Confirma?');
    expect((await api().get(`/chat/conversations/${conv.id}`).set(auth(company.id)).expect(200)).body.suggestion).toBeNull();

    // pedir sugestão na hora
    FakeProvider.script([() => ({ text: 'Confirmado para amanhã às 9h!' })]);
    const asked = (await api().post(`/chat/conversations/${conv.id}/suggestion`).set(auth(company.id)).send({}).expect(201)).body;
    expect(asked.text).toBe('Confirmado para amanhã às 9h!');
    await api().post(`/chat/conversations/${conv.id}/suggestion`).set(auth(company.id, ['view_conversas', 'todas_conversas'])).send({}).expect(403);

    const channel = (await api().get(`/chat/channels/${channelId}`).set(auth(company.id)).expect(200)).body;
    expect(channel.botStats).toMatchObject({ total: 3, enviada: 1, editada: 1, descartada: 1 });
  });

  it('triagem: o bot cumprimenta, passa para o setor certo com resumo e para de responder', async () => {
    const { company, db, bot, channelId, secret } = await comBot('triagem');
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'TRI1' } });
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'conversa_responder', input: { texto: 'Olá! Aqui é a Equipe. Você quer orçamento de serviço ou de treinamento?' } }] }),
      () => ({ text: 'Perguntei o assunto.' }),
    ]);
    await inbound(channelId, secret, 'T1', 'Oi, bom dia');
    expect(FakeProvider.requests[0].tools.map((t) => t.name)).toEqual(expect.arrayContaining(['conversa_responder', 'conversa_encaminhar']));
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId } });
    const out = await db.chat_Message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'out' } });
    expect(out).toMatchObject({ sentByBotId: bot.id, origin: 'bot', text: expect.stringMatching(/orçamento de serviço/) });
    await sendQueue();

    // a triagem só age no começo (ninguém respondeu nas últimas 12 h): simula a pergunta antiga e o cliente voltando
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'conversa_encaminhar', input: { setor: 'treinamentos', resumo: 'Quer turma de NR-35 para 5 pessoas.' } }] }),
      () => ({ text: 'Passei.' }),
    ]);
    await db.chat_Message.updateMany({ where: { conversationId: conv.id, direction: 'out' }, data: { sentAt: new Date(Date.now() - 13 * 3600000) } });
    await inbound(channelId, secret, 'T2', 'Treinamento de NR-35 para 5 pessoas');
    const after = await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(after).toMatchObject({ sector: 'treinamentos', botId: null, status: 'aberta' });
    const note = await db.chat_Message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'note', origin: 'bot' }, orderBy: { id: 'desc' } });
    expect(note.text).toMatch(/passou a conversa para Treinamentos\. Quer turma de NR-35/);

    // com dono, a triagem não age
    await db.chat_Conversation.update({ where: { id: conv.id }, data: { assignedUserId: userId } });
    FakeProvider.script([]);
    await inbound(channelId, secret, 'T3', 'Alô?');
    expect(FakeProvider.requests).toHaveLength(0);
  });

  it('atende: responde sozinho, passa para humano em dinheiro e sai quando uma pessoa responde', async () => {
    const { company, db, bot, channelId, secret } = await comBot('atende');
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'AT1' } });
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'conversa_responder', input: { texto: 'Fazemos sim! Me passa o endereço da obra?' } }] }),
      () => ({ text: 'Respondi.' }),
    ]);
    await inbound(channelId, secret, 'A1', 'Vocês fazem linha de vida?');
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId } });
    expect(conv.botId).toBe(bot.id);
    expect((await api().get(`/chat/conversations/${conv.id}`).set(auth(company.id)).expect(200)).body.bot).toMatchObject({ id: bot.id });
    await sendQueue();

    // não fez nada: fica avisado para a equipe e o bot sai
    FakeProvider.script([() => ({ text: 'Não sei.' })]);
    await inbound(channelId, secret, 'A2', 'Quanto fica com 20% de desconto?');
    expect((await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } })).botId).toBeNull();
    expect((await db.chat_Message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'note' }, orderBy: { id: 'desc' } })).text).toMatch(/não soube responder/);

    // passar para bot de novo e retomar
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'AT2' } });
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'conversa_encaminhar', input: { setor: 'comercial', resumo: 'Pediu desconto de 20%.', motivo: 'dinheiro' } }] }),
      () => ({ text: 'Passei.' }),
    ]);
    await api().post(`/chat/conversations/${conv.id}/bot`).set(auth(company.id)).send({ botId: bot.id }).expect(200);
    await bots.idle();
    expect(await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } })).toMatchObject({ botId: null, sector: 'comercial' });

    await api().post(`/chat/conversations/${conv.id}/bot`).set(auth(company.id)).send({ botId: bot.id }).expect(200);
    await bots.idle();
    await api().delete(`/chat/conversations/${conv.id}/bot`).set(auth(company.id)).expect(200);
    expect(await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } })).toMatchObject({ botId: null, assignedUserId: userId });

    // uma pessoa respondendo tira o bot da conversa
    await db.chat_Conversation.update({ where: { id: conv.id }, data: { botId: bot.id, assignedUserId: null } });
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'AT3' } });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Oi, aqui é o Júlio, vou te ajudar.' }).expect(200);
    expect((await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } })).botId).toBeNull();

    // sem permissão de responder, não passa para bot
    await api().post(`/chat/conversations/${conv.id}/bot`).set(auth(company.id, ['view_conversas', 'todas_conversas'])).send({ botId: bot.id }).expect(403);
  });

  // ---------------------------------------------------------------- Instagram

  const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const igWebhook = (body: unknown) => {
    const raw = JSON.stringify(body);
    return api().post('/ai/connectors/instagram/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw);
  };
  const dm = (mid: string, text: string) => ({
    object: 'instagram',
    entry: [{ id: '1784', time: Date.now(), messaging: [{ sender: { id: '777' }, recipient: { id: '1784' }, timestamp: Date.now(), message: { mid, text } }] }],
  });

  it('Instagram: o bot do canal atende e faz triagem no Direct (a Nina dos Conectores não responde mais)', async () => {
    const { company, db } = await cenario();
    await grant(['responder_conversas', 'usar_bot_comercial', 'instagram_mensagens_bots']);
    await botDefaults.ensureDefaults(company.id);
    const bot = await db.ai_Bot.findFirstOrThrow({ where: { companyId: company.id, key: 'comercial' } });
    await db.ai_Connector.create({ data: { companyId: company.id, provider: 'instagram', accountId: '1784', username: 'worksafebrasil', accountType: 'BUSINESS', tokenEncrypted: encryptPayload('chave-do-sistema'), connectedByUserId: userId, settings: { responder_mensagens: { mode: 'automatico' } } } });
    const ig = (await api().get('/chat/channels').set(auth(company.id)).expect(200)).body.find((c: any) => c.type === 'instagram');
    // quem conectou a conta é o dono do bot do canal
    expect((await db.chat_Channel.findUniqueOrThrow({ where: { id: ig.id } })).termsAcceptedByUserId).toBe(userId);
    await api().put(`/chat/channels/${ig.id}`).set(auth(company.id)).send({ botMode: 'atende', defaultBotId: bot.id }).expect(200);

    // atende: responde pelo Direct na hora, assinado com o nome do bot
    let replied = '';
    nock(FB).post('/1784/messages', (body) => { replied = body.message?.text ?? ''; return body.recipient.id === '777'; }).query(true).reply(200, { recipient_id: '777', message_id: 'ig-bot-1' });
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'conversa_responder', input: { texto: 'Temos sim! A próxima turma é dia 10.' } }] }),
      () => ({ text: 'Respondi.' }),
    ]);
    await igWebhook(dm('ig-in-1', 'Vocês têm curso de NR-35?')).expect(200);
    await bridge.idle();
    await bots.idle();
    expect(FakeProvider.requests).toHaveLength(2);
    expect(JSON.stringify(FakeProvider.requests[0].messages[0])).toContain('Direct do Instagram');
    expect(replied).toMatch(/Temos sim! A próxima turma é dia 10\.$/);
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId: ig.id } });
    expect(conv.botId).toBe(bot.id);
    expect(await db.chat_Message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'out' } })).toMatchObject({ externalId: 'ig:ig-bot-1', sentByBotId: bot.id, origin: 'bot', text: 'Temos sim! A próxima turma é dia 10.' });
    expect(await db.ai_SocialMessage.findUniqueOrThrow({ where: { externalId: 'ig-bot-1' } })).toMatchObject({ direction: 'out', repliedByBotId: bot.id });
    // a resposta automática antiga (Conectores) não age
    expect((await db.ai_SocialMessage.findUniqueOrThrow({ where: { externalId: 'ig-in-1' } })).status).toBe('received');

    // passa para a equipe com setor e resumo
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'conversa_encaminhar', input: { setor: 'treinamentos', resumo: 'Quer inscrever 5 pessoas.' } }] }),
      () => ({ text: 'Passei.' }),
    ]);
    await igWebhook(dm('ig-in-2', 'Quero inscrever 5 pessoas da minha empresa')).expect(200);
    await bridge.idle();
    await bots.idle();
    expect(await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } })).toMatchObject({ botId: null, sector: 'treinamentos' });

    // sem a permissão do Direct para quem conectou, o bot não responde e avisa
    await db.userPermission.deleteMany({ where: { userId, permission: { name: 'instagram_mensagens_bots' } } });
    await flushCache();
    await api().post(`/chat/conversations/${conv.id}/bot`).set(auth(company.id)).send({ botId: bot.id }).expect(200);
    await bots.idle();
    expect((await db.chat_Message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'note' }, orderBy: { id: 'desc' } })).text).toMatch(/permissão de responder mensagens do Direct/);
  });

  it('fora do horário: o bot assume no lugar da mensagem fixa; sem o dono do número com acesso, não age', async () => {
    const closed = { enabled: true, dias: [], inicio: '08:00', fim: '18:00', mensagemFora: 'Estamos fechados.' };
    const { company, db, bot, channelId, secret } = await comBot('sugere', { horario: closed, bot: { foraDoHorario: true } });
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'FH1' } });
    FakeProvider.script([
      () => ({ toolCalls: [{ name: 'conversa_responder', input: { texto: 'Boa noite! Já anoto seu pedido e amanhã cedo a equipe te retorna.' } }] }),
      () => ({ text: 'Respondi.' }),
    ]);
    await inbound(channelId, secret, 'F1', 'Preciso de um orçamento');
    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { channelId } });
    const outs = await db.chat_Message.findMany({ where: { conversationId: conv.id, direction: 'out' } });
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ sentByBotId: bot.id, text: expect.stringMatching(/amanhã cedo/) });

    // quem conectou perdeu o acesso ao bot: nada é chamado e fica a nota
    await db.userPermission.deleteMany({ where: { userId, permission: { name: 'usar_bot_comercial' } } });
    await db.chat_Conversation.update({ where: { id: conv.id }, data: { botId: null } });
    FakeProvider.script([]);
    await inbound(channelId, secret, 'F2', 'Alô?', '5511977770000');
    expect(FakeProvider.requests).toHaveLength(0);
    const other = await db.chat_Conversation.findFirstOrThrow({ where: { channelId, id: { not: conv.id } } });
    expect((await db.chat_Message.findFirstOrThrow({ where: { conversationId: other.id, direction: 'note' } })).text).toMatch(/não tem acesso/);
  });
});
