import './setup/env'; // precisa ser o primeiro import
import { clientIpOf } from 'src/common/security/client-ip';
import { SecurityService } from 'src/common/security/security.service';

const KEY = 'k'.repeat(40);
const req = (headers: Record<string, string>, url = '/customer') => ({ headers, url, query: {}, body: undefined, ip: '152.233.30.101', socket: { remoteAddress: '152.233.30.101' } }) as any;
const viaProxy = (ip: string, url?: string) => req({ 'x-forwarded-for': '152.55.181.131', 'x-ws-client-ip': ip, 'x-ws-proxy-key': KEY }, url);

describe('IP real atrás do proxy', () => {
  const previous = process.env.WS_PROXY_KEY;
  beforeAll(() => { process.env.WS_PROXY_KEY = KEY; });
  afterAll(() => { process.env.WS_PROXY_KEY = previous; });

  it('usa o IP que o proxy assina; sem a chave certa, ignora o header', () => {
    expect(clientIpOf(viaProxy('177.212.206.242'))).toBe('177.212.206.242');
    expect(clientIpOf(req({ 'x-forwarded-for': '152.55.181.131', 'x-ws-client-ip': '1.2.3.4', 'x-ws-proxy-key': 'x'.repeat(40) }))).toBe('152.55.181.131');
    expect(clientIpOf(req({ 'x-forwarded-for': '152.55.181.131', 'x-ws-client-ip': 'não é ip', 'x-ws-proxy-key': KEY }))).toBe('152.55.181.131');
    expect(clientIpOf(req({}))).toBe('152.233.30.101');
  });

  it('ataque que passa pelo proxy bloqueia só quem atacou, não a empresa inteira', () => {
    const security = new SecurityService();
    (security as any).config.enabled = true; // no teste vem desligada
    const attack = security.logRequest(viaProxy('45.138.12.27', '/userfiles/x?path=../../../.env'));
    expect(attack.allowed).toBe(false);
    expect(security.logRequest(viaProxy('45.138.12.27')).allowed).toBe(false);
    expect(security.logRequest(viaProxy('177.212.206.242')).allowed).toBe(true);
    expect(security.logRequest(viaProxy('2804:14c::1')).allowed).toBe(true);
  });
});
