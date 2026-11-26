import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../decorators/public.decorator';
import { AccessAdminService } from './access-admin.service';
import { GoogleAuthService } from './google-auth.service';
import { PendingAuthGuard } from './pending.guard';

/**
 * Tela enxuta de quem entrou com o Google do domínio e não tem perfil:
 * ver o próprio pedido, pedir perfil e entrar quando aprovado. Nada mais.
 */
@Controller('auth/access-request')
@Public()
@UseGuards(PendingAuthGuard)
export class AccessRequestController {
  constructor(
    private readonly access: AccessAdminService,
    private readonly google: GoogleAuthService,
  ) {}

  @Get('me')
  me(@Req() req: any) {
    return this.access.myRequest(req.pendingUser.sub);
  }

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
  request(@Req() req: any, @Body() body: { message?: string }) {
    return this.access.createRequest(req.pendingUser.sub, body?.message);
  }

  /** Aprovado: troca o pendente pela sessão normal (o usuário é revalidado no banco). */
  @Post('enter')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  enter(@Req() req: any, @Res({ passthrough: true }) res: Response) {
    return this.google.enterOrPending(req.pendingUser.sub, res, { pendingJti: req.pendingUser.jti });
  }
}
