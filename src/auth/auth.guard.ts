import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { PERMISSIONS_KEY } from './decorators/permissions.decorator';
import { decryptPayload } from 'src/utils/crypto';
import { PROFILE_KEY } from './decorators/profiles.decorator';
import * as Zlib from 'zlib';

const accessTokenSecret = process.env.JWT_ACCESS_SECRET;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Verifica se a rota é pública
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException('Token não encontrado');
    }

    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: accessTokenSecret,
      });
      payload = decryptPayload(payload.data);
      request['user'] = payload;
    } catch {
      throw new UnauthorizedException('Token inválido');
    }

    // Verifica as permissões
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredPermissions) {
      const userPermissionsData = payload.permissions || [];
      let userPermissionsArray;
      // Check if permissions are compressed (string) or already an array
      if (typeof userPermissionsData === 'string') {
        try {
          // Try to decompress and parse
          const userPermissions = Zlib.inflateRawSync(
            Buffer.from(userPermissionsData, 'base64'),
            {
              chunkSize: 1024 * 1024,
            },
          ).toString('utf8');
          userPermissionsArray = JSON.parse(userPermissions);
        } catch (error) {
          console.error('Error decompressing permissions:', error);
          throw new UnauthorizedException('Invalid permissions format');
        }
      } else if (Array.isArray(userPermissionsData)) {
        // Permissions are already an array
        userPermissionsArray = userPermissionsData;
      } else {
        console.error(
          'Unexpected permissions format:',
          typeof userPermissionsData,
        );
        throw new UnauthorizedException('Invalid permissions format');
      }

      const hasPermission = requiredPermissions.every((permission) =>
        userPermissionsArray.includes(permission),
      );

      if (!hasPermission) {
        throw new ForbiddenException('Acesso negado: Permissões insuficientes');
      }
    }

    // Verifica os perfis exigidos
    const requiredProfiles = this.reflector.getAllAndOverride<string[]>(
      PROFILE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredProfiles) {
      const userProfile = payload.profile;
      const hasProfile = requiredProfiles.includes(userProfile);

      if (!hasProfile) {
        throw new ForbiddenException(
          `Acesso negado: Perfil ${userProfile} não autorizado`,
        );
      }
    }

    // Opcional: passa o companyId do payload para o request
    request['companyId'] = payload.companyId;

    // Opcional: passa o profile do payload para o request
    request['profile'] = payload.profile;

    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    if (!authHeader) return undefined;

    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
