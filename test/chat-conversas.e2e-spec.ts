import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Conversas (fase 0): números de WhatsApp pelo Evolution (simulado com nock),
 * termo de risco, QR code, webhook com segredo, caixa de entrada e a fila de
 * envio com as proteções contra bloqueio.
 */
describe('Conversas: WhatsApp pelo Evolution (e2e)', () => {
  const PERMS = ['view_conversas', 'todas_conversas', 'responder_conversas', 'canais_conversas'];
  const EVO = 'http://evolution.test';
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    process.env.EVOLUTION_URL = EVO;
    process.env.EVOLUTION_API_KEY = 'chave-global';
    process.env.CHAT_WEBHOOK_BASE = 'http://api.interna:3000';
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });
  afterAll(async () => {
    for (const key of ['EVOLUTION_URL', 'EVOLUTION_API_KEY', 'CHAT_WEBHOOK_BASE']) delete process.env[key];
    nock.cleanAll();
    nock.enableNetConnect();
    await shutdownTestApp();
  });
  beforeEach(async () => {
    await resetDb();
    await flushCache();
  });
  afterEach(() => nock.cleanAll());

  const auth = (companyId: number, permissions: string[] = PERMS, sub = userId) => {
    const payload = { sub, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());

  /** Cria o número, aceita o termo e conecta (QR), devolvendo o segredo do webhook. */
  async function conectado(companyId: number, extra: Record<string, unknown> = {}) {
    const created = await api().post('/chat/channels').set(auth(companyId)).send({ name: 'WhatsApp Serviços', sector: 'servicos', ...extra }).expect(201);
    const id = created.body.id;
    let secret = '';
    nock(EVO).get(/\/instance\/connectionState\/.*/).reply(404, { response: { message: ['not found'] } });
    nock(EVO).post('/instance/create', (body) => { secret = body.webhook.headers['x-ws-chat-secret']; return body.webhook.url === `http://api.interna:3000/chat/webhook/evolution/${id}`; }).reply(201, { instance: { state: 'connecting' } });
    nock(EVO).get(/\/instance\/connect\/.*/).reply(200, { base64: 'data:image/png;base64,QR', code: '2@x', pairingCode: null });
    const res = await api().post(`/chat/channels/${id}/connect`).set(auth(companyId)).send({ acceptTerms: true }).expect(200);
    expect(res.body).toMatchObject({ status: 'aguardando', qr: 'data:image/png;base64,QR' });
    await hook(id, secret, { event: 'connection.update', data: { state: 'open', wuid: '5511900000001@s.whatsapp.net', profileName: 'WorkSafe Serviços' } }).expect(200);
    return { id, secret };
  }
  const hook = (channelId: number, secret: string, body: unknown) => api().post(`/chat/webhook/evolution/${channelId}`).set('x-ws-chat-secret', secret).send(body as object);
  const inbound = (id: string, phone: string, text: string, extra: Record<string, unknown> = {}) => ({
    event: 'messages.upsert',
    data: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id }, pushName: 'Carlos Cliente', message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), ...extra },
  });

  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    return { company, db: testDb() };
  }

  it('exige o termo, conecta pelo QR e marca o número quando o celular conecta', async () => {
    const { company, db } = await cenario();
    const created = await api().post('/chat/channels').set(auth(company.id)).send({ name: 'WhatsApp Treinamentos', sector: 'treinamentos', botMode: 'sugere' }).expect(201);
    expect(created.body).toMatchObject({ status: 'desconectado', termsOk: false, botMode: 'sugere', memberIds: [userId] });
    expect(created.body.settings.limites).toEqual({ novosPorDia: 10, porMinuto: 12, porHora: 200, porDia: 1000 });

    await api().post(`/chat/channels/${created.body.id}/connect`).set(auth(company.id)).send({}).expect(400);

    const { id } = await conectado(company.id);
    const channel = await db.chat_Channel.findUniqueOrThrow({ where: { id } });
    expect(channel).toMatchObject({ status: 'conectado', phone: '5511900000001', profileName: 'WorkSafe Serviços', termsVersion: '2026-11-25', termsAcceptedByUserId: userId });
    expect(channel.webhookTokenHash).toHaveLength(64);
  });

  it('webhook sem o segredo certo é recusado', async () => {
    const { company } = await cenario();
    const { id } = await conectado(company.id);
    await hook(id, 'errado', inbound('A1', '5511988887777', 'oi')).expect(403);
    await api().post(`/chat/webhook/evolution/${id}`).send(inbound('A1', '5511988887777', 'oi')).expect(403);
  });

  it('mensagem recebida cria contato, conversa no setor do número e vincula o cliente pelo telefone', async () => {
    const { company, db } = await cenario();
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    const customer = await db.customer.create({ data: { name: 'Construtora Alfa', corporateName: 'Construtora Alfa Ltda', cnpj: '11222333000181', companyId: company.id, rankId: rank.id, phone: '(11) 98888-7777', email: 'a@alfa.local', stateId: state.id, cityId: city.id } });
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, inbound('MSG1', '5511988887777', 'Bom dia, queria um orçamento')).expect(200);
    await hook(id, secret, inbound('MSG1', '5511988887777', 'Bom dia, queria um orçamento')).expect(200); // repetido não duplica
    await hook(id, secret, { event: 'messages.upsert', data: { key: { remoteJid: '1203630@g.us', fromMe: false, id: 'G1' }, message: { conversation: 'grupo' } } }).expect(200);

    const list = await api().get('/chat/conversations').set(auth(company.id)).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ sector: 'servicos', unread: 1, lastMessagePreview: 'Bom dia, queria um orçamento', customer: { id: customer.id, name: 'Construtora Alfa' }, contact: { phone: '5511988887777', name: 'Construtora Alfa' } });
    expect(list.body.counts).toMatchObject({ abertas: 1, sem_dono: 1, nao_lidas: 1 });
    expect(await db.chat_Message.count()).toBe(1);
  });

  it('envio passa pela fila, marca o dono da conversa e acompanha entregue/lida', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, inbound('IN1', '5511988887777', 'Oi')).expect(200);
    const conv = (await api().get('/chat/conversations').set(auth(company.id))).body.items[0];

    nock(EVO).post(/\/message\/sendText\/.*/, (body) => body.number === '5511988887777' && body.text === 'Olá Carlos, tudo bem?' && body.linkPreview === false).reply(201, { key: { id: 'OUT1' } });
    const sent = await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Olá Carlos, tudo bem?' }).expect(200);
    expect(sent.body).toMatchObject({ status: 'sent', externalId: 'OUT1', sentByUserId: userId });

    await hook(id, secret, { event: 'messages.update', data: { keyId: 'OUT1', status: 'DELIVERY_ACK' } }).expect(200);
    await hook(id, secret, { event: 'messages.update', data: { keyId: 'OUT1', status: 'READ' } }).expect(200);
    await hook(id, secret, { event: 'messages.update', data: { keyId: 'OUT1', status: 'DELIVERY_ACK' } }).expect(200); // não volta
    expect((await db.chat_Message.findUniqueOrThrow({ where: { externalId: 'OUT1' } })).status).toBe('read');

    // eco do próprio envio (send.message) não duplica
    await hook(id, secret, { event: 'send.message', data: { key: { remoteJid: '5511988887777@s.whatsapp.net', fromMe: true, id: 'OUT1' }, message: { conversation: 'Olá Carlos, tudo bem?' } } }).expect(200);
    expect(await db.chat_Message.count({ where: { direction: 'out' } })).toBe(1);

    const detail = await api().get(`/chat/conversations/${conv.id}`).set(auth(company.id)).expect(200);
    expect(detail.body.assignedUser).toMatchObject({ id: userId });
  });

  it('proteções: contato novo pede confirmação e respeita o limite do dia; sem link na 1ª mensagem; sem encurtador', async () => {
    const { company, db } = await cenario();
    const { id } = await conectado(company.id, { settings: { limites: { novosPorDia: 1 } } });

    await api().post('/chat/conversations').set(auth(company.id)).send({ channelId: id, phone: '11 97777-0001', text: 'Olá, aqui é da WorkSafe, você pediu um contato' }).expect(409);
    await api().post('/chat/conversations').set(auth(company.id)).send({ channelId: id, phone: '11 97777-0001', text: 'Veja www.worksafebrasil.com.br', confirmedNew: true }).expect(400);

    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'N1' } });
    await api().post('/chat/conversations').set(auth(company.id)).send({ channelId: id, phone: '11 97777-0001', text: 'Olá, aqui é da WorkSafe, você pediu um contato', confirmedNew: true }).expect(200);
    const second = await api().post('/chat/conversations').set(auth(company.id)).send({ channelId: id, phone: '11 97777-0002', text: 'Olá, aqui é da WorkSafe, você pediu um contato', confirmedNew: true }).expect(400);
    expect(second.body.message).toMatch(/Limite de 1 contatos novos/);

    const conv = await db.chat_Conversation.findFirstOrThrow({ where: { contact: { phone: '5511977770001' } } });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'link https://bit.ly/abc' }).expect(400);
  });

  it('mesmo texto para muitos contatos na mesma hora é barrado', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    const texto = 'Promoção imperdível de treinamento NR-35 só hoje';
    for (let i = 0; i < 6; i++) await hook(id, secret, inbound(`R${i}`, `55119666600${i}0`, 'oi')).expect(200);
    const convs = await db.chat_Conversation.findMany({ orderBy: { id: 'asc' } });
    nock(EVO).post(/\/message\/sendText\/.*/).times(5).reply(201, () => ({ key: { id: `S${Math.random()}` } }));
    for (let i = 0; i < 5; i++) await api().post(`/chat/conversations/${convs[i].id}/messages`).set(auth(company.id)).send({ text: texto }).expect(200);
    const blocked = await api().post(`/chat/conversations/${convs[5].id}/messages`).set(auth(company.id)).send({ text: texto }).expect(400);
    expect(blocked.body.message).toMatch(/muitos contatos/);
  });

  it('"parar" trava os envios para o contato', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, inbound('P1', '5511955554444', 'Parar')).expect(200);
    const conv = await db.chat_Conversation.findFirstOrThrow();
    const res = await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Tudo bem?' }).expect(400);
    expect(res.body.message).toMatch(/não receber/);
    expect(await db.chat_Message.count({ where: { direction: 'note' } })).toBe(1);
  });

  it('limite por minuto segura na fila em vez de descartar', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id, { settings: { limites: { porMinuto: 1 } } });
    await hook(id, secret, inbound('L1', '5511944443333', 'oi')).expect(200);
    const conv = await db.chat_Conversation.findFirstOrThrow();
    nock(EVO).post(/\/message\/sendText\/.*/).reply(201, { key: { id: 'L-OUT1' } });
    await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Primeira' }).expect(200);
    const second = await api().post(`/chat/conversations/${conv.id}/messages`).set(auth(company.id)).send({ text: 'Segunda' }).expect(200);
    expect(second.body.status).toBe('queued');
    expect((await db.chat_Message.findUniqueOrThrow({ where: { id: second.body.id } })).scheduledAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('número banido pausa a fila e mostra o motivo', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, { event: 'connection.update', data: { state: 'close', statusReason: 403 } }).expect(200);
    const channel = await db.chat_Channel.findUniqueOrThrow({ where: { id } });
    expect(channel.status).toBe('banido');
    expect(channel.statusReason).toMatch(/bloqueou/);
  });

  it('quem não vê tudo enxerga só os números da sua equipe; assumir, transferir e resolver deixam histórico', async () => {
    const { company, db } = await cenario();
    const other = await makeSeller(company.id);
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, inbound('V1', '5511933332222', 'oi')).expect(200);
    const conv = await db.chat_Conversation.findFirstOrThrow();

    const outsider = await api().get('/chat/conversations').set(auth(company.id, ['view_conversas', 'responder_conversas'], other.id)).expect(200);
    expect(outsider.body.items).toHaveLength(0);
    await api().get(`/chat/conversations/${conv.id}`).set(auth(company.id, ['view_conversas'], other.id)).expect(404);

    await api().put(`/chat/channels/${id}`).set(auth(company.id)).send({ memberIds: [userId, other.id] }).expect(200);
    const insider = await api().get('/chat/conversations').set(auth(company.id, ['view_conversas', 'responder_conversas'], other.id)).expect(200);
    expect(insider.body.items).toHaveLength(1);

    await api().patch(`/chat/conversations/${conv.id}`).set(auth(company.id, ['view_conversas'], other.id)).send({ assignedUserId: 'me' }).expect(200);
    await api().patch(`/chat/conversations/${conv.id}`).set(auth(company.id)).send({ sector: 'comercial' }).expect(200);
    const done = await api().patch(`/chat/conversations/${conv.id}`).set(auth(company.id)).send({ status: 'resolvida' }).expect(200);
    expect(done.body.status).toBe('resolvida');
    expect(done.body.messages.filter((m: any) => m.direction === 'note').map((m: any) => m.text)).toEqual(['Assumiu a conversa', 'Transferida para o setor Comercial', 'Conversa resolvida']);

    // cliente escreve de novo: reabre
    await hook(id, secret, inbound('V2', '5511933332222', 'mais uma coisa')).expect(200);
    expect((await db.chat_Conversation.findUniqueOrThrow({ where: { id: conv.id } })).status).toBe('aberta');
  });

  it('outra empresa não acessa o número nem a conversa', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id);
    await hook(id, secret, inbound('X1', '5511922221111', 'oi')).expect(200);
    const conv = await db.chat_Conversation.findFirstOrThrow();
    const intruder = await makeCompany();
    await api().get(`/chat/conversations/${conv.id}`).set(auth(intruder.id)).expect(404);
    await api().put(`/chat/channels/${id}`).set(auth(intruder.id)).send({ name: 'x' }).expect(404);
    await api().get('/chat/conversations').set(auth(company.id, ['usar_bots'])).expect(403);
  });

  it('fora do horário responde a mensagem configurada uma vez só', async () => {
    const { company, db } = await cenario();
    const { id, secret } = await conectado(company.id, { settings: { horario: { enabled: true, dias: [], inicio: '08:00', fim: '18:00', mensagemFora: 'Atendemos de segunda a sexta, das 8h às 18h.' } } });
    nock(EVO).post(/\/message\/sendText\/.*/, (body) => body.text === 'Atendemos de segunda a sexta, das 8h às 18h.').once().reply(201, { key: { id: 'AUTO1' } });
    await hook(id, secret, inbound('H1', '5511911110000', 'Oi, tem alguém?')).expect(200);
    await hook(id, secret, inbound('H2', '5511911110000', 'Alô?')).expect(200);
    const auto = await db.chat_Message.findMany({ where: { origin: 'auto' } });
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ status: 'sent', externalId: 'AUTO1' });
  });
});
