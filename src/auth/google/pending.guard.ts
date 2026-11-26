import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PENDING_AUDIENCE, pendingSecret } from './google-auth.service';

/**
 * Só o token de "pendente" (quem entrou com o Google e ainda não tem perfil).
 * Ele não serve para nenhuma outra rota: o AuthGuard normal usa outro segredo.
 */
@Injectable()
export class PendingAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const [type, token] = String(req.headers?.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Token não encontrado');
    try {
      const payload: any = await this.jwt.verifyAsync(token, {
        secret: pendingSecret(),
        audience: PENDING_AUDIENCE,
      });
      if (payload?.typ !== 'pending' || !payload.sub || !payload.jti) throw new Error('tipo');
      req.pendingUser = { sub: Number(payload.sub), companyId: Number(payload.companyId), jti: String(payload.jti) };
      return true;
    } catch {
      throw new UnauthorizedException('Sessão de acesso expirada. Entre com o Google de novo.');
    }
  }
}
