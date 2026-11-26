import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';
import { UserService } from 'src/features/users/user/service';
import { compare } from 'bcrypt';
import { encryptPayload } from 'src/utils/crypto';
import * as Zlib from 'zlib';
import { randomBytes } from 'crypto';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';

const accessTokenSecret = process.env.JWT_ACCESS_SECRET;
const refreshTokenSecret = process.env.JWT_REFRESH_SECRET;
const baseSetup = process.env.BASE_SETUP;
const domain = process.env.PROD_DOMAIN;

const PASSWORD_SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const GOOGLE_SESSION_MS = 12 * 60 * 60 * 1000; // 12 horas

/** Atributos do cookie do refresh token: criar e apagar precisam ser iguais. */
function refreshCookieBase() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: (baseSetup === 'development' ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
    domain: baseSetup === 'development' ? 'localhost' : domain,
  };
}

/** E-mail é do domínio Google da empresa? (comparação exata do que vem depois do @) */
export function emailIsFromDomain(email: string, googleDomain?: string | null): boolean {
  if (!email || !googleDomain) return false;
  const at = email.lastIndexOf('@');
  return at > 0 && email.slice(at + 1).trim().toLowerCase() === googleDomain.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UserService,
    private prisma: PrismaService,
    private readonly authCache: AuthCacheService,
  ) {}

  async login(user: any, response: any) {
    const { email, password, cnpj } = user;

    // Com o Google ligado, e-mail do domínio da empresa só entra pelo Google:
    // senão a senha antiga vira porta dos fundos. Decidido só pelo domínio do
    // e-mail e pelo CNPJ, então não revela se a conta existe.
    const company = await this.prisma.company.findUnique({
      where: { cnpj: String(cnpj ?? '') },
      select: { google_domain: true, google_login_enabled: true },
    });
    const googleOnly = 'E-mails da empresa entram pelo botão "Entrar com Google".';
    if (company?.google_login_enabled && emailIsFromDomain(email, company.google_domain)) {
      throw new ForbiddenException(googleOnly);
    }

    const result = await this.usersService.findOneUser(email, cnpj);

    if (!result) {
      throw new UnauthorizedException('Dados de acesso incorretos!');
    }
    // Senha primeiro: sem ela, ninguém descobre se a conta existe ou está inativa
    const isPasswordCorrect = await compare(password, result.password);
    if (!isPasswordCorrect) {
      throw new UnauthorizedException('Dados de acesso incorretos!');
    }
    if (!result.active) {
      throw new UnauthorizedException('Acesso negado para este usuário!');
    }
    // Decide pelo usuário, não só pelo texto do e-mail: conta ligada ao Google
    // (com o Google ligado) e convidado nunca entram por senha.
    if (result.externalUntil) {
      throw new ForbiddenException('Convidados entram pelo botão "Entrar com Google".');
    }
    if (result.googleSub && company?.google_login_enabled) {
      throw new ForbiddenException(googleOnly);
    }

    // Verificar se o usuário tem uma profile associada
    if (!result.profile) {
      throw new UnauthorizedException('Usuário sem permissão para acessar!');
    }

    // Verifica se empresa está ativa
    if (!result.company.active) {
      throw new UnauthorizedException('Empresa inativa!');
    }

    return this.issueSession(result, response, { method: 'password' });
  }

  /**
   * Monta o payload do access token a partir do usuário (com perfil,
   * permissões e produtos da empresa já carregados).
   */
  buildAccessPayload(user: any) {
    const productNames = (user.company?.products ?? []).map((p) => p.product.name);
    const userPermissions = user.permissions?.map((up) => up.permission.name) || [];
    const profilePermissions =
      user.profile?.permissions?.map((rp) => rp.permission.name) || [];
    const allPermissions = [...new Set([...userPermissions, ...profilePermissions])];
    const compactPermissions = Zlib.deflateRawSync(JSON.stringify(allPermissions), {
      level: 9,
    }).toString('base64');
    return {
      username: user.name,
      imageUrl: user.imageUrl,
      sub: user.id,
      companyId: user.companyId,
      products: productNames,
      profile: user.profile.name,
      permissions: compactPermissions,
    };
  }

  /**
   * Abre a sessão: access token na resposta, refresh token em cookie httpOnly e
   * linha na tabela Session. Quem entra pelo Google tem sessão curta (12 h):
   * suspenso no Google, perde o acesso no mesmo dia.
   */
  async issueSession(
    user: any,
    response: any,
    opts: { method: 'password' | 'google' },
  ) {
    const sessionMs = opts.method === 'google' ? GOOGLE_SESSION_MS : PASSWORD_SESSION_MS;
    const accessToken = this.getAccessToken({ data: encryptPayload(this.buildAccessPayload(user)) });
    const refreshToken = this.jwtService.sign(
      // jti: dois logins no mesmo segundo gerariam o mesmo token (chave única)
      { sub: user.id, jti: randomBytes(12).toString('base64url') },
      { secret: refreshTokenSecret, expiresIn: Math.floor(sessionMs / 1000) },
    );

    await this.prisma.session.create({
      data: {
        userId: user.id,
        sessionToken: refreshToken,
        expires: new Date(Date.now() + sessionMs),
      },
    });

    response.cookie('refreshToken', refreshToken, {
      ...refreshCookieBase(),
      maxAge: sessionMs,
    });

    await this.prisma.system_Logs.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        action: opts.method === 'google' ? 'login_google' : 'login',
        entity: 'user',
        entityId: user.id,
        column: null,
        oldValue: null,
        newValue: null,
      },
    });

    return { accessToken };
  }

  getAccessToken(payload: any) {
    return this.jwtService.sign(payload, {
      secret: accessTokenSecret,
      // 15 min: um token vazado (XSS) vale pouco; o front renova sozinho
      expiresIn: '15m',
    });
  }

  async logout(refreshToken: string, response: any) {
    const verifyRefresh = this.jwtService.verify(refreshToken, {
      secret: refreshTokenSecret,
    });
    await this.prisma.session.update({
      where: {
        userId_sessionToken: {
          userId: Number(verifyRefresh.sub),
          sessionToken: refreshToken,
        },
      },
      data: {
        inactiveAt: new Date(),
      },
    });

    // Sem isto, o refresh token "deslogado" continuava emitindo access tokens
    // enquanto a sessão vivesse no Redis (TTL de 7 dias).
    await this.authCache.invalidateUserCache(Number(verifyRefresh.sub));

    // Sobrescreve o cookie do refreshToken para removê-lo no lado do cliente
    // Mesmo domain/sameSite da criação: sem o domain o navegador não apagava
    response.cookie('refreshToken', '', {
      ...refreshCookieBase(),
      expires: new Date(0),
    });
  }

  async refreshToken(refreshToken: string) {
    try {
      const verifyRefresh = this.jwtService.verify(refreshToken, {
        secret: refreshTokenSecret,
      });

      // Tentar buscar do cache primeiro
      const cachedSession = await this.authCache.getSession(
        Number(verifyRefresh.sub),
        refreshToken,
      );

      let refreshTokenResult;

      if (cachedSession) {
        console.log(`Session cache hit for user ${verifyRefresh.sub}`);
        refreshTokenResult = cachedSession;
      } else {
        // Se não tem cache, buscar do banco
        refreshTokenResult = await this.prisma.session.findUnique({
          where: {
            userId_sessionToken: {
              userId: Number(verifyRefresh.sub),
              sessionToken: refreshToken,
            },
          },
          include: {
            user: {
              include: {
                profile: {
                  include: {
                    permissions: {
                      include: {
                        permission: true,
                      },
                      where: {
                        inactiveAt: null,
                      },
                    },
                  },
                },
                permissions: {
                  include: {
                    permission: true,
                  },
                  where: {
                    inactiveAt: null,
                  },
                },
                company: {
                  include: {
                    products: {
                      include: {
                        product: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        if (!refreshTokenResult) {
          throw new UnauthorizedException('Invalid refresh token');
        }

        // Salvar no cache para próximas requisições
        await this.authCache.setSession(
          Number(verifyRefresh.sub),
          refreshToken,
          refreshTokenResult,
        );
      }

      // Validações valem para os DOIS caminhos (cache e banco): o cache não
      // pode ser um bypass de sessão revogada.
      if (refreshTokenResult.inactiveAt) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Verificar se o usuário está ativo
      if (!refreshTokenResult.user.active) {
        throw new UnauthorizedException('Usuário sem permissão para acessar!');
      }

      // Verifica se Empresa está ativa
      if (!refreshTokenResult.user.company.active) {
        throw new UnauthorizedException('Empresa desativada!');
      }

      const user = refreshTokenResult.user;

      // Verificar se o usuário tem uma profile associada
      if (!user.profile) {
        throw new UnauthorizedException('Usuário sem permissão para acessar!');
      }

      // Convidado externo com prazo vencido perde o acesso na hora
      if (user.externalUntil && new Date(user.externalUntil) <= new Date()) {
        throw new UnauthorizedException('Acesso de convidado vencido.');
      }

      const payload = this.buildAccessPayload(user);

      // Gerar o novo accessToken
      const newAccessToken = this.getAccessToken({
        data: encryptPayload(payload),
      });

      return { accessToken: newAccessToken };
    } catch (error: unknown) {
      throw new UnauthorizedException('Invalid refresh token', error);
    }
  }
}
