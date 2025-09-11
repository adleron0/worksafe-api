import {
  Injectable,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { defaultSecurityConfig } from './security.config';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  // Centraliza a configuração de rate limit
  private readonly DEFAULT_LIMIT = defaultSecurityConfig.global.maxRequests;
  private readonly DEFAULT_TTL = defaultSecurityConfig.global.windowMs;
  private readonly DEFAULT_BURST = defaultSecurityConfig.global.maxBurst;
  private readonly BURST_WINDOW = 5000; // 5 segundos para cálculo de burst
  /**
   * Obtém o tracker (identificador) para rate limiting.
   * Por padrão usa o IP, mas pode ser customizado para usar:
   * - IP + User ID (para rate limit por usuário)
   * - Apenas User ID
   * - API Key
   * - etc.
   */
  protected async getTracker(req: Request): Promise<string> {
    // Pega o IP real considerando proxies (X-Forwarded-For, X-Real-IP, etc)
    const forwardedFor = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];

    let clientIp: string;

    if (forwardedFor) {
      // X-Forwarded-For pode conter múltiplos IPs, pega o primeiro
      clientIp = (forwardedFor as string).split(',')[0].trim();
    } else if (realIp) {
      clientIp = realIp as string;
    } else {
      // Fallback para o IP direto da conexão
      clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    }

    // Opcional: Combinar com user ID para rate limit por usuário + IP
    // const userId = req.user?.id;
    // if (userId) {
    //   return `${clientIp}-user-${userId}`;
    // }

    return clientIp;
  }

  /**
   * Mensagem de erro customizada com informações úteis para o frontend
   */
  protected async throwThrottlingException(
    context: ExecutionContext,
  ): Promise<void> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse();

    // Calcula o tempo de espera sugerido (em segundos)
    const retryAfter = Math.ceil(this.DEFAULT_TTL / 1000); // Converte ms para segundos
    const burstPerSecond = Math.floor(
      this.DEFAULT_BURST / (this.BURST_WINDOW / 1000),
    );

    // Define o header Retry-After (padrão HTTP para rate limiting)
    response.setHeader('Retry-After', retryAfter);
    response.setHeader('X-RateLimit-Limit', String(this.DEFAULT_LIMIT));
    response.setHeader('X-RateLimit-Burst', String(burstPerSecond));
    response.setHeader('X-RateLimit-Remaining', '0');
    response.setHeader(
      'X-RateLimit-Reset',
      new Date(Date.now() + retryAfter * 1000).toISOString(),
    );

    // Lança uma exceção HTTP com status 429 (Too Many Requests)
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: 'Você excedeu o limite de requisições permitidas.',
        details: {
          limits: {
            perMinute: this.DEFAULT_LIMIT,
            perSecond: burstPerSecond,
            burstLimit: this.DEFAULT_BURST,
            burstWindow: this.BURST_WINDOW,
          },
          windowMs: this.DEFAULT_TTL,
          retryAfter: retryAfter,
          retryAt: new Date(Date.now() + retryAfter * 1000).toISOString(),
          suggestion: `Limite: ${this.DEFAULT_LIMIT} req/min ou ${burstPerSecond} req/seg. Aguarde ${retryAfter} segundos.`,
        },
        timestamp: new Date().toISOString(),
        path: request.url,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
