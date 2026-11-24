import './setup/env'; // precisa ser o primeiro import
import { HttpException } from '@nestjs/common';
import { SecurityService } from 'src/common/security/security.service';
import { LoginAttemptsService } from 'src/common/security/login-attempts.service';

/** Redis de mentira, em memória, com TTL em segundos. */
class FakeCache {
  store = new Map<string, { v: any; exp?: number }>();
  private alive(k: string) {
    const e = this.store.get(k);
    if (e && e.exp && e.exp <= Date.now()) this.store.delete(k);
    return this.store.get(k);
  }
  async get(k: string) {
    return this.alive(k)?.v ?? null;
  }
  async set(k: string, v: any, ttl?: number) {
    this.store.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : undefined });
  }
  async del(k: string) {
    this.store.delete(k);
  }
  async ttl(k: string) {
    const e = this.alive(k);
    if (!e) return -2;
    return e.exp ? Math.ceil((e.exp - Date.now()) / 1000) : -1;
  }
  async keys(p: string) {
    const pre = p.replace('*', '');
    return [...this.store.keys()].filter(
      (k) => k.startsWith(pre) && this.alive(k),
    );
  }
  async increment(k: string, ttl?: number) {
    const n = (this.alive(k)?.v ?? 0) + 1;
    await this.set(k, n, ttl);
    return n;
  }
}

const req = (ip: string, url = '/customer', body?: any, ua = 'Mozilla/5.0') =>
  ({
    headers: { 'x-forwarded-for': ip, 'user-agent': ua },
    url,
    query: {},
    body,
    ip,
    socket: { remoteAddress: ip },
  }) as any;

const flush = () => new Promise((r) => setTimeout(r, 10));

function newSecurity(cache?: FakeCache) {
  const s = new SecurityService(cache as any);
  (s as any).config.enabled = true; // no teste vem desligada
  return s;
}

describe('Detecção de ataques', () => {
  it('barra as varreduras vistas nos logs de produção', () => {
    const probes = [
      '/.env',
      '/.git/config',
      '/app/.env',
      '/.env.production',
      '/.aws/credentials',
      '/.ssh/id_rsa',
      '/wp-content/plugins/contact-form-7/readme.txt',
      '/wp-login.php',
      '/info.php',
      '/actuator/env',
      '/cgi-bin/../../proc/self/environ',
      '/..;/manager/html',
      '/userfiles/x?path=../../../.env',
      '/x/%252f..%252f..%252fetc/passwd',
      '/../../../../../../home/ubuntu/.aws/credentials',
      '/customer?name=1%27%20union%20select%20password%20from%20users--',
    ];
    for (const url of probes) {
      const s = newSecurity();
      expect({
        url,
        allowed: s.logRequest(req('45.138.12.27', url)).allowed,
      }).toEqual({ url, allowed: false });
    }
  });

  it('não bloqueia uso normal: texto com "update/select/create", iframe do blog, buscas', () => {
    const s = newSecurity();
    const ok = [
      req('177.1.1.1', '/ai/conversations/11', {
        message:
          'Select the best option and update the proposal; create a new one, delete from the list',
      }),
      req('177.1.1.1', '/blog/posts/3', {
        content:
          '<p>Veja</p><iframe src="https://www.youtube.com/embed/x"></iframe>',
      }),
      req(
        '177.1.1.1',
        '/customer?search=update%20engenharia&limit=10&order-name=asc',
      ),
      req('177.1.1.1', '/commercial/proposals?search=and%202%20%3D%203'),
      req('177.1.1.1', '/stock/items?search=env'),
      req('177.1.1.1', '/blog/posts/public/escadas-nr-35-anexo-iii'),
    ];
    for (const r of ok)
      expect({ url: r.url, allowed: s.logRequest(r).allowed }).toEqual({
        url: r.url,
        allowed: true,
      });
  });

  it('robô de varredura pelo User-Agent', () => {
    expect(
      newSecurity().logRequest(
        req(
          '9.9.9.9',
          '/customer',
          undefined,
          'Mozilla/5.0 (compatible; Nuclei)',
        ),
      ).allowed,
    ).toBe(false);
  });
});

