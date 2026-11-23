import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as sharp from 'sharp';
import * as request from 'supertest';
import { decryptPayload, encryptPayload } from 'src/utils/crypto';
import { InstagramService } from 'src/features/ai/connectors/instagram.service';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { ToolContext } from 'src/features/ai/tools/tool.types';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Instagram: conexão pela tela de permissão da Meta (state assinado, troca do
 * código pela chave de 60 dias guardada criptografada), posts agendados
 * publicados pela API (contêiner → processamento → publicação) e as
 * ferramentas da Nina com cartão de confirmação. A Meta é simulada (nock).
 */
describe('Instagram (e2e)', () => {
  const PERMS = ['usar_bots', 'conectores_bots', 'instagram_bots'];
  const IG = 'https://graph.instagram.com';
  let jwt: JwtService;
  let catalog: ToolCatalogService;
  let instagram: InstagramService;
  let userId = 0;
  let png: Buffer;

  beforeAll(async () => {
    process.env.PUBLIC_IMAGES_DRIVER = 'memory';
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    catalog = app.get(ToolCatalogService);
    instagram = app.get(InstagramService);
    instagram.waitMs = 0;
    png = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 20, g: 158, b: 94 } } }).png().toBuffer();
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });
  afterAll(async () => {
    delete process.env.PUBLIC_IMAGES_DRIVER;
    delete process.env.INSTAGRAM_APP_ID;
    delete process.env.INSTAGRAM_APP_SECRET;
    nock.cleanAll();
    nock.enableNetConnect();
    await shutdownTestApp();
  });
  beforeEach(async () => {
    await resetDb();
    await flushCache();
    process.env.INSTAGRAM_APP_ID = '999';
    process.env.INSTAGRAM_APP_SECRET = 'segredo-do-app';
  });
  afterEach(() => nock.cleanAll());

  const auth = (companyId: number, permissions: string[] = PERMS) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());

  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    return { company, db: testDb() };
  }

  /** Conecta pela "tela da Meta" simulada e devolve o redirecionamento final. */
  async function conectar(companyId: number) {
    const start = (await api().post('/ai/connectors/instagram/start').set(auth(companyId)).expect(200)).body;
    const state = new URL(start.url).searchParams.get('state')!;
    nock('https://api.instagram.com').post('/oauth/access_token', (body) => body.code === 'codigo-da-meta' && body.client_secret === 'segredo-do-app')
      .reply(200, { data: [{ access_token: 'curta', user_id: '1784', permissions: 'instagram_business_basic,instagram_business_content_publish' }] });
    nock(IG).get('/access_token').query({ grant_type: 'ig_exchange_token', client_secret: 'segredo-do-app', access_token: 'curta' }).reply(200, { access_token: 'chave-longa', token_type: 'bearer', expires_in: 5183944 });
    nock(IG).get('/me').query(true).reply(200, { user_id: '1784', username: 'worksafebrasil', name: 'WorkSafe Brasil', account_type: 'BUSINESS', profile_picture_url: 'https://cdn.exemplo/foto.jpg' });
    const res = await api().get('/ai/connectors/instagram/callback').query({ code: 'codigo-da-meta#_', state }).expect(302);
    return res.headers.location as string;
  }

  /** A Meta recebendo a imagem, processando e publicando. */
  function metaPublica(opts: { kind?: 'feed' | 'story' | 'carousel'; images?: number } = {}) {
    const calls: Record<string, any>[] = [];
    nock('https://imagens.teste.local').get(/.*/).times(opts.images ?? 1).reply(200, png, { 'Content-Type': 'image/png' });
    nock(IG).post('/1784/media').query((q) => { calls.push(q); return true; }).times((opts.images ?? 1) + (opts.kind === 'carousel' ? 1 : 0)).reply(200, () => ({ id: `c${calls.length}` }));
    nock(IG).get(/\/c\d+$/).query(true).reply(200, { status_code: 'FINISHED' });
    nock(IG).post('/1784/media_publish').query((q) => q.access_token === 'chave-longa').reply(200, { id: '9001' });
    nock(IG).get('/9001').query(true).reply(200, { permalink: 'https://www.instagram.com/p/abc/' });
    return calls;
  }

  it('sem o app da Meta cadastrado, a tela avisa e o botão não leva a lugar nenhum', async () => {
    const { company } = await cenario();
    delete process.env.INSTAGRAM_APP_ID;
    const status = (await api().get('/ai/connectors').set(auth(company.id)).expect(200)).body;
    expect(status.instagram).toMatchObject({ configured: false, account: null });
    const err = (await api().post('/ai/connectors/instagram/start').set(auth(company.id)).expect(400)).body;
    expect(err.message).toMatch(/app da Meta ainda não foi cadastrado/);
  });

  it('conecta com um clique: state assinado, chave longa criptografada e conta na tela', async () => {
    const { company, db } = await cenario();
    const start = (await api().post('/ai/connectors/instagram/start').set(auth(company.id)).expect(200)).body;
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('999');
    expect(url.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_content_publish');
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/ai\/connectors\/instagram\/callback$/);

    expect(await conectar(company.id)).toMatch(/\/bots\/conectores\?instagram=ok$/);
    const row = await db.ai_Connector.findFirstOrThrow({ where: { companyId: company.id } });
    expect(row).toMatchObject({ provider: 'instagram', accountId: '1784', username: 'worksafebrasil', status: 'connected', connectedByUserId: userId });
    expect(row.tokenEncrypted).not.toContain('chave-longa');
    expect(decryptPayload(row.tokenEncrypted)).toBe('chave-longa');
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86400000);

    const status = (await api().get('/ai/connectors').set(auth(company.id)).expect(200)).body;
    expect(status.instagram.account).toMatchObject({ username: 'worksafebrasil', status: 'connected' });
    expect(JSON.stringify(status)).not.toContain('chave-longa');

    // quem só publica vê a conexão, mas não conecta nem desconecta
    await api().post('/ai/connectors/instagram/start').set(auth(company.id, ['instagram_bots'])).expect(403);
    await api().get('/ai/connectors').set(auth(company.id, ['usar_bots'])).expect(403);
  });

  it('volta da Meta com erro: cancelou, state adulterado ou conta pessoal', async () => {
    const { company, db } = await cenario();
    const denied = (await api().get('/ai/connectors/instagram/callback').query({ error: 'access_denied', error_reason: 'user_denied' }).expect(302)).headers.location;
    expect(new URL(denied).searchParams.get('motivo')).toMatch(/^Você cancelou/);

    const forged = (await api().get('/ai/connectors/instagram/callback').query({ code: 'x', state: `${Buffer.from(JSON.stringify({ c: company.id, e: Date.now() + 60000 })).toString('base64url')}.assinatura-falsa` }).expect(302)).headers.location;
    expect(new URL(forged).searchParams.get('motivo')).toMatch(/^Pedido de conexão inválido/);

    const start = (await api().post('/ai/connectors/instagram/start').set(auth(company.id)).expect(200)).body;
    nock('https://api.instagram.com').post('/oauth/access_token').reply(200, { data: [{ access_token: 'curta', user_id: '1', permissions: 'instagram_business_basic,instagram_business_content_publish' }] });
    nock(IG).get('/access_token').query(true).reply(200, { access_token: 'longa', expires_in: 100 });
    nock(IG).get('/me').query(true).reply(200, { user_id: '1', username: 'pessoal', account_type: 'PERSONAL' });
    const personal = (await api().get('/ai/connectors/instagram/callback').query({ code: 'c', state: new URL(start.url).searchParams.get('state') }).expect(302)).headers.location;
    expect(new URL(personal).searchParams.get('motivo')).toMatch(/conta do Instagram é pessoal/);
    expect(await db.ai_Connector.count()).toBe(0);
  });

  it('agenda pela tela, publica no horário e guarda o link; story em 9:16 e JPEG', async () => {
    const { company, db } = await cenario();
    await conectar(company.id);
    const up = (await api().post('/ai/instagram/upload').set(auth(company.id)).attach('file', png, 'arte.png').expect(201)).body;
    expect(up.url).toMatch(/^https:\/\/imagens\.teste\.local\/instagram\/.+\.jpg$/);

    // validações
    await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'carousel', media: [up.url] }).expect(400);
    await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'feed', media: ['https://outro-site.com/x.jpg'] }).expect(400);
    await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'feed', media: [up.url], scheduledAt: '2020-01-01T10:00' }).expect(400);

    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    const post = (await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'feed', media: [up.url], caption: 'Turma de NR-35 #trabalhoemaltura', scheduledAt: future }).expect(201)).body;
    expect(post).toMatchObject({ status: 'scheduled', kind: 'feed' });
    // ainda não venceu: a tarefa não mexe
    expect(await instagram.runDue()).toEqual({ started: 0, checked: 0 });

    await db.ai_SocialPost.update({ where: { id: post.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    const calls = metaPublica();
    await instagram.runDue();
    const done = await db.ai_SocialPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(done).toMatchObject({ status: 'published', externalId: '9001', permalink: 'https://www.instagram.com/p/abc/', attempts: 1 });
    expect(calls[0]).toMatchObject({ caption: 'Turma de NR-35 #trabalhoemaltura', access_token: 'chave-longa' });
    expect(calls[0].image_url).toMatch(/\.jpg$/);

    // story: publicar agora, sem legenda, em 9:16
    const story = (await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'story', media: [up.url], caption: 'ignorada' }).expect(201)).body;
    expect(story.caption).toBe('');
    const storyCalls = metaPublica({ kind: 'story' });
    const spy = jest.spyOn(instagram, 'toJpeg');
    const published = (await api().post(`/ai/instagram/posts/${story.id}/publish`).set(auth(company.id)).expect(200)).body;
    expect(published.status).toBe('published');
    expect(storyCalls[0]).toMatchObject({ media_type: 'STORIES' });
    expect((await spy.mock.results[0].value).ratio).toBeCloseTo(9 / 16, 3);
    spy.mockRestore();

    const list = (await api().get('/ai/instagram/posts?status=published').set(auth(company.id)).expect(200)).body;
    expect(list).toHaveLength(2);
  });

  it('carrossel em fila e falha de chave expirada marcam a conexão para reconectar', async () => {
    const { company, db } = await cenario();
    await conectar(company.id);
    const urls = ['https://imagens.teste.local/a.png', 'https://imagens.teste.local/b.png', 'https://imagens.teste.local/c.png'];
    const post = (await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'carousel', media: urls, caption: 'Três fotos' }).expect(201)).body;
    const calls = metaPublica({ kind: 'carousel', images: 3 });
    await instagram.runDue();
    expect((await db.ai_SocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe('published');
    expect(calls.filter((q) => q.is_carousel_item === 'true')).toHaveLength(3);
    expect(calls[3]).toMatchObject({ media_type: 'CAROUSEL', children: 'c1,c2,c3', caption: 'Três fotos' });

    // a Meta diz que a chave caiu
    const again = (await api().post('/ai/instagram/posts').set(auth(company.id)).send({ kind: 'feed', media: [urls[0]] }).expect(201)).body;
    nock('https://imagens.teste.local').get(/.*/).reply(200, png, { 'Content-Type': 'image/png' });
    nock(IG).post('/1784/media').query(true).reply(400, { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } });
    await instagram.runDue();
    const failed = await db.ai_SocialPost.findUniqueOrThrow({ where: { id: again.id } });
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/expirou/);
    expect((await api().get('/ai/connectors').set(auth(company.id)).expect(200)).body.instagram.account.status).toBe('expired');

    // cancelar só o que está agendado
    const later = await db.ai_SocialPost.create({ data: { companyId: company.id, kind: 'feed', media: [urls[0]], scheduledAt: new Date(Date.now() + 86400000) } });
    await api().patch(`/ai/instagram/posts/${later.id}/cancel`).set(auth(company.id)).expect(200);
    await api().patch(`/ai/instagram/posts/${post.id}/cancel`).set(auth(company.id)).expect(400);
  });

  it('a Nina agenda com cartão de confirmação e quem não tem permissão não vê as ferramentas', async () => {
    const { company, db } = await cenario();
    const ctx: ToolContext = { userId, companyId: company.id, permissions: PERMS, origin: 'bots' };
    const call = async (tool: string, input: Record<string, unknown>) => {
      const out = await catalog.call(ctx, tool, input, null);
      return { ...out, data: JSON.parse(out.content) };
    };
    expect((await call('instagram_conta', {})).data).toMatchObject({ conectado: false });
    await conectar(company.id);
    expect((await call('instagram_conta', {})).data).toMatchObject({ conectado: true, conta: '@worksafebrasil', postsAgendados: 0 });

    const refused = await call('instagram_agendar_post', { tipo: 'feed', imagens: ['https://fora.com/x.jpg'] });
    expect(refused.status).toBe('refused');
    expect(refused.content).toMatch(/imagens que já estejam no WorkSafe/);

    const day = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const pending = await call('instagram_agendar_post', { tipo: 'carrossel', imagens: ['https://imagens.teste.local/a.png', 'https://imagens.teste.local/b.png'], legenda: 'Bastidores do curso', quando: `${day}T18:30` });
    expect(pending.status).toBe('pending');
    expect(await db.ai_SocialPost.count()).toBe(0);
    await api().post(`/ai/actions/${pending.pendingActionId}/confirm`).set(auth(company.id)).expect(200);
    const post = await db.ai_SocialPost.findFirstOrThrow();
    expect(post).toMatchObject({ kind: 'carousel', caption: 'Bastidores do curso', status: 'scheduled' });
    expect(post.scheduledAt.toISOString()).toBe(`${day}T21:30:00.000Z`); // 18h30 em Brasília

    const list = await call('instagram_posts', {});
    expect(list.data.posts[0]).toMatchObject({ id: post.id, tipo: 'carrossel', situacao: 'scheduled' });

    expect(catalog.visible(null, ['usar_bots']).map((tool) => tool.name)).not.toContain('instagram_agendar_post');
    expect(catalog.visible(null, ['usar_mcp', 'instagram_bots']).map((tool) => tool.name)).not.toContain('instagram_agendar_post'); // só nos bots
  });
});
