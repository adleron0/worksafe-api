import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { PrismaService } from 'src/prisma/prisma.service';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;

const ACCESS_SECONDS = 60 * 60; // 1 hora
const REFRESH_DAYS = 30;
const REQUEST_MINUTES = 10;

/** Onde fica a tela de autorização (o front do sistema). */
export const frontUrl = () => (process.env.FRONT_URL || process.env.ORIGIN_CORS?.split(',')[0] || 'https://sistema.worksafebrasil.com.br').replace(/\/$/, '');
/** URL pública da API (emissor do OAuth e endereço do MCP). */
export const apiUrl = () => (process.env.API_PUBLIC_URL || 'https://api.worksafebrasil.com.br').replace(/\/$/, '');

export interface McpIdentity { userId: number; companyId: number; tokenId: number; clientId: string }

/**
 * Servidor OAuth do MCP. O app de IA (Claude, ChatGPT…) se registra, manda a
 * pessoa para a tela do WorkSafe, onde ela entra com o próprio login e aprova;
 * o app recebe um token só do MCP, que expira em 1 hora, renova por 30 dias e
 * pode ser revogado. Tokens e códigos ficam só como hash no banco.
 */
@Injectable()
export class McpOAuthService implements OAuthServerProvider {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- clientes

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        const row = await this.prisma.mcp_Client.findUnique({ where: { clientId } });
        return row ? (row.metadata as unknown as OAuthClientInformationFull) : undefined;
      },
      registerClient: async (client) => {
        const clientId = `mcp_${randomUUID().replace(/-/g, '')}`;
        const secret = client.token_endpoint_auth_method === 'none' ? undefined : token('mcs');
        const full: OAuthClientInformationFull = {
          ...client, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000),
          ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        };
        // o segredo é devolvido uma vez ao cliente; no banco, a informação do registro fica sem ele
        const { client_secret: _secret, ...stored } = full;
        await this.prisma.mcp_Client.create({
          data: { clientId, clientSecretHash: secret ? hash(secret) : null, name: String(client.client_name ?? '').slice(0, 200) || null, metadata: { ...stored, ...(secret ? { client_secret: secret } : {}) } as unknown as Prisma.InputJsonValue },
        });
        return full;
      },
    };
  }

  // ---------------------------------------------------------------- autorização

  /** Guarda o pedido e manda a pessoa para a tela de aprovação do front. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const key = randomBytes(24).toString('base64url');
    await this.prisma.mcp_AuthRequest.create({
      data: {
        key, clientId: client.client_id, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, state: params.state ?? null,
        scopes: (params.scopes ?? []) as Prisma.InputJsonValue, resource: params.resource?.toString() ?? null, expiresAt: new Date(Date.now() + REQUEST_MINUTES * 60000),
      },
    });
    res.redirect(302, `${frontUrl()}/conectar-ia?pedido=${encodeURIComponent(key)}`);
  }

  /** O que a tela de aprovação mostra: qual app quer acesso. */
  async describeRequest(key: string) {
    const row = await this.prisma.mcp_AuthRequest.findUnique({ where: { key } });
    if (!row || row.usedAt || row.approvedAt || row.expiresAt <= new Date()) throw new NotFoundException('Pedido de conexão inválido ou expirado. Comece de novo pelo app de IA.');
    const client = await this.prisma.mcp_Client.findUnique({ where: { clientId: row.clientId } });
    const redirect = new URL(row.redirectUri);
    return { clientName: client?.name || 'App de IA', redirectHost: redirect.host, expiresAt: row.expiresAt };
  }

  /** A pessoa logada aprovou (ou recusou): gera o código e devolve para onde voltar. */
  async decide(user: { userId: number; companyId: number; permissions: string[] }, key: string, approve: boolean): Promise<{ redirectUrl: string }> {
    if (process.env.MCP_ENABLED === 'false') throw new ForbiddenException('A conexão de apps de IA está desligada');
    const row = await this.prisma.mcp_AuthRequest.findUnique({ where: { key } });
    if (!row || row.usedAt || row.approvedAt || row.expiresAt <= new Date()) throw new NotFoundException('Pedido de conexão inválido ou expirado. Comece de novo pelo app de IA.');
    const target = new URL(row.redirectUri);
    if (row.state) target.searchParams.set('state', row.state);
    if (!approve) {
      await this.prisma.mcp_AuthRequest.update({ where: { id: row.id }, data: { usedAt: new Date() } });
      target.searchParams.set('error', 'access_denied');
      return { redirectUrl: target.toString() };
    }
    if (!user.permissions.includes('usar_mcp')) throw new ForbiddenException('Você não tem permissão para conectar apps de IA ao sistema');
    const code = token('mca');
    await this.prisma.mcp_AuthRequest.update({ where: { id: row.id }, data: { userId: user.userId, companyId: user.companyId, codeHash: hash(code), approvedAt: new Date(), expiresAt: new Date(Date.now() + 5 * 60000) } });
    target.searchParams.set('code', code);
    return { redirectUrl: target.toString() };
  }

  private async approvedRequest(client: OAuthClientInformationFull, code: string) {
    const row = await this.prisma.mcp_AuthRequest.findUnique({ where: { codeHash: hash(code) } });
    if (!row || row.clientId !== client.client_id || !row.approvedAt || row.usedAt || row.expiresAt <= new Date() || !row.userId || !row.companyId) throw new InvalidGrantError('Código inválido ou expirado');
    return row;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return (await this.approvedRequest(client, authorizationCode)).codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const row = await this.approvedRequest(client, authorizationCode);
    if (redirectUri && redirectUri !== row.redirectUri) throw new InvalidGrantError('redirect_uri diferente do pedido');
    const used = await this.prisma.mcp_AuthRequest.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!used.count) throw new InvalidGrantError('Código já usado');
    return this.issue(client, row.userId!, row.companyId!, (row.scopes as string[]) ?? []);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const row = await this.prisma.mcp_Token.findUnique({ where: { refreshTokenHash: hash(refreshToken) } });
    if (!row || row.clientId !== client.client_id || row.revokedAt || (row.refreshExpiresAt && row.refreshExpiresAt <= new Date())) throw new InvalidGrantError('Token de renovação inválido');
    // renovação gira o par: o antigo deixa de valer
    await this.prisma.mcp_Token.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    return this.issue(client, row.userId, row.companyId, (row.scopes as string[]) ?? []);
  }

  private async issue(client: OAuthClientInformationFull, userId: number, companyId: number, scopes: string[]): Promise<OAuthTokens> {
    const access = token('mat');
    const refresh = token('mrt');
    await this.prisma.mcp_Token.create({
      data: {
        companyId, userId, clientId: client.client_id, clientName: String(client.client_name ?? '').slice(0, 200) || null,
        accessTokenHash: hash(access), refreshTokenHash: hash(refresh), scopes: scopes as Prisma.InputJsonValue,
        accessExpiresAt: new Date(Date.now() + ACCESS_SECONDS * 1000), refreshExpiresAt: new Date(Date.now() + REFRESH_DAYS * 86400000),
      },
    });
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: scopes.join(' ') || undefined };
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    if (process.env.MCP_ENABLED === 'false') throw new InvalidTokenError('MCP desligado');
    const row = await this.prisma.mcp_Token.findUnique({ where: { accessTokenHash: hash(accessToken) } });
    if (!row || row.revokedAt || row.accessExpiresAt <= new Date()) throw new InvalidTokenError('Token inválido ou expirado');
    // marca o uso no máximo uma vez por minuto
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60000) {
      await this.prisma.mcp_Token.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return {
      token: accessToken, clientId: row.clientId, scopes: (row.scopes as string[]) ?? [], expiresAt: Math.floor(row.accessExpiresAt.getTime() / 1000),
      extra: { userId: row.userId, companyId: row.companyId, tokenId: row.id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const value = hash(request.token);
    await this.prisma.mcp_Token.updateMany({ where: { clientId: client.client_id, revokedAt: null, OR: [{ accessTokenHash: value }, { refreshTokenHash: value }] }, data: { revokedAt: new Date() } });
  }

  // ---------------------------------------------------------------- tela "Conexões de IA"

  async connections(user: { userId: number; companyId: number }, all: boolean) {
    const rows = await this.prisma.mcp_Token.findMany({
      where: { companyId: user.companyId, revokedAt: null, refreshExpiresAt: { gt: new Date() }, ...(all ? {} : { userId: user.userId }) },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.userId))] } }, select: { id: true, name: true } });
    const name = new Map(users.map((item) => [item.id, item.name]));
    return rows.map((row) => ({ id: row.id, client: row.clientName || 'App de IA', user: name.get(row.userId) ?? `#${row.userId}`, mine: row.userId === user.userId, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, expiresAt: row.refreshExpiresAt }));
  }

  async revoke(user: { userId: number; companyId: number }, id: number, all: boolean) {
    const row = await this.prisma.mcp_Token.findFirst({ where: { id, companyId: user.companyId, ...(all ? {} : { userId: user.userId }) } });
    if (!row) throw new NotFoundException('Conexão não encontrada');
    await this.prisma.mcp_Token.update({ where: { id }, data: { revokedAt: new Date() } });
    return { revoked: true };
  }

  /** Botão de pânico: derruba todas as conexões da empresa. */
  async revokeAll(user: { companyId: number }) {
    const out = await this.prisma.mcp_Token.updateMany({ where: { companyId: user.companyId, revokedAt: null }, data: { revokedAt: new Date() } });
    return { revoked: out.count };
  }

  /** Permissões atuais da pessoa (perfil + individuais), lidas a cada chamada do MCP. */
  async permissionsOf(userId: number, companyId: number): Promise<string[] | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, companyId, inactiveAt: null, active: true },
      select: {
        permissions: { where: { inactiveAt: null }, select: { permission: { select: { name: true } } } },
        profile: { select: { permissions: { where: { inactiveAt: null }, select: { permission: { select: { name: true } } } } } },
      },
    });
    if (!user) return null;
    return [...new Set([...user.permissions.map((item) => item.permission.name), ...(user.profile?.permissions ?? []).map((item) => item.permission.name)])];
  }

  assertKey(key: unknown): string {
    const value = String(key ?? '');
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(value)) throw new BadRequestException('Pedido inválido');
    return value;
  }
}
