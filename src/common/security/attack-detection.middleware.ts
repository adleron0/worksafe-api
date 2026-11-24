import { clientIpOf } from './client-ip';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { SecurityService } from './security.service';

@Injectable()
export class AttackDetectionMiddleware implements NestMiddleware {
  constructor(private readonly securityService: SecurityService) {}

  use(req: Request, res: Response, next: NextFunction) {
    // Registra e verifica a requisição
    const { allowed, reason } = this.securityService.logRequest(req);

    if (!allowed) {
      // Log detalhado do bloqueio
      console.error(`🚫 REQUISIÇÃO BLOQUEADA:`, {
        ip: clientIpOf(req),
        url: req.url,
        method: req.method,
        reason,
        timestamp: new Date().toISOString(),
      });

      // Responde com erro 429 (Too Many Requests) ou 403 (Forbidden)
      const statusCode =
        reason?.includes('taxa') || reason?.includes('DDoS') ? 429 : 403;

      return res.status(statusCode).json({
        statusCode,
        message: reason || 'Acesso negado',
        error: 'Forbidden',
        retryAfter: statusCode === 429 ? 60 : undefined, // 1 minuto para retry se for rate limit
      });
    }

    // Registra erros de resposta para permitir retentativas
    res.on('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500) {
        this.securityService.registerFailedRequest(req);
      }
    });

    // Se permitido, continua
    next();
  }
}
