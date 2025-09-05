import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
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
   * Mensagem de erro customizada
   */
  protected async throwThrottlingException(
    context: ExecutionContext,
  ): Promise<void> {
    throw new Error(
      'Muitas requisições. Por favor, aguarde um momento antes de tentar novamente.',
    );
  }
}
