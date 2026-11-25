import './setup/env'; // precisa ser o primeiro import

import { generateKeyPairSync, createSign } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { GoogleOidcService } from 'src/auth/google/google-oidc.service';

/**
 * Validação do id_token com a biblioteca do Google, sem rede: as chaves
 * públicas e a troca do code são trocadas por versões locais. Prova que
 * assinatura falsa, outra audiência, outro emissor e token vencido não passam.
 */
describe('id_token do Google (validação real)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  let idToken = '';

  function sign(claims: Record<string, unknown>, key = privateKey) {
    const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const now = Math.floor(Date.now() / 1000);
    const body = b64({
      iss: 'https://accounts.google.com', aud: 'client-teste', sub: 'g-1', email: 'Ana@WorkSafeBrasil.com.br',
      email_verified: true, hd: 'worksafebrasil.com.br', nonce: 'n1', iat: now, exp: now + 3600, ...claims,
    });
    const s = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
    return `${head}.${body}.${s}`;
  }

  const svc = new GoogleOidcService();
  beforeAll(() => {
    process.env.GOOGLE_AUTH_CLIENT_ID = 'client-teste';
    process.env.GOOGLE_AUTH_CLIENT_SECRET = 'segredo';
    process.env.GOOGLE_AUTH_REDIRECT_URI = 'https://api.test.local/auth/google/callback';
    jest.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation((async () => ({ tokens: { id_token: idToken } })) as any);
    jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({ certs: { k1: pem } } as any);
  });
  afterAll(() => jest.restoreAllMocks());

  it('token bom: e-mail minúsculo, hd e nonce', async () => {
    idToken = sign({});
    await expect(svc.exchangeAndVerify('c', 'v')).resolves.toMatchObject({
      sub: 'g-1', email: 'ana@worksafebrasil.com.br', emailVerified: true, hd: 'worksafebrasil.com.br', nonce: 'n1',
    });
  });

  it.each([
    ['assinado com outra chave', () => sign({}, other.privateKey)],
    ['outra audiência', () => sign({ aud: 'outro-app' })],
    ['outro emissor', () => sign({ iss: 'https://evil.example.com' })],
    ['vencido', () => sign({ exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 })],
  ])('recusa: %s', async (_name, make) => {
    idToken = make();
    await expect(svc.exchangeAndVerify('c', 'v')).rejects.toThrow();
  });

  it('e-mail não verificado chega como false (o fluxo recusa)', async () => {
    idToken = sign({ email_verified: false });
    await expect(svc.exchangeAndVerify('c', 'v')).resolves.toMatchObject({ emailVerified: false });
  });
});
