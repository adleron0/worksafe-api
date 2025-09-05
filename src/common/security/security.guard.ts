import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Throttle } from '@nestjs/throttler';

@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Adiciona headers de segurança
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('X-XSS-Protection', '1; mode=block');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    return true;
  }
}

// Decorator personalizado para rate limit estrito
export function StrictRateLimit() {
  return Throttle({ strict: { limit: 10, ttl: 60000 } });
}

// Decorator para rotas públicas com rate limit mais permissivo
export function PublicRateLimit() {
  return Throttle({ public: { limit: 200, ttl: 60000 } });
}
