import { Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

/** O que sobra do id_token do Google depois de validado. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  /** domínio do Google Workspace; ausente em Gmail e contas pessoais */
  hd?: string;
  name?: string;
  picture?: string;
  nonce?: string;
}

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * Conversa com o Google (OpenID Connect). Isolado num serviço para os testes
 * trocarem a rede por respostas prontas.
 */
@Injectable()
export class GoogleOidcService {
  get clientId() {
    return process.env.GOOGLE_AUTH_CLIENT_ID || '';
  }
  get redirectUri() {
    return process.env.GOOGLE_AUTH_REDIRECT_URI || '';
  }
  get configured() {
    return Boolean(this.clientId && process.env.GOOGLE_AUTH_CLIENT_SECRET && this.redirectUri);
  }

  private client() {
    return new OAuth2Client({
      clientId: this.clientId,
      clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET,
      redirectUri: this.redirectUri,
    });
  }

  authUrl(params: { state: string; nonce: string; codeChallenge: string }) {
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
      access_type: 'online',
    });
    return `${GOOGLE_AUTH_ENDPOINT}?${q.toString()}`;
  }

  /**
   * Troca o code pelo id_token (no servidor, com PKCE) e valida assinatura,
   * emissor, audiência e validade com as chaves públicas do Google.
   */
  async exchangeAndVerify(code: string, codeVerifier: string): Promise<GoogleIdentity> {
    const client = this.client();
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: this.redirectUri });
    if (!tokens.id_token) throw new Error('Google não devolveu id_token');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.clientId });
    const p = ticket.getPayload();
    if (!p?.sub) throw new Error('id_token sem sub');
    if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') {
      throw new Error('emissor inválido');
    }
    return {
      sub: p.sub,
      email: String(p.email ?? '').trim().toLowerCase(),
      emailVerified: p.email_verified === true,
      hd: p.hd ? String(p.hd).toLowerCase() : undefined,
      name: p.name,
      picture: p.picture,
      nonce: p.nonce,
    };
  }
}
