import './setup/env'; // precisa ser o primeiro import
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { chanceToBeBest } from 'src/features/training/landing/landing.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCheckoutScenario, makeSeller } from './setup/factories';
import { mockCheckout, resetAsaasMock, blockRealNetwork } from './setup/asaas-mock';

/**
 * Página da turma com teste A/B: eventos públicos, origem gravada na
 * inscrição e resultado por layout. A inscrição e o checkout continuam iguais
 * (o contrato do checkout tem o seu próprio teste).
 */
describe('Página da turma: teste A/B (e2e)', () => {
  let jwt: JwtService;
  const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, userId: number, permissions = ['list_classes', 'update_classes', 'view_classes']) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };

  const events = (body: Record<string, unknown>, ua = BROWSER) =>
    request(httpServer()).post('/landing/events').set('user-agent', ua).send(body);

  function subscribeAsSite(fields: Record<string, string>) {
    const req = request(httpServer()).post('/subscription/subscribe');
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  }
  const buyer = { name: 'Maria Souza', cpf: '39053344705', email: 'maria@teste.local', phone: '81999998888' };

  it('grava eventos válidos e descarta os desconhecidos', async () => {
    const { courseClass } = await makeCheckoutScenario({ openClass: true });
    const res = await events({
      classId: courseClass.id, visitorId: 'v-12345678', layout: 'impacto', source: 'instagram', device: 'mobile',
      events: [{ event: 'view' }, { event: 'block', block: 'galeria' }, { event: 'hack' }, { event: 'block', block: 'DROP TABLE' }],
    }).expect(200);
    expect(res.body).toEqual({ recorded: 2 });
    const rows = await testDb().courseClass_LandingEvent.findMany({ orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.event, r.block, r.layout, r.source, r.device, r.companyId])).toEqual([
      ['view', null, 'impacto', 'instagram', 'mobile', courseClass.companyId],
      ['block', 'galeria', 'impacto', 'instagram', 'mobile', courseClass.companyId],
    ]);
  });

  it('recusa layout ou visitante inválidos, ignora robôs e turma fora da vitrine', async () => {
    const { courseClass } = await makeCheckoutScenario({ openClass: true });
    await events({ classId: courseClass.id, visitorId: 'v-12345678', layout: 'outro', events: [{ event: 'view' }] }).expect(400);
    await events({ classId: courseClass.id, visitorId: 'x', layout: 'impacto', events: [{ event: 'view' }] }).expect(400);
    const bot = await events({ classId: courseClass.id, visitorId: 'v-12345678', layout: 'impacto', events: [{ event: 'view' }] }, 'facebookexternalhit/1.1').expect(200);
    expect(bot.body.recorded).toBe(0);
    const closed = await makeCheckoutScenario({ openClass: false });
    await events({ classId: closed.courseClass.id, visitorId: 'v-12345678', layout: 'impacto', events: [{ event: 'view' }] }).expect(404);
    expect(await testDb().courseClass_LandingEvent.count()).toBe(0);
  });

  it('inscrição sem checkout guarda layout e origem, e o resto segue igual', async () => {
    const { courseClass } = await makeCheckoutScenario({ openClass: true, allowCheckout: false, price: null });
    const res = await subscribeAsSite({
      ...buyer, classId: String(courseClass.id),
      landingLayout: 'direto', landingVisitor: 'v-abcdefgh', landingOption: 'N2',
      utmSource: 'instagram', utmMedium: 'social', utmCampaign: 'turma-nov', referrer: 'https://l.instagram.com/',
    }).expect(201);
    expect(res.body.subscribeStatus).toBe('pending');
    const sub = await testDb().courseClassSubscription.findFirstOrThrow({ where: { cpf: buyer.cpf } });
    expect(sub).toMatchObject({
      subscribeStatus: 'pending', landingLayout: 'direto', landingVisitor: 'v-abcdefgh', landingOption: 'N2',
      utmSource: 'instagram', utmMedium: 'social', utmCampaign: 'turma-nov', referrer: 'https://l.instagram.com/',
    });
  });

  it('inscrição com PIX também guarda o layout, sem mudar o pagamento', async () => {
    const { courseClass } = await makeCheckoutScenario({ openClass: true });
    mockCheckout({ billingType: 'PIX', value: 500 });
    const res = await subscribeAsSite({
      ...buyer, address: 'Rua Teste', addressNumber: '100', neighborhood: 'Centro', city: 'Recife', state: 'PE', zipCode: '50000000',
      classId: String(courseClass.id), paymentMethod: 'pix', landingLayout: 'impacto', landingVisitor: 'v-abcdefgh',
    }).expect(201);
    expect(res.body.financialRecord).toMatchObject({ status: 'waiting', paymentMethod: 'pix' });
    const sub = await testDb().courseClassSubscription.findFirstOrThrow({ where: { cpf: buyer.cpf } });
    expect(sub.landingLayout).toBe('impacto');
  });

  it('valores de origem inválidos viram nulo e não impedem a inscrição', async () => {
    const { courseClass } = await makeCheckoutScenario({ openClass: true, allowCheckout: false });
    await subscribeAsSite({ ...buyer, classId: String(courseClass.id), landingLayout: '<script>', landingVisitor: '!!' }).expect(201);
    const sub = await testDb().courseClassSubscription.findFirstOrThrow({ where: { cpf: buyer.cpf } });
    expect(sub.landingLayout).toBeNull();
    expect(sub.landingVisitor).toBeNull();
  });

  it('resultado por layout: funil, inscrições, origem e chance de ser o melhor', async () => {
    const { company, courseClass } = await makeCheckoutScenario({ openClass: true, allowCheckout: false, landingAbTest: true, landingAbLayouts: ['classico', 'impacto'] });
    const user = await makeSeller(company.id);
    for (let i = 0; i < 10; i++) {
      await events({ classId: courseClass.id, visitorId: `visitante-a${i}`, layout: 'classico', source: 'instagram', events: [{ event: 'view' }, ...(i < 1 ? [{ event: 'submit' }] : [])] });
      await events({ classId: courseClass.id, visitorId: `visitante-b${i}`, layout: 'impacto', source: i % 2 ? 'google' : 'instagram', device: 'mobile', events: [{ event: 'view' }, { event: 'cta_click' }, ...(i < 4 ? [{ event: 'submit' }] : [])] });
    }
    // a mesma pessoa abrindo no celular e no computador conta uma vez na origem
    await events({ classId: courseClass.id, visitorId: 'visitante-a0', layout: 'classico', source: 'instagram', device: 'desktop', events: [{ event: 'view' }] });
    await subscribeAsSite({ ...buyer, classId: String(courseClass.id), landingLayout: 'impacto', landingVisitor: 'visitante-b0' }).expect(201);
    await testDb().courseClassSubscription.updateMany({ where: { cpf: buyer.cpf }, data: { subscribeStatus: 'confirmed' } });

    const res = await request(httpServer()).get(`/landing/results/${courseClass.id}`).set(auth(company.id, user.id)).expect(200);
    const byLayout = Object.fromEntries(res.body.layouts.map((l: any) => [l.layout, l]));
    expect(res.body.config).toEqual({ layout: 'classico', abTest: true, abLayouts: ['classico', 'impacto'] });
    expect(byLayout.classico).toMatchObject({ visitors: 10, submits: 1, subscriptions: 0, enoughData: false });
    expect(byLayout.impacto).toMatchObject({ visitors: 10, ctaClicks: 10, submits: 4, subscriptions: 1, confirmed: 1 });
    expect(byLayout.impacto.chanceToBeBest).toBeGreaterThan(byLayout.classico.chanceToBeBest);
    expect(res.body.bySource.find((s: any) => s.layout === 'impacto' && s.key === 'google')).toMatchObject({ visitors: 5 });
    expect(res.body.bySource.find((s: any) => s.layout === 'classico' && s.key === 'instagram')).toMatchObject({ visitors: 10, submits: 1 });
    expect(res.body.byDevice.filter((s: any) => s.layout === 'classico').map((s: any) => [s.key, s.visitors]).sort()).toEqual([['?', 10], ['desktop', 1]]);

    // outra empresa não vê
    const other = await makeCheckoutScenario();
    const otherUser = await makeSeller(other.company.id);
    await request(httpServer()).get(`/landing/results/${courseClass.id}`).set(auth(other.company.id, otherUser.id)).expect(404);
    // sem permissão
    await request(httpServer()).get(`/landing/results/${courseClass.id}`).set(auth(company.id, user.id, ['list_financeiro'])).expect(403);
  });

  it('turma salva conteúdo, layout e teste A/B saneados', async () => {
    const { company, courseClass } = await makeCheckoutScenario();
    const user = await makeSeller(company.id);
    await request(httpServer())
      .put(`/classes/${courseClass.id}`)
      .set(auth(company.id, user.id, ['update_classes', 'list_classes']))
      .field('landingLayout', 'narrativa')
      .field('landingAbTest', 'true')
      .field('landingAbLayouts', JSON.stringify(['classico', 'direto', 'invalido', 'direto']))
      .field('landingContent', JSON.stringify({ version: 1, hero: { title: 'Trabalhe onde poucos chegam' } }))
      .expect(200);
    const saved = await testDb().courseClass.findUniqueOrThrow({ where: { id: courseClass.id } });
    expect(saved.landingLayout).toBe('narrativa');
    expect(saved.landingAbTest).toBe(true);
    expect(saved.landingAbLayouts).toEqual(['classico', 'direto']);
    expect(saved.landingContent).toEqual({ version: 1, hero: { title: 'Trabalhe onde poucos chegam' } });
  });

  it('chance de ser o melhor: dados iguais dividem, diferença grande decide', () => {
    const even = chanceToBeBest([{ layout: 'a', visitors: 100, submits: 10 }, { layout: 'b', visitors: 100, submits: 10 }]);
    expect(even.a).toBeGreaterThan(0.4);
    expect(even.a).toBeLessThan(0.6);
    const clear = chanceToBeBest([{ layout: 'a', visitors: 500, submits: 10 }, { layout: 'b', visitors: 500, submits: 50 }]);
    expect(clear.b).toBeGreaterThan(0.99);
  });
});
