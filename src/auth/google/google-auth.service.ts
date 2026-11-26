import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcrypt';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { CacheService } from 'src/common/cache/cache.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService, emailIsFromDomain } from '../auth.service';
import { GoogleIdentity, GoogleOidcService } from './google-oidc.service';

const STATE_TTL_S = 10 * 60; // tempo para escolher a conta no Google
const TICKET_TTL_S = 60; // do retorno do Google até o front trocar o ticket
const PENDING_TTL = '2h';
export const PENDING_AUDIENCE = 'ws-google-pending';

/** Recusas do login Google. O código vai para a tela de login (sem dados pessoais). */
export class GoogleLoginError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail ?? code);
  }
}

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const random = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Compara em tempo constante dois hashes hex (cookie do navegador × registro). */
function sameHash(a?: string, b?: string) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Segredo próprio do token de "pendente": derivado, mas diferente do segredo do
 * access token, então o AuthGuard normal nunca aceita um token de pendente.
 */
export function pendingSecret() {
  const base = process.env.JWT_ACCESS_SECRET;
  // sem a variável o segredo seria o HMAC de "" (conhecido): recusa
  if (!base || base.length < 16) throw new Error('JWT_ACCESS_SECRET não configurada');
  return createHmac('sha256', base)
    .update('google-pending-v1')
    .digest('hex');
}

/** Mesmo include do login por senha: perfil, permissões e produtos. */
export const FULL_USER_INCLUDE = {
  profile: {
    include: {
      permissions: { where: { inactiveAt: null }, include: { permission: true } },
    },
  },
  permissions: { where: { inactiveAt: null }, include: { permission: true } },
  company: { include: { products: { include: { product: true } } } },
} as const;

