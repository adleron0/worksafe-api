import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/features/prisma/prisma.service';
import { UserService } from 'src/features/user/service';
import { compare } from 'bcrypt';
import { encryptPayload } from 'src/utils/crypto';
import * as Zlib from 'zlib';

const accessTokenSecret = process.env.JWT_ACCESS_SECRET;
const refreshTokenSecret = process.env.JWT_REFRESH_SECRET;
const baseSetup = process.env.BASE_SETUP;
const domain = process.env.PROD_DOMAIN;

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UserService,
    private prisma: PrismaService,
  ) {}

  async login(user: any, response: any) {
    const { email, password, cnpj } = user;
    const result = await this.usersService.findOneUser(email, cnpj);

    if (!result) {
      throw new UnauthorizedException('Dados de acesso incorretos!');
    }
    if (!result.active) {
      throw new UnauthorizedException('Acesso negado para este usuário!');
    }

    const isPasswordCorrect = await compare(password, result.password);
    if (!isPasswordCorrect) {
      throw new UnauthorizedException('Dados de acesso incorretos!');
    }

    // Verificar se o usuário tem uma profile associada
    if (!result.profile) {
      throw new UnauthorizedException('Usuário sem permissão para acessar!');
    }

    // Verifica se empresa está ativa
    if (!result.company.active) {
      throw new UnauthorizedException('Empresa inativa!');
    }

    // Obter os produtos da empresa
    const products = result.company.products;
    const productNames = products.map((p) => p.product.name);

    // Obter a Profile do usuário
    const userProfile = result.profile;

    // Obter as permissões individuais do usuário
    const userPermissions =
      result.permissions?.map((up) => up.permission.name) || [];

    // Obter as permissões da Profile
    const profilePermissions =
      userProfile.permissions?.map((rp) => rp.permission.name) || [];

    // Combinar as permissões e remover duplicadas
    const allPermissions = [
      ...new Set([...userPermissions, ...profilePermissions]),
    ];

    const compactPermissions = Zlib.deflateRawSync(
      JSON.stringify(allPermissions),
      {
        level: 9,
      },
    ).toString('base64');

    // Montar o payload do token
    const payload = {
      username: result.name,
      imageUrl: result.imageUrl,
      sub: result.id,
      companyId: result.companyId,
      products: productNames,
      profile: userProfile.name,
      permissions: compactPermissions,
    };

    // Gerar os tokens
    const accessToken = this.getAccessToken({
      data: encryptPayload(payload),
    });
    const refreshToken = this.getRefreshToken({ sub: result.id });

    // Salvar o refreshToken no banco de dados
    await this.prisma.session.create({
      data: {
        userId: result.id,
        sessionToken: refreshToken,
        expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 dias
      },
    });

    // Enviar o refreshToken como HttpOnly cookie
    response.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: baseSetup === 'development' ? 'none' : 'Lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
      path: '/',
      ...(baseSetup === 'development'
        ? {
            domain: 'localhost',
          }
        : {
            domain: domain,
          }),
    });

    // Salvar log de login
    await this.prisma.system_Logs.create({
      data: {
        companyId: result.companyId,
        userId: result.id,
        action: 'login',
        entity: 'user',
        entityId: result.id,
        column: null,
        oldValue: null,
        newValue: null,
      },
    });

    // Retornar apenas o accessToken na resposta
    return { accessToken };
  }

  getAccessToken(payload: any) {
    return this.jwtService.sign(payload, {
      secret: accessTokenSecret,
      expiresIn: '60m',
      // expiresIn: '1m',
    });
  }

  getRefreshToken(payload: any) {
    return this.jwtService.sign(payload, {
      secret: refreshTokenSecret,
      expiresIn: '7d',
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

    // Sobrescreve o cookie do refreshToken para removê-lo no lado do cliente
    response.cookie('refreshToken', '', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      expires: new Date(0),
      path: '/',
    });
  }

  async refreshToken(refreshToken: string) {
    try {
      const verifyRefresh = this.jwtService.verify(refreshToken, {
        secret: refreshTokenSecret,
      });

      // Verificar se o refreshToken está ativo
      const refreshTokenResult = await this.prisma.session.findUnique({
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

      if (!refreshTokenResult || refreshTokenResult.inactiveAt) {
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

      // Obter produtos da empresa
      const products = user.company.products;
      const productNames = products.map((p) => p.product.name);

      // Obter a Profile do usuário
      const userProfile = user.profile;

      // Obter as permissões individuais do usuário
      const userPermissions =
        user.permissions?.map((up) => up.permission.name) || [];

      // Obter as permissões da profile
      const profilePermissions =
        userProfile.permissions?.map((rp) => rp.permission.name) || [];

      // Combinar as permissões e remover duplicadas
      const allPermissions = [
        ...new Set([...userPermissions, ...profilePermissions]),
      ];

      const compactPermissions = Zlib.deflateRawSync(
        JSON.stringify(allPermissions),
        {
          level: 9,
        },
      ).toString('base64');

      // Montar o payload do token
      const payload = {
        username: user.name,
        sub: user.id,
        imageUrl: user.imageUrl,
        companyId: user.companyId,
        products: productNames,
        profile: userProfile.name,
        permissions: compactPermissions,
      };

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
