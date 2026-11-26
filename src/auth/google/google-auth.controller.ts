import { Body, Controller, ForbiddenException, Get, Logger, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { LoginAttemptsService } from 'src/common/security/login-attempts.service';
import { clientIpOf } from 'src/common/security/client-ip';
import { Public } from '../decorators/public.decorator';
import { GoogleAuthService, GoogleLoginError } from './google-auth.service';

const BIND_COOKIE = 'ws_g_bind';
const NOT_COUNTED = new Set(['estado_invalido', 'navegador_diferente']);

const maskEmail = (v: string) =>
  v.includes('@') ? v.replace(/^(.{0,2})[^@]*(@.*)$/, '$1***$2') : v;
const BIND_PATH = '/auth/google';

/** Para onde o navegador volta: fixo no .env, nunca vindo de parâmetro. */
export function frontUrl() {
  return (
    process.env.GOOGLE_AUTH_FRONT_URL ||
    process.env.FRONT_PUBLIC_URL ||
    'https://sistema.worksafebrasil.com.br'
  ).replace(/\/+$/, '');
}

const bindCookie = (maxAge: number) => ({
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: BIND_PATH,
  maxAge,
});

/**
 * Entrar com Google (OpenID Connect, code + PKCE, tudo no servidor).
 * O token da sessão nunca passa pela URL: o retorno leva só um ticket de uso
 * único, no fragmento (#), que o front troca por POST no mesmo navegador.
 */
@Controller('auth/google')
export class GoogleAuthController {
  private readonly logger = new Logger('GoogleAuth');

  constructor(
    private readonly google: GoogleAuthService,
    private readonly attempts: LoginAttemptsService,
  ) {}

  @Public()
  @Get('enabled')
  async enabled() {
    return { enabled: await this.google.enabled() };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Get('start')
  async start(@Res() res: Response) {
    try {
      const { url, binder } = await this.google.start();
      res.cookie(BIND_COOKIE, binder, bindCookie(10 * 60 * 1000));
      return res.redirect(302, url);
    } catch {
      return res.redirect(302, `${frontUrl()}/#ge=desligado`);
    }
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ip = clientIpOf(req);
    const fail = (codeErr: string) => res.redirect(302, `${frontUrl()}/#ge=${encodeURIComponent(codeErr)}`);
    if (error) return fail('cancelado');
    try {
      await this.attempts.assertAllowed('google', ip, ip);
    } catch {
      return fail('muitas_tentativas');
    }
    try {
      const { ticket } = await this.google.callback({
        code: typeof code === 'string' ? code : undefined,
        state: typeof state === 'string' ? state : undefined,
        binder: req.cookies?.[BIND_COOKIE],
      });
      return res.redirect(302, `${frontUrl()}/#gt=${ticket}`);
    } catch (e) {
      const errCode = e instanceof GoogleLoginError ? e.code : 'google_falhou';
      // e-mail recusado só no log do servidor, mascarado, nunca na URL
      this.logger.warn(`login Google recusado (${errCode}) ip=${ip} ${e instanceof GoogleLoginError ? maskEmail(e.message) : ''}`);
      // state inventado/de outro navegador qualquer um provoca: não conta, senão
      // cinco chamadas travariam o escritório inteiro atrás do mesmo IP
      if (!NOT_COUNTED.has(errCode)) {
        await this.attempts.registerFailure('google', ip, ip).catch(() => undefined);
      }
      return fail(errCode);
    }
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('exchange')
  async exchange(
    @Body() body: { ticket?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // a troca só vale vinda da página do sistema (cookie plantado por outro subdomínio)
    const origin = req.headers.origin;
    if (origin && origin !== new URL(frontUrl()).origin) {
      throw new ForbiddenException('Origem não permitida');
    }
    const ticket = typeof body?.ticket === 'string' ? body.ticket.slice(0, 200) : '';
    const result = await this.google.exchange(ticket, req.cookies?.[BIND_COOKIE], res);
    res.cookie(BIND_COOKIE, '', { ...bindCookie(0), expires: new Date(0) });
    return result;
  }
}
