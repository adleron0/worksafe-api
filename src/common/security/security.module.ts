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
    // Todo throttler listado aqui vale para TODAS as rotas ao mesmo tempo
    // (o mais restritivo manda). Antes havia 4 ("strict" de 60/min incluso),
    // então o limite real de qualquer rota era 60/min por IP. Rotas que
    // precisam de outro valor usam @Throttle({ default: ... }).
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: defaultSecurityConfig.global.windowMs,
        limit: defaultSecurityConfig.global.maxRequests,
        ignoreUserAgents: [/googlebot/gi, /bingbot/gi],
      },
      {
        // rajada: segura loops/scripts sem atrapalhar navegação normal
        name: 'burst',
        ttl: 5000,
        limit: defaultSecurityConfig.global.maxBurst,
        ignoreUserAgents: [/googlebot/gi, /bingbot/gi],
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