type Resolved = { userId: number; kind: 'full' | 'pending' };

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger('GoogleAuth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly oidc: GoogleOidcService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
  ) {}

  /** O botão aparece na tela de login? (sem dizer qual empresa nem domínio) */
  async enabled() {
    if (!this.oidc.configured) return false;
    const n = await this.prisma.company.count({
      where: { google_login_enabled: true, active: true, google_domain: { not: null } },
    });
    return n > 0;
  }

  /**
   * Começa o fluxo: state, nonce e PKCE guardados no Redis (uso único). O
   * `binder` vai num cookie httpOnly do navegador que começou o login; o
   * retorno e a troca do ticket só valem nesse mesmo navegador (CSRF de login).
   */
  async start() {
    if (!(await this.enabled())) throw new GoogleLoginError('desligado');
    const state = random();
    const nonce = random();
    const verifier = random(48);
    const binder = random();
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    await this.cache.set(
      `auth:g:state:${sha256(state)}`,
      { nonce, verifier, binder: sha256(binder) },
      STATE_TTL_S,
    );
    return { url: this.oidc.authUrl({ state, nonce, codeChallenge }), binder };
  }

  /** Volta do Google: valida tudo e devolve um ticket de uso único (60 s). */
  async callback(params: { code?: string; state?: string; binder?: string }) {
    if (!params.state || !params.code) throw new GoogleLoginError('estado_invalido');
    const rec = await this.cache.take<{ nonce: string; verifier: string; binder: string }>(
      `auth:g:state:${sha256(params.state)}`,
    );
    if (!rec) throw new GoogleLoginError('estado_invalido');
    if (!sameHash(sha256(params.binder ?? ''), rec.binder)) {
      throw new GoogleLoginError('navegador_diferente');
    }

    let identity: GoogleIdentity;
    try {
      identity = await this.oidc.exchangeAndVerify(params.code, rec.verifier);
    } catch (e) {
      this.logger.warn(`troca/validação com o Google falhou: ${(e as Error).message}`);
      throw new GoogleLoginError('google_falhou');
    }
    if (!identity.nonce || identity.nonce !== rec.nonce) {
      throw new GoogleLoginError('google_falhou', 'nonce diferente');
    }
    if (!identity.emailVerified || !identity.email) {
      throw new GoogleLoginError('email_nao_verificado', identity.email);
    }

    const resolved = await this.resolveUser(identity);
    const ticket = random();
    await this.cache.set(
      `auth:g:ticket:${sha256(ticket)}`,
      { ...resolved, binder: rec.binder },
      TICKET_TTL_S,
    );
    return { ticket, email: identity.email };
  }

  /**
   * Quem é essa conta Google para o sistema:
   * 1. conta do Workspace (claim `hd`) de uma empresa com o Google ligado → da casa;
   * 2. senão, só entra com convite ativo para aquele e-mail exato.
   */
  async resolveUser(id: GoogleIdentity): Promise<Resolved> {
    if (id.hd) {
      const company = await this.prisma.company.findFirst({
        where: { google_domain: id.hd, google_login_enabled: true, active: true },
      });
      if (company) {
        if (!emailIsFromDomain(id.email, id.hd)) throw new GoogleLoginError('dominio_invalido', id.email);
        return this.domainUser(company.id, id);
      }
    }
    return this.invitedUser(id);
  }

  private async domainUser(companyId: number, id: GoogleIdentity): Promise<Resolved> {
    let user = await this.prisma.user.findUnique({ where: { googleSub: id.sub } });
    if (user && user.companyId !== companyId) throw new GoogleLoginError('conta_vinculada', id.email);

    if (!user) {
      const byEmail = await this.prisma.user.findFirst({
        where: { companyId, email: { equals: id.email, mode: 'insensitive' } },
        orderBy: { id: 'asc' },
      });
      if (byEmail) {
        if (byEmail.googleSub && byEmail.googleSub !== id.sub) {
          throw new GoogleLoginError('conta_vinculada', id.email);
        }
        user = await this.prisma.user.update({
          where: { id: byEmail.id },
          data: { googleSub: id.sub },
        });
      } else {
        user = await this.prisma.user.create({
          data: {
            companyId,
            name: (id.name || id.email.split('@')[0]).slice(0, 255),
            email: id.email,
            // senha inutilizável: quem é do domínio só entra pelo Google
            password: await hash(random(48), 10),
            phone: '',
            cpf: '',
            googleSub: id.sub,
            imageUrl: id.picture && id.picture.length <= 255 ? id.picture : null,
          },
        });
        await this.log(companyId, user.id, 'google_novo_usuario');
      }
    }

    if (!user.active || user.inactiveAt) throw new GoogleLoginError('usuario_inativo', id.email);
    return { userId: user.id, kind: user.profileId ? 'full' : 'pending' };
  }

  private async invitedUser(id: GoogleIdentity): Promise<Resolved> {
    const now = new Date();
    const invites = await this.prisma.externalInvite.findMany({
      where: {
        email: id.email,
        revokedAt: null,
        company: { google_login_enabled: true, active: true },
      },
    });
    if (invites.length === 0) throw new GoogleLoginError('sem_convite', id.email);
    const valid = invites.filter((i) => i.expiresAt > now);
    if (valid.length === 0) throw new GoogleLoginError('convite_vencido', id.email);
    if (valid.length > 1) throw new GoogleLoginError('convites_multiplos', id.email);
    const inv = valid[0];
    if (inv.googleSub && inv.googleSub !== id.sub) throw new GoogleLoginError('conta_vinculada', id.email);

    // O convite só serve ao usuário que ele mesmo criou: nunca reaproveita uma
    // conta que já existia com o mesmo e-mail (perfil antigo, conta de emergência…).
    let user = inv.userId ? await this.prisma.user.findUnique({ where: { id: inv.userId } }) : null;
    const bySub = await this.prisma.user.findUnique({ where: { googleSub: id.sub } });
    if (bySub && bySub.id !== user?.id) throw new GoogleLoginError('conta_vinculada', id.email);
    if (user?.googleSub && user.googleSub !== id.sub) throw new GoogleLoginError('conta_vinculada', id.email);
    if (!user) {
      const sameEmail = await this.prisma.user.findFirst({
        where: { companyId: inv.companyId, email: { equals: id.email, mode: 'insensitive' } },
      });
      if (sameEmail) throw new GoogleLoginError('conta_vinculada', id.email);
    }

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          companyId: inv.companyId,
          name: (id.name || id.email.split('@')[0]).slice(0, 255),
          email: id.email,
          password: await hash(random(48), 10),
          phone: '',
          cpf: '',
          googleSub: id.sub,
          profileId: inv.profileId,
          externalUntil: inv.expiresAt,
          imageUrl: id.picture && id.picture.length <= 255 ? id.picture : null,
        },
      });
      await this.log(inv.companyId, user.id, 'google_convidado_novo');
    }
    if (!user.active || user.inactiveAt) throw new GoogleLoginError('usuario_inativo', id.email);

    await this.prisma.$transaction([
      this.prisma.externalInvite.update({
        where: { id: inv.id },
        data: { googleSub: id.sub, userId: user.id, firstLoginAt: inv.firstLoginAt ?? now },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          googleSub: id.sub,
          externalUntil: inv.expiresAt,
        },
      }),
    ]);
    return { userId: user.id, kind: 'full' };
  }

  /**
   * Troca o ticket (uso único, mesmo navegador) pela sessão. Sem perfil, devolve
   * só um token de pendente, que não abre nada além do pedido de acesso.
   */
  async exchange(ticket: string, binder: string | undefined, response: any) {
    const rec = ticket
      ? await this.cache.take<Resolved & { binder: string }>(`auth:g:ticket:${sha256(ticket)}`)
      : null;
    if (!rec || !sameHash(sha256(binder ?? ''), rec.binder)) {
      throw new UnauthorizedException('Login expirado. Entre com o Google de novo.');
    }
    return this.enterOrPending(rec.userId, response);
  }

  /** Revalida o usuário no banco e abre a sessão (ou devolve o pendente). */
  async enterOrPending(userId: number, response: any, opts: { pendingJti?: string } = {}) {
    const user: any = await this.prisma.user.findUnique({
      where: { id: userId },
      include: FULL_USER_INCLUDE,
    });
    if (!user || !user.active || user.inactiveAt) {
      throw new UnauthorizedException('Acesso negado para este usuário!');
    }
    if (!user.company?.active) throw new UnauthorizedException('Empresa inativa!');
    if (user.externalUntil && new Date(user.externalUntil) <= new Date()) {
      throw new UnauthorizedException('Acesso de convidado vencido.');
    }
    if (user.profile && !user.profile.inactiveAt) {
      if (opts.pendingJti) {
        // pendente aprovado: só se o Google continua ligado e a conta vinculada,
        // e o token de pendente abre UMA sessão (depois morre)
        if (!user.company.google_login_enabled || !user.googleSub) {
          throw new UnauthorizedException('Entre com o Google de novo.');
        }
        const first = await this.cache.client().set(`auth:g:pending-used:${opts.pendingJti}`, '1', 'EX', 3 * 3600, 'NX');
        if (first !== 'OK') throw new UnauthorizedException('Entre com o Google de novo.');
      }
      const session = await this.auth.issueSession(user, response, { method: 'google' });
      return { status: 'ok' as const, ...session };
    }
    // convidado nunca fica pendente: sem perfil, sem acesso
    if (user.externalUntil) throw new UnauthorizedException('Convite sem perfil.');
    const pendingToken = this.jwt.sign(
      { sub: user.id, companyId: user.companyId, typ: 'pending', jti: random(16) },
      { secret: pendingSecret(), expiresIn: PENDING_TTL, audience: PENDING_AUDIENCE },
    );
    return {
      status: 'pending' as const,
      pendingToken,
      user: { name: user.name, email: user.email, imageUrl: user.imageUrl },
    };
  }

  private async log(companyId: number, userId: number, action: string) {
    await this.prisma.system_Logs
      .create({
        data: { companyId, userId, action, entity: 'user', entityId: userId, column: null, oldValue: null, newValue: null },
      })
      .catch(() => undefined);
  }
}
