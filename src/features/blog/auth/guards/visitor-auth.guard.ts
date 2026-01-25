import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class VisitorAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Token de visitante não fornecido');
    }

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_VISITOR_SECRET || process.env.JWT_ACCESS_SECRET,
      });

      // Verifica se é um token de visitante
      if (payload.type !== 'visitor') {
        throw new UnauthorizedException('Token inválido para visitante');
      }

      // Adiciona o visitante ao request
      request['visitor'] = payload;
    } catch {
      throw new UnauthorizedException('Token de visitante inválido');
    }

    return true;
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