describe('Bloqueio persistente (Redis)', () => {
  it('bloqueio fica no Redis e volta depois de um restart', async () => {
    const cache = new FakeCache();
    const s1 = newSecurity(cache);
    expect(s1.logRequest(req('45.138.12.27', '/.env')).allowed).toBe(false);
    await flush();
    expect(await cache.ttl('sec:block:45.138.12.27')).toBeGreaterThan(1700);

    const s2 = newSecurity(cache); // "restart"
    await s2.onModuleInit();
    expect(s2.logRequest(req('45.138.12.27')).allowed).toBe(false);
    expect(s2.logRequest(req('177.212.206.242')).allowed).toBe(true);
  });

  it('reincidente fica mais tempo de fora (1x, 4x, 24 h)', async () => {
    const cache = new FakeCache();
    for (const expected of [1800, 7200, 86400]) {
      const s = newSecurity(cache);
      s.blockIp('45.138.12.27', 1800_000, 'teste');
      await flush();
      const ttl = await cache.ttl('sec:block:45.138.12.27');
      expect(ttl).toBeGreaterThan(expected - 5);
      expect(ttl).toBeLessThanOrEqual(expected);
    }
  });

  it('IP da lista de permitidos nunca é bloqueado', async () => {
    const cache = new FakeCache();
    const s = newSecurity(cache);
    (s as any).whitelistedIps.add('200.200.200.200');
    expect(s.logRequest(req('200.200.200.200', '/.env')).allowed).toBe(true);
    s.blockIp('200.200.200.200', 60000);
    await flush();
    expect(await cache.get('sec:block:200.200.200.200')).toBeNull();
  });

  it('avisa o dono numa rajada de ataques (webhook), no máximo um aviso a cada 15 min', async () => {
    const prev = process.env.SECURITY_ALERT_WEBHOOK;
    process.env.SECURITY_ALERT_WEBHOOK = 'https://ntfy.sh/worksafe-teste';
    const calls: any[] = [];
    const realFetch = global.fetch;
    global.fetch = (async (...a: any[]) => {
      calls.push(a);
      return new Response('ok');
    }) as any;
    try {
      const s = newSecurity();
      for (let i = 1; i <= 12; i++)
        s.logRequest(req(`45.138.12.${i}`, '/.git/config'));
      await flush();
      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toBe('https://ntfy.sh/worksafe-teste');
      expect(String(calls[0][1].body)).toContain('45.138.12.');
    } finally {
      global.fetch = realFetch;
      process.env.SECURITY_ALERT_WEBHOOK = prev;
    }
  });
});

describe('Login: tentativas por conta e IP', () => {
  const status = async (p: Promise<any>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof HttpException ? e.getStatus() : 'erro';
    }
  };

  it('5 senhas erradas → espera progressiva só para aquele IP + conta', async () => {
    const cache = new FakeCache();
    const login = new LoginAttemptsService(cache as any, newSecurity(cache));
    for (let i = 0; i < 4; i++)
      await login.registerFailure('user', '9.9.9.9', 'dono@x.com|');
    expect(
      await status(login.assertAllowed('user', '9.9.9.9', 'dono@x.com|')),
    ).toBe('ok');
    await login.registerFailure('user', '9.9.9.9', 'dono@x.com|');
    expect(
      await status(login.assertAllowed('user', '9.9.9.9', 'dono@x.com|')),
    ).toBe(429);
    expect(await cache.ttl('sec:login:user:pl:9.9.9.9:dono@x.com|')).toBe(30);
    await login.registerFailure('user', '9.9.9.9', 'DONO@x.com|'); // maiúscula conta igual
    expect(await cache.ttl('sec:login:user:pl:9.9.9.9:dono@x.com|')).toBe(60);
    // o dono, de outro IP, continua entrando
    expect(
      await status(login.assertAllowed('user', '177.1.1.1', 'dono@x.com|')),
    ).toBe('ok');
  });

  it('acerto zera a espera daquele IP', async () => {
    const cache = new FakeCache();
    const login = new LoginAttemptsService(cache as any);
    for (let i = 0; i < 5; i++)
      await login.registerFailure('user', '9.9.9.9', 'a@x.com|');
    await login.registerSuccess('user', '9.9.9.9', 'a@x.com|');
    expect(
      await status(login.assertAllowed('user', '9.9.9.9', 'a@x.com|')),
    ).toBe('ok');
  });

  it('ataque distribuído (muitos IPs na mesma conta) trava a conta por 15 min', async () => {
    const cache = new FakeCache();
    const login = new LoginAttemptsService(cache as any);
    for (let i = 0; i < 30; i++)
      await login.registerFailure('user', `10.0.0.${i}`, 'a@x.com|');
    expect(
      await status(login.assertAllowed('user', '177.1.1.1', 'a@x.com|')),
    ).toBe(429);
  });

  it('um IP testando senhas em várias contas é bloqueado', async () => {
    const cache = new FakeCache();
    const security = newSecurity(cache);
    const login = new LoginAttemptsService(cache as any, security);
    for (let i = 0; i < 30; i++)
      await login.registerFailure('user', '9.9.9.9', `u${i}@x.com|`);
    expect(security.isIpBlocked('9.9.9.9')).toBe(true);
  });

  it('sem Redis o login segue funcionando', async () => {
    const login = new LoginAttemptsService(undefined, undefined);
    await login.registerFailure('user', '9.9.9.9', 'a');
    expect(await status(login.assertAllowed('user', '9.9.9.9', 'a'))).toBe(
      'ok',
    );
  });
});
