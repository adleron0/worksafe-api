import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from 'src/auth/decorators/public.decorator';

/**
 * Verificação de saúde do Railway: o deploy novo só recebe tráfego depois de
 * responder aqui. Sem isso, a cada deploy a API recusava conexões por alguns
 * segundos (aconteceu na volta do login com Google, 26/11/2026).
 */
@Controller('health')
export class HealthController {
  @Public()
  @SkipThrottle()
  @Get()
  ok() {
    return { ok: true };
  }
}
