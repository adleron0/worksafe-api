import './setup/env'; // precisa ser o primeiro import
import * as request from 'supertest';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCheckoutScenario } from './setup/factories';
import { resetAsaasMock, blockRealNetwork } from './setup/asaas-mock';

/**
 * Inscrição pública sem a conta de somar: campo-isca, tempo mínimo e
 * Cloudflare Turnstile (só quando TURNSTILE_SECRET_KEY existe). Os campos de
 * controle nunca chegam ao banco e clientes antigos continuam funcionando.
 */
describe('Inscrição pública: proteção contra robôs (e2e)', () => {
  beforeAll(async () => {
    blockRealNetwork();
    await bootTestApp();
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => {
    await resetDb(); await flushCache(); resetAsaasMock();
    delete process.env.TURNSTILE_SECRET_KEY;
  });
  afterEach(() => { delete process.env.TURNSTILE_SECRET_KEY; jest.restoreAllMocks(); });

  const subscribe = (fields: Record<string, string>) => {
    const req = request(httpServer()).post('/subscription/subscribe');
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  };
  const buyer = { name: 'Maria Souza', cpf: '39053344705', email: 'maria@teste.local', phone: '81999998888' };
  const scenario = () => makeCheckoutScenario({ openClass: true, allowCheckout: false, price: null });
  const count = () => testDb().courseClassSubscription.count();
  // a API chama a Cloudflare com fetch (o nock 13 não intercepta fetch)
  const realFetch = global.fetch;
  const siteverify = (answer: { success: boolean } | Error) =>
    jest.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      if (!String(url).startsWith('https://challenges.cloudflare.com/')) return realFetch(url, init);
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    });

  it('pessoa: isca vazia e formulário aberto há mais de 3 s passa, sem gravar os campos de controle', async () => {
    const { courseClass } = await scenario();
    await subscribe({ ...buyer, classId: String(courseClass.id), website: '', formStartedAt: String(Date.now() - 20000) }).expect(201);
    expect(await count()).toBe(1);
  });

  it('cliente antigo (sem os campos novos) continua inscrevendo', async () => {
    const { courseClass } = await scenario();
    await subscribe({ ...buyer, classId: String(courseClass.id) }).expect(201);
    expect(await count()).toBe(1);
  });

  it('robô: campo-isca preenchido ou envio rápido demais é recusado', async () => {
    const { courseClass } = await scenario();
    await subscribe({ ...buyer, classId: String(courseClass.id), website: 'http://spam.example' }).expect(400);
    await subscribe({ ...buyer, classId: String(courseClass.id), formStartedAt: String(Date.now() - 500) }).expect(400);
    expect(await count()).toBe(0);
  });

  it('Turnstile desligado: human-check avisa e a inscrição não pede passe', async () => {
    const { courseClass } = await scenario();
    const res = await request(httpServer()).post('/subscription/human-check').send({ token: 'x' }).expect(201);
    expect(res.body).toEqual({ enabled: false, pass: null });
    await subscribe({ ...buyer, classId: String(courseClass.id) }).expect(201);
  });

  it('Turnstile ligado: sem passe recusa; token válido vira passe que serve para mais de um envio', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'segredo-de-teste';
    const { courseClass } = await scenario();
    await subscribe({ ...buyer, classId: String(courseClass.id) }).expect(400);
    await subscribe({ ...buyer, classId: String(courseClass.id), humanPass: '9999999999999.forjado' }).expect(400);

    siteverify({ success: false });
    await request(httpServer()).post('/subscription/human-check').send({ token: 'ruim' }).expect(400);

    siteverify({ success: true });
    const ok = await request(httpServer()).post('/subscription/human-check').send({ token: 'bom' }).expect(201);
    expect(ok.body.enabled).toBe(true);
    const pass = ok.body.pass as string;
    expect(pass).toMatch(/^\d+\.[0-9a-f]{64}$/);

    await subscribe({ ...buyer, classId: String(courseClass.id), humanPass: pass }).expect(201);
    // mesmo passe numa segunda chamada (o checkout chama de novo ao trocar o método)
    await subscribe({ ...buyer, cpf: '52998224725', classId: String(courseClass.id), humanPass: pass }).expect(201);
    expect(await count()).toBe(2);
  });

  it('Turnstile fora do ar não trava as vendas', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'segredo-de-teste';
    siteverify(new Error('timeout'));
    const res = await request(httpServer()).post('/subscription/human-check').send({ token: 'qualquer' }).expect(201);
    expect(res.body.enabled).toBe(true);
  });
});
