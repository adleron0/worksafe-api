import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { SecurityService } from './security.service';
import { AttackDetectionMiddleware } from './attack-detection.middleware';
import { SecurityGuard } from './security.guard';
import { CustomThrottlerGuard } from './custom-throttler.guard';
import { defaultSecurityConfig } from './security.config';

@Module({
  imports: [
    // Configuração global de rate limiting
    ThrottlerModule.forRoot([
      {
        // Rate limit padrão - pega do config centralizado
        ttl: defaultSecurityConfig.global.windowMs,
        limit: defaultSecurityConfig.global.maxRequests,
        ignoreUserAgents: [
          // Ignora bots conhecidos se necessário
          /googlebot/gi,
          /bingbot/gi,
        ],
      },
      {
        // Rate limit mais restritivo para rotas sensíveis
        name: 'strict',
        ttl: defaultSecurityConfig.endpoints['/auth']?.windowMs || 60000,
        limit: defaultSecurityConfig.endpoints['/auth']?.maxRequests || 10,
      },
      {
        // Rate limit para rotas públicas (mais permissivo)
        name: 'public',
        ttl: defaultSecurityConfig.endpoints['/api']?.windowMs || 60000,
        limit: defaultSecurityConfig.endpoints['/api']?.maxRequests || 300,
      },
      {
        // Rate limit para rotas de listagem/consulta intensiva
        name: 'data-intensive',
        ttl: 60000,
        limit: 500,
      },
    ]),
  ],
  providers: [
    SecurityService,
    AttackDetectionMiddleware,
    SecurityGuard,
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard, // Usando o guard customizado
    },
  ],
  exports: [SecurityService, AttackDetectionMiddleware],
})
export class SecurityModule {}
