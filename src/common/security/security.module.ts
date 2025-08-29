import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { SecurityService } from './security.service';
import { AttackDetectionMiddleware } from './attack-detection.middleware';
import { SecurityGuard } from './security.guard';

@Module({
  imports: [
    // Configuração global de rate limiting
    ThrottlerModule.forRoot([
      {
        // Rate limit padrão: 100 requests por minuto
        ttl: 60000,
        limit: 100,
        ignoreUserAgents: [
          // Ignora bots conhecidos se necessário
          /googlebot/gi,
          /bingbot/gi,
        ],
      },
      {
        // Rate limit mais restritivo para rotas sensíveis
        name: 'strict',
        ttl: 60000,
        limit: 10,
      },
      {
        // Rate limit para rotas públicas (mais permissivo)
        name: 'public',
        ttl: 60000,
        limit: 200,
      },
    ]),
  ],
  providers: [
    SecurityService,
    AttackDetectionMiddleware,
    SecurityGuard,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
  exports: [SecurityService, AttackDetectionMiddleware],
})
export class SecurityModule {}