import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import { getStorageToken } from '@nestjs/throttler';
import * as request from 'supertest';
import { hash } from 'bcrypt';
import { encryptPayload } from 'src/utils/crypto';
import { GoogleIdentity, GoogleOidcService } from 'src/auth/google/google-oidc.service';
import { AccessAdminService } from 'src/auth/google/access-admin.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Login com Google. O que não pode passar de jeito nenhum:
 * - conta de fora do domínio sem convite; convite vencido, revogado ou preso a
 *   outra conta Google; e-mail não verificado; `hd` de outra empresa;
 * - state reaproveitado, de outro navegador, nonce trocado, ticket reaproveitado;
 * - token de pendente abrindo qualquer rota do sistema;
 * - e-mail do domínio entrando por senha;
 * - quem aprova dando perfil super ou perfil com permissões que não tem.
 */
describe('Login com Google (e2e)', () => {
  let jwt: JwtService;
  let oidc: GoogleOidcService;
  let next: Partial<GoogleIdentity> | Error;
  let throttle: { storage: Map<string, unknown>; onApplicationShutdown: () => void };

  beforeAll(async () => {
    blockRealNetwork();
    process.env.GOOGLE_AUTH_CLIENT_ID = 'client-teste';
    process.env.GOOGLE_AUTH_CLIENT_SECRET = 'segredo-teste';
    process.env.GOOGLE_AUTH_REDIRECT_URI = 'https://api.test.local/auth/google/callback';
    process.env.GOOGLE_AUTH_FRONT_URL = 'https://sistema.test.local';
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    oidc = app.get(GoogleOidcService);
    throttle = app.get(getStorageToken());
    // a rede do Google sai: a troca do code devolve a identidade que o teste escolher,
    // com o nonce que o próprio fluxo guardou (a menos que o teste o troque)
    jest.spyOn(oidc, 'exchangeAndVerify').mockImplementation(async () => {
      if (next instanceof Error) throw next;
      return { emailVerified: true, nonce: lastNonce, ...next } as GoogleIdentity;
    });
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  // o limite por IP (20/min no login Google) vale entre testes: zera a cada um
  beforeEach(async () => { await resetDb(); await flushCache(); throttle.onApplicationShutdown(); throttle.storage.clear(); resetAsaasMock(); next = {}; });

  const api = () => request(httpServer());
  let lastNonce = '';

  const DOMAIN = 'worksafebrasil.com.br';
  async function cenario(opts: { enabled?: boolean } = {}) {
    const db = testDb();
    const company = await makeCompany({ google_domain: DOMAIN, google_login_enabled: opts.enabled ?? true });
    const catalog = ['aprovar_acesso_user', 'convidar_externo_user', 'list_user', 'update_company', 'usar_bots'];
    await db.permission.createMany({ data: catalog.map((name) => ({ name, group: 'user' })) });
    const perms = Object.fromEntries((await db.permission.findMany()).map((p) => [p.name, p.id]));
    const admin = await db.profile.create({ data: { name: 'admin', companyId: company.id } });
    const operacao = await db.profile.create({ data: { name: 'Operação', companyId: company.id } });
    const diretoria = await db.profile.create({ data: { name: 'Diretoria', companyId: company.id } });
    const superP = await db.profile.create({ data: { name: 'super', companyId: company.id } });
    await db.profilePermission.createMany({
      data: [
        { profileId: operacao.id, permissionId: perms.list_user },
        { profileId: diretoria.id, permissionId: perms.usar_bots },
      ],
    });
    const approver = await db.user.create({
      data: { name: 'Gestor', email: `gestor@${DOMAIN}`, password: 'x', phone: '', cpf: '', companyId: company.id, profileId: admin.id },
    });
    return { db, company, perms, admin, operacao, diretoria, superP, approver };
  }

  const auth = (companyId: number, sub: number, permissions: string[], profile = 'admin') => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub, companyId, permissions, profile }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const APPROVER = ['aprovar_acesso_user', 'convidar_externo_user', 'list_user', 'update_company'];

  /** Começa o login: devolve state + cookie do navegador. */
  async function start() {
    const res = await api().get('/auth/google/start').expect(302);
    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    lastNonce = url.searchParams.get('nonce')!;
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ws_g_bind='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    return { state: url.searchParams.get('state')!, cookie: cookie.split(';')[0] };
  }

  /** Volta do Google; devolve o fragmento do redirecionamento (#gt= ou #ge=). */
  async function callback(state: string, cookie?: string) {
    const r = api().get(`/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    if (cookie) r.set('Cookie', cookie);
    const res = await r.expect(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin).toBe('https://sistema.test.local');
    expect(loc.search).toBe(''); // nada na query: só no fragmento
    return Object.fromEntries(new URLSearchParams(loc.hash.slice(1)));
  }

  async function fullLogin(identity: Partial<GoogleIdentity>) {
    next = identity;
    const { state, cookie } = await start();
    const frag = await callback(state, cookie);
    if (!frag.gt) return { error: frag.ge };
    const res = await api().post('/auth/google/exchange').set('Cookie', cookie).send({ ticket: frag.gt });
    return { res, cookie, ticket: frag.gt };
  }

  const domainId = (over: Partial<GoogleIdentity> = {}) => ({
    sub: 'g-111', email: `ana@${DOMAIN}`, hd: DOMAIN, name: 'Ana Souza', ...over,
  });

  it('botão só aparece com Google configurado e ligado em alguma empresa', async () => {
    await cenario({ enabled: false });
    expect((await api().get('/auth/google/enabled').expect(200)).body).toEqual({ enabled: false });
    await testDb().company.updateMany({ data: { google_login_enabled: true } });
    expect((await api().get('/auth/google/enabled').expect(200)).body).toEqual({ enabled: true });
    // start com tudo desligado volta para a tela com erro
    await testDb().company.updateMany({ data: { google_login_enabled: false } });
    const res = await api().get('/auth/google/start').expect(302);
    expect(res.headers.location).toBe('https://sistema.test.local/#ge=desligado');
  });

  it('usuário da casa com perfil entra; sessão de 12 h e vínculo pelo sub', async () => {
    const { db, company, operacao } = await cenario();
    await db.user.create({
      data: { name: 'Ana', email: `Ana@${DOMAIN}`, password: 'x', phone: '', cpf: '', companyId: company.id, profileId: operacao.id },
    });
    const { res } = await fullLogin(domainId());
    expect(res!.status).toBe(201);
    expect(res!.body.status).toBe('ok');
    expect(res!.body.accessToken).toBeTruthy();
    const refresh = (res!.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refreshToken='))!;
    expect(refresh).toMatch(/Max-Age=43200/);
    const user = await db.user.findFirst({ where: { email: `Ana@${DOMAIN}` } });
    expect(user!.googleSub).toBe('g-111');
    const session = await db.session.findFirst({ where: { userId: user!.id } });
    expect(session!.expires.getTime() - Date.now()).toBeLessThan(12 * 3600 * 1000 + 60000);
    expect(await db.system_Logs.count({ where: { action: 'login_google', userId: user!.id } })).toBe(1);
  });

  it('usuário novo do domínio fica pendente: token de pendente não abre o sistema', async () => {
    const { db, company } = await cenario();
    const { res } = await fullLogin(domainId({ sub: 'g-novo', email: `novo@${DOMAIN}`, name: 'Novo' }));
    expect(res!.body.status).toBe('pending');
    expect(res!.body.accessToken).toBeUndefined();
    const created = await db.user.findFirst({ where: { email: `novo@${DOMAIN}` } });
    expect(created!.profileId).toBeNull();
    expect(created!.companyId).toBe(company.id);
    // senha inutilizável
    expect(created!.password.startsWith('$2')).toBe(true);

    const pending = { Authorization: `Bearer ${res!.body.pendingToken}` };
    // o AuthGuard normal recusa
    await api().get('/user').set(pending).expect(401);
    await api().get('/access-requests').set(pending).expect(401);
    // e o access token normal não abre a tela de pendente
    await api().get('/auth/access-request/me').set(auth(company.id, created!.id, APPROVER)).expect(401);

    const me = await api().get('/auth/access-request/me').set(pending).expect(200);
    expect(me.body).toMatchObject({ approved: false, request: null, user: { email: `novo@${DOMAIN}` } });
    await api().post('/auth/access-request').set(pending).send({ message: 'Sou do comercial' }).expect(201);
    // pedir de novo não duplica
    await api().post('/auth/access-request').set(pending).send({}).expect(201);
    expect(await db.accessRequest.count()).toBe(1);
    // ainda sem perfil: "entrar" devolve pendente de novo
    expect((await api().post('/auth/access-request/enter').set(pending).expect(201)).body.status).toBe('pending');
  });

  it('aprovação: perfil comum sim; super e perfil com permissão que o aprovador não tem, não', async () => {
    const { db, company, approver, operacao, diretoria, superP } = await cenario();
    const { res } = await fullLogin(domainId({ sub: 'g-2', email: `bia@${DOMAIN}` }));
    const pending = { Authorization: `Bearer ${res!.body.pendingToken}` };
    await api().post('/auth/access-request').set(pending).send({ message: 'oi' }).expect(201);
    const reqRow = await db.accessRequest.findFirstOrThrow();
    const h = auth(company.id, approver.id, APPROVER);

    expect((await api().get('/access-requests/count').set(h).expect(200)).body).toEqual({ pending: 1 });
    // sem a permissão
    await api().get('/access-requests').set(auth(company.id, approver.id, ['list_user'])).expect(403);
    // super nunca
    await api().post(`/access-requests/${reqRow.id}/approve`).set(h).send({ profileId: superP.id }).expect(403);
    // perfil com usar_bots, que o aprovador não tem
    await api().post(`/access-requests/${reqRow.id}/approve`).set(h).send({ profileId: diretoria.id }).expect(403);
    // perfil de outra empresa
    const other = await makeCompany();
    const foreign = await db.profile.create({ data: { name: 'Fora', companyId: other.id } });
    await api().post(`/access-requests/${reqRow.id}/approve`).set(h).send({ profileId: foreign.id }).expect(400);
    // pedido de outra empresa não aparece nem é aprovável
    await api().post(`/access-requests/${reqRow.id}/approve`).set(auth(other.id, approver.id, APPROVER)).send({ profileId: operacao.id }).expect(404);

    await api().post(`/access-requests/${reqRow.id}/approve`).set(h).send({ profileId: operacao.id }).expect(201);
    await api().post(`/access-requests/${reqRow.id}/approve`).set(h).send({ profileId: operacao.id }).expect(409);
    expect((await db.user.findFirstOrThrow({ where: { email: `bia@${DOMAIN}` } })).profileId).toBe(operacao.id);

    // o pendente agora entra direto, sem outro login no Google
    const enter = await api().post('/auth/access-request/enter').set(pending).expect(201);
    expect(enter.body.status).toBe('ok');
    expect(enter.body.accessToken).toBeTruthy();
  });

  it('recusar pedido', async () => {
    const { db, company, approver } = await cenario();
    const { res } = await fullLogin(domainId({ sub: 'g-3', email: `caio@${DOMAIN}` }));
    const pending = { Authorization: `Bearer ${res!.body.pendingToken}` };
    await api().post('/auth/access-request').set(pending).send({}).expect(201);
    const reqRow = await db.accessRequest.findFirstOrThrow();
    await api().post(`/access-requests/${reqRow.id}/reject`).set(auth(company.id, approver.id, APPROVER)).send({ reason: 'não é da equipe' }).expect(201);
    const me = await api().get('/auth/access-request/me').set(pending).expect(200);
    expect(me.body.request).toMatchObject({ status: 'rejected', reason: 'não é da equipe' });
  });

  it('recusas: sem convite, e-mail não verificado, inativo, hd de outra empresa, e-mail fora do hd', async () => {
    const { db, company, operacao } = await cenario();
    expect((await fullLogin({ sub: 'g-x', email: 'alguem@gmail.com' })).error).toBe('sem_convite');
    expect((await fullLogin(domainId({ emailVerified: false }))).error).toBe('email_nao_verificado');
    expect((await fullLogin({ sub: 'g-y', email: `fulano@outra.com.br`, hd: 'outra.com.br' })).error).toBe('sem_convite');
    // hd da empresa mas e-mail de outro domínio (não deveria existir; recusa)
    expect((await fullLogin(domainId({ email: 'ana@gmail.com' }))).error).toBe('dominio_invalido');
    // e-mail do domínio mas sem hd (conta pessoal criada com esse e-mail): não é da casa
    expect((await fullLogin({ sub: 'g-z', email: `ana@${DOMAIN}` })).error).toBe('sem_convite');

    // 5 recusas seguidas já põem o IP em espera (muitas_tentativas): zera para seguir
    expect((await fullLogin({ sub: 'g-w', email: 'w@gmail.com' })).error).toBe('muitas_tentativas');
    await flushCache();
    await db.user.create({
      data: { name: 'Ex', email: `ex@${DOMAIN}`, password: 'x', phone: '', cpf: '', companyId: company.id, profileId: operacao.id, active: false, inactiveAt: new Date() },
    });
    expect((await fullLogin(domainId({ sub: 'g-ex', email: `ex@${DOMAIN}` }))).error).toBe('usuario_inativo');
    // nenhuma recusa criou usuário
    expect(await db.user.count({ where: { email: { in: ['alguem@gmail.com', 'fulano@outra.com.br', 'ana@gmail.com'] } } })).toBe(0);
  });

  it('conta já vinculada a outro sub não é tomada por outra conta Google com o mesmo e-mail', async () => {
    const { db, company, operacao } = await cenario();
    await db.user.create({
      data: { name: 'Ana', email: `ana@${DOMAIN}`, password: 'x', phone: '', cpf: '', companyId: company.id, profileId: operacao.id, googleSub: 'g-original' },
    });
    expect((await fullLogin(domainId({ sub: 'g-impostor' }))).error).toBe('conta_vinculada');
  });

  it('state: uso único, mesmo navegador; nonce trocado e falha no Google recusam', async () => {
    await cenario();
    next = domainId();
    const { state, cookie } = await start();
    // sem o cookie do navegador que começou (CSRF de login)
    expect((await callback(state)).ge).toBe('navegador_diferente');
    // o state foi consumido mesmo na recusa
    expect((await callback(state, cookie)).ge).toBe('estado_invalido');
    // state inventado
    expect((await callback('inventado', cookie)).ge).toBe('estado_invalido');

    const s2 = await start();
    next = { ...domainId(), nonce: 'outro' };
    expect((await callback(s2.state, s2.cookie)).ge).toBe('google_falhou');

    const s3 = await start();
    next = new Error('invalid_grant');
    expect((await callback(s3.state, s3.cookie)).ge).toBe('google_falhou');

    // usuário cancelou no Google
    const res = await api().get('/auth/google/callback?error=access_denied').expect(302);
    expect(res.headers.location).toBe('https://sistema.test.local/#ge=cancelado');
  });

  it('ticket: uso único e só no mesmo navegador', async () => {
    const { db, company, operacao } = await cenario();
    await db.user.create({
      data: { name: 'Ana', email: `ana@${DOMAIN}`, password: 'x', phone: '', cpf: '', companyId: company.id, profileId: operacao.id },
    });
    next = domainId();
    const { state, cookie } = await start();
    const { gt } = await callback(state, cookie);
    // outro navegador (sem cookie) não troca, e o ticket morre
    await api().post('/auth/google/exchange').send({ ticket: gt }).expect(401);
    await api().post('/auth/google/exchange').set('Cookie', cookie).send({ ticket: gt }).expect(401);

    const s2 = await start();
    const f2 = await callback(s2.state, s2.cookie);
    await api().post('/auth/google/exchange').set('Cookie', s2.cookie).send({ ticket: f2.gt }).expect(201);
    await api().post('/auth/google/exchange').set('Cookie', s2.cookie).send({ ticket: f2.gt }).expect(401);
  });

  it('e-mail do domínio não entra mais por senha; e-mail de fora continua', async () => {
    const { db, company, operacao } = await cenario();
    const pass = await hash('SenhaForte123', 10);
    await db.user.create({ data: { name: 'Ana', email: `ana@${DOMAIN}`, password: pass, phone: '', cpf: '', companyId: company.id, profileId: operacao.id } });
    await db.user.create({ data: { name: 'Emergência', email: 'emergencia@gmail.com', password: pass, phone: '', cpf: '', companyId: company.id, profileId: operacao.id } });
    const res = await api().post('/auth/login').send({ email: `ana@${DOMAIN}`, password: 'SenhaForte123', cnpj: company.cnpj }).expect(403);
    expect(res.body.message).toContain('Google');
    // mesmo com maiúsculas no e-mail
    await api().post('/auth/login').send({ email: `ANA@${DOMAIN.toUpperCase()}`, password: 'SenhaForte123', cnpj: company.cnpj }).expect(403);
    await api().post('/auth/login').send({ email: 'emergencia@gmail.com', password: 'SenhaForte123', cnpj: company.cnpj }).expect(201);
    // com o Google desligado, a senha volta a valer
    await db.company.update({ where: { id: company.id }, data: { google_login_enabled: false } });
    await api().post('/auth/login').send({ email: `ana@${DOMAIN}`, password: 'SenhaForte123', cnpj: company.cnpj }).expect(201);
  });

  describe('convidados externos', () => {
    const guest = (over: Partial<GoogleIdentity> = {}) => ({ sub: 'g-guest', email: 'consultor@gmail.com', name: 'Consultor', ...over });

    it('convidado entra com o perfil do convite; outra conta com o mesmo e-mail não', async () => {
      const { db, company, approver, operacao } = await cenario();
      const h = auth(company.id, approver.id, APPROVER);
      // e-mail do domínio não precisa de convite
      await api().post('/external-invites').set(h).send({ email: `x@${DOMAIN}`, profileId: operacao.id, days: 30 }).expect(400);
      await api().post('/external-invites').set(h).send({ email: 'consultor@gmail.com', profileId: operacao.id, days: 181 }).expect(400);
      await api().post('/external-invites').set(h).send({ email: ' Consultor@Gmail.com ', profileId: operacao.id, days: 30, reason: 'auditoria' }).expect(201);
      await api().post('/external-invites').set(h).send({ email: 'consultor@gmail.com', profileId: operacao.id, days: 30 }).expect(409);

      const { res } = await fullLogin(guest());
      expect(res!.body.status).toBe('ok');
      const user = await db.user.findFirstOrThrow({ where: { email: 'consultor@gmail.com' } });
      expect(user.profileId).toBe(operacao.id);
      expect(user.externalUntil).toBeTruthy();
      const inv = await db.externalInvite.findFirstOrThrow();
      expect(inv.googleSub).toBe('g-guest');
      expect(inv.userId).toBe(user.id);

      // outra conta Google que alegue o mesmo e-mail
      expect((await fullLogin(guest({ sub: 'g-outro' }))).error).toBe('conta_vinculada');

      const list = await api().get('/external-invites').set(h).expect(200);
      expect(list.body[0]).toMatchObject({ email: 'consultor@gmail.com', situation: 'active', linked: true, profileName: 'Operação' });
      expect(list.body[0].googleSub).toBeUndefined();
    });

    it('vencido não entra e perde o refresh; renovar devolve o acesso', async () => {
      const { db, company, approver, operacao } = await cenario();
      const h = auth(company.id, approver.id, APPROVER);
      await api().post('/external-invites').set(h).send({ email: 'consultor@gmail.com', profileId: operacao.id, days: 10 }).expect(201);
      const { res } = await fullLogin(guest());
      const refresh = (res!.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refreshToken='))!.split(';')[0];
      await api().post('/auth/refresh-token').set('Cookie', refresh).send({}).expect(201);

      const past = new Date(Date.now() - 1000);
      await db.externalInvite.updateMany({ data: { expiresAt: past } });
      await db.user.updateMany({ where: { email: 'consultor@gmail.com' }, data: { externalUntil: past } });
      await flushCache();
      await api().post('/auth/refresh-token').set('Cookie', refresh).send({}).expect(401);
      expect((await fullLogin(guest())).error).toBe('convite_vencido');

      const inv = await db.externalInvite.findFirstOrThrow();
      await api().post(`/external-invites/${inv.id}/renew`).set(h).send({ days: 30 }).expect(201);
      expect((await fullLogin(guest())).res!.body.status).toBe('ok');
    });

    it('revogar derruba sessões e bloqueia novas entradas', async () => {
      const { db, company, approver, operacao } = await cenario();
      const h = auth(company.id, approver.id, APPROVER);
      await api().post('/external-invites').set(h).send({ email: 'consultor@gmail.com', profileId: operacao.id, days: 30 }).expect(201);
      const { res } = await fullLogin(guest());
      const refresh = (res!.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refreshToken='))!.split(';')[0];
      const inv = await db.externalInvite.findFirstOrThrow();
      await api().post(`/external-invites/${inv.id}/revoke`).set(h).expect(201);
      await api().post('/auth/refresh-token').set('Cookie', refresh).send({}).expect(401);
      expect((await fullLogin(guest())).error).toBe('sem_convite');
      expect((await db.user.findFirstOrThrow({ where: { email: 'consultor@gmail.com' } })).active).toBe(false);
    });

    it('convidado não pede perfil, e convite de super não existe', async () => {
      const { company, approver, superP, diretoria } = await cenario();
      const h = auth(company.id, approver.id, APPROVER);
      await api().post('/external-invites').set(h).send({ email: 'a@gmail.com', profileId: superP.id, days: 5 }).expect(403);
      await api().post('/external-invites').set(h).send({ email: 'a@gmail.com', profileId: diretoria.id, days: 5 }).expect(403);
      // super pode convidar com perfil que tenha qualquer permissão (menos super)
      await api().post('/external-invites').set(auth(company.id, approver.id, [...APPROVER], 'super')).send({ email: 'a@gmail.com', profileId: diretoria.id, days: 5 }).expect(201);
    });

    it('aviso de vencimento marca os convites a vencer', async () => {
      const { db, company, approver, operacao } = await cenario();
      await db.externalInvite.create({
        data: { companyId: company.id, email: 'a@gmail.com', profileId: operacao.id, invitedById: approver.id, expiresAt: new Date(Date.now() + 2 * 86400000) },
      });
      await db.externalInvite.create({
        data: { companyId: company.id, email: 'b@gmail.com', profileId: operacao.id, invitedById: approver.id, expiresAt: new Date(Date.now() + 40 * 86400000) },
      });
      const app = await bootTestApp();
      expect(await app.get(AccessAdminService).warnExpiring()).toEqual({ warned: 1 });
      expect(await app.get(AccessAdminService).warnExpiring()).toEqual({ warned: 0 });
    });
  });

  describe('configuração', () => {
    it('só quem altera a empresa; domínio válido; não liga sem domínio; vitrine não mostra', async () => {
      const { company, approver } = await cenario({ enabled: false });
      const h = auth(company.id, approver.id, APPROVER);
      await api().get('/access-settings').set(auth(company.id, approver.id, ['list_user'])).expect(403);
      expect((await api().get('/access-settings').set(h).expect(200)).body).toEqual({
        googleDomain: DOMAIN, googleLoginEnabled: false, googleConfigured: true,
      });
      await api().put('/access-settings').set(h).send({ googleDomain: 'não é domínio', googleLoginEnabled: false }).expect(400);
      await api().put('/access-settings').set(h).send({ googleDomain: '', googleLoginEnabled: true }).expect(400);
      const ok = await api().put('/access-settings').set(h).send({ googleDomain: '@WorkSafeBrasil.com.br', googleLoginEnabled: true }).expect(200);
      expect(ok.body).toMatchObject({ googleDomain: DOMAIN, googleLoginEnabled: true });
      // outra empresa não pega o mesmo domínio
      const other = await makeCompany();
      await api().put('/access-settings').set(auth(other.id, approver.id, APPROVER)).send({ googleDomain: DOMAIN, googleLoginEnabled: false }).expect(409);
      // o CRUD da empresa não altera esses campos
      await api().put(`/companies/${company.id}`).set(h).send({ google_domain: 'hacker.com', google_login_enabled: false, comercial_name: 'Nome Novo' }).expect(200);
      const row = await testDb().company.findUniqueOrThrow({ where: { id: company.id } });
      expect(row.google_domain).toBe(DOMAIN);
      expect(row.google_login_enabled).toBe(true);
    });

    it('não liga com o Google sem chaves no servidor', async () => {
      const { company, approver } = await cenario({ enabled: false });
      const saved = process.env.GOOGLE_AUTH_CLIENT_SECRET;
      delete process.env.GOOGLE_AUTH_CLIENT_SECRET;
      try {
        await api().put('/access-settings').set(auth(company.id, approver.id, APPROVER)).send({ googleDomain: DOMAIN, googleLoginEnabled: true }).expect(400);
      } finally {
        process.env.GOOGLE_AUTH_CLIENT_SECRET = saved;
      }
    });
  });

  describe('achados da revisão', () => {
    it('quem entra pelo Google não troca e-mail nem senha pelo "meu perfil", e não entra por senha', async () => {
      const { db, company, operacao } = await cenario();
      const pass = await hash('SenhaForte123', 10);
      const ana = await db.user.create({
        data: { name: 'Ana', email: `ana@${DOMAIN}`, password: pass, phone: '', cpf: '', companyId: company.id, profileId: operacao.id, googleSub: 'g-111' },
      });
      const self = auth(company.id, ana.id, ['list_user'], 'Operação');
      await api().put('/user/self').set(self).send({ email: 'ana.pessoal@gmail.com' }).expect(403);
      await api().put('/user/self').set(self).send({ password: 'OutraSenha123' }).expect(403);
      // nome continua livre
      await api().put('/user/self').set(self).send({ name: 'Ana Souza' }).expect(200);
      // mesmo que o e-mail já fosse outro (trocado no banco), o vínculo com o Google barra a senha
      await db.user.update({ where: { id: ana.id }, data: { email: 'ana.pessoal@gmail.com' } });
      await api().post('/auth/login').send({ email: 'ana.pessoal@gmail.com', password: 'SenhaForte123', cnpj: company.cnpj }).expect(403);
    });

    it('convidado não entra por senha nem cria senha', async () => {
      const { db, company, approver, operacao } = await cenario();
      await api().post('/external-invites').set(auth(company.id, approver.id, APPROVER)).send({ email: 'consultor@gmail.com', profileId: operacao.id, days: 30 }).expect(201);
      await fullLogin({ sub: 'g-guest', email: 'consultor@gmail.com' });
      const guest = await db.user.findFirstOrThrow({ where: { email: 'consultor@gmail.com' } });
      await api().put('/user/self').set(auth(company.id, guest.id, ['list_user'], 'Operação')).send({ password: 'SenhaForte123' }).expect(403);
      await db.user.update({ where: { id: guest.id }, data: { password: await hash('SenhaForte123', 10) } });
      await api().post('/auth/login').send({ email: 'consultor@gmail.com', password: 'SenhaForte123', cnpj: company.cnpj }).expect(403);
    });

    it('convite não reaproveita conta existente (ex.: a de emergência)', async () => {
      const { db, company, approver, operacao, superP } = await cenario();
      await db.user.create({ data: { name: 'Emergência', email: 'emergencia@gmail.com', password: 'x', phone: '', cpf: '', companyId: company.id, profileId: superP.id } });
      await api().post('/external-invites').set(auth(company.id, approver.id, APPROVER)).send({ email: 'emergencia@gmail.com', profileId: operacao.id, days: 30 }).expect(409);
      // convite criado antes de a conta existir: no login, recusa em vez de assumir a conta
      await db.externalInvite.create({ data: { companyId: company.id, email: 'outro@gmail.com', profileId: operacao.id, invitedById: approver.id, expiresAt: new Date(Date.now() + 86400000) } });
      await db.user.create({ data: { name: 'Outro', email: 'outro@gmail.com', password: 'x', phone: '', cpf: '', companyId: company.id, profileId: superP.id } });
      expect((await fullLogin({ sub: 'g-outro', email: 'outro@gmail.com' })).error).toBe('conta_vinculada');
      const outro = await db.user.findFirstOrThrow({ where: { email: 'outro@gmail.com' } });
      expect(outro.externalUntil).toBeNull();
      expect(outro.googleSub).toBeNull();
    });

    it('ligar o Google derruba sessões por senha abertas antes, de quem é do domínio', async () => {
      const { db, company, approver, operacao } = await cenario({ enabled: false });
      const pass = await hash('SenhaForte123', 10);
      await db.user.create({ data: { name: 'Ana', email: `ana@${DOMAIN}`, password: pass, phone: '', cpf: '', companyId: company.id, profileId: operacao.id } });
      await db.user.create({ data: { name: 'Fora', email: 'fora@gmail.com', password: pass, phone: '', cpf: '', companyId: company.id, profileId: operacao.id } });
      const cookieOf = (r: any) => (r.headers['set-cookie'] as string[]).find((c) => c.startsWith('refreshToken='))!.split(';')[0];
      const ana = cookieOf(await api().post('/auth/login').send({ email: `ana@${DOMAIN}`, password: 'SenhaForte123', cnpj: company.cnpj }).expect(201));
      const fora = cookieOf(await api().post('/auth/login').send({ email: 'fora@gmail.com', password: 'SenhaForte123', cnpj: company.cnpj }).expect(201));
      await api().put('/access-settings').set(auth(company.id, approver.id, APPROVER)).send({ googleDomain: DOMAIN, googleLoginEnabled: true }).expect(200);
      await api().post('/auth/refresh-token').set('Cookie', ana).send({}).expect(401);
      await api().post('/auth/refresh-token').set('Cookie', fora).send({}).expect(201);
    });

    it('token de pendente abre uma sessão só, e não depois de desligar o Google', async () => {
      const { db, company, operacao } = await cenario();
      const a = await fullLogin(domainId({ sub: 'g-p1', email: `p1@${DOMAIN}` }));
      const b = await fullLogin(domainId({ sub: 'g-p2', email: `p2@${DOMAIN}` }));
      await db.user.updateMany({ where: { email: { in: [`p1@${DOMAIN}`, `p2@${DOMAIN}`] } }, data: { profileId: operacao.id } });
      const pa = { Authorization: `Bearer ${a.res!.body.pendingToken}` };
      expect((await api().post('/auth/access-request/enter').set(pa).expect(201)).body.status).toBe('ok');
      await api().post('/auth/access-request/enter').set(pa).expect(401);

      await db.company.update({ where: { id: company.id }, data: { google_login_enabled: false } });
      await api().post('/auth/access-request/enter').set({ Authorization: `Bearer ${b.res!.body.pendingToken}` }).expect(401);
    });

    it('dois aprovadores ao mesmo tempo: só um decide', async () => {
      const { db, company, approver, operacao, admin } = await cenario();
      const { res } = await fullLogin(domainId({ sub: 'g-r', email: `r@${DOMAIN}` }));
      await api().post('/auth/access-request').set({ Authorization: `Bearer ${res!.body.pendingToken}` }).send({}).expect(201);
      const reqRow = await db.accessRequest.findFirstOrThrow();
      const h = auth(company.id, approver.id, APPROVER, 'super');
      const [r1, r2] = await Promise.all([
        api().post(`/access-requests/${reqRow.id}/approve`).set(h).send({ profileId: operacao.id }),
        api().post(`/access-requests/${reqRow.id}/approve`).set(h).send({ profileId: admin.id }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      const winner = r1.status === 201 ? operacao.id : admin.id;
      expect((await db.user.findFirstOrThrow({ where: { email: `r@${DOMAIN}` } })).profileId).toBe(winner);
    });

    it('state inventado não trava o login do escritório; troca de ticket de outra origem é recusada', async () => {
      const { db, company, operacao } = await cenario();
      await db.user.create({ data: { name: 'Ana', email: `ana@${DOMAIN}`, password: 'x', phone: '', cpf: '', companyId: company.id, profileId: operacao.id } });
      const { cookie } = await start();
      for (let i = 0; i < 8; i++) expect((await callback(`inventado-${i}`, cookie)).ge).toBe('estado_invalido');
      next = domainId();
      const s = await start();
      const f = await callback(s.state, s.cookie);
      expect(f.gt).toBeTruthy();
      await api().post('/auth/google/exchange').set('Cookie', s.cookie).set('Origin', 'https://site.test.local').send({ ticket: f.gt }).expect(403);
      await api().post('/auth/google/exchange').set('Cookie', s.cookie).set('Origin', 'https://sistema.test.local').send({ ticket: f.gt }).expect(201);
    });
  });
});
