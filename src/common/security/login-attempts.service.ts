import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import { CacheService } from 'src/common/cache/cache.service';
import { SecurityService } from './security.service';

/**
 * Tentativas de login erradas, guardadas no Redis (sobrevivem ao restart).
 *
 * - Por conta + IP: depois de 5 erros, espera progressiva (30 s, 1, 2, 4 ... até 15 min).
 *   Só trava quem está errando daquele IP — um atacante em outro lugar não tranca o
 *   dono da conta para fora.
 * - Por conta, de qualquer IP: 30 erros em 1 h travam a conta por 15 min (ataque
 *   distribuído, vários IPs na mesma senha).
 * - Por IP, em qualquer conta: 30 erros em 15 min bloqueiam o IP (varredura de senhas).
 *
 * Se o Redis cair, o login segue funcionando (só sem esta trava); o limite de
 * 10/min por IP do ThrottlerGuard continua valendo.
 */
const FREE_FAILS = 5;
const BASE_WAIT_S = 30;
const MAX_WAIT_S = 15 * 60;
const PAIR_WINDOW_S = 60 * 60;
const ACCOUNT_LIMIT = 30;
const ACCOUNT_WINDOW_S = 60 * 60;
const ACCOUNT_LOCK_S = 15 * 60;
const IP_LIMIT = 30;
const IP_WINDOW_S = 15 * 60;
const IP_BLOCK_MS = 60 * 60 * 1000;

@Injectable()
export class LoginAttemptsService {
  constructor(
    @Optional() private readonly cache?: CacheService,
    @Optional() private readonly security?: SecurityService,
  ) {}

  private norm(account: string): string {
    return String(account ?? '')
      .trim()
      .toLowerCase()
      .slice(0, 200);
  }

  private keys(scope: string, ip: string, account: string) {
    const a = this.norm(account);
    return {
      pairFails: `sec:login:${scope}:pf:${ip}:${a}`,
      pairLock: `sec:login:${scope}:pl:${ip}:${a}`,
      accFails: `sec:login:${scope}:af:${a}`,
      accLock: `sec:login:${scope}:al:${a}`,
      ipFails: `sec:login:ipf:${ip}`,
    };
  }

  private tooMany(seconds: number): never {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: `Muitas tentativas de acesso. Tente de novo em ${minutes} minuto${minutes > 1 ? 's' : ''}.`,
        retryAfter: seconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Antes de conferir a senha: recusa (429) se a conta/IP estiver em espera. */
  async assertAllowed(
    scope: string,
    ip: string,
    account: string,
  ): Promise<void> {
    if (!this.cache) return;
    const k = this.keys(scope, ip, account);
    try {
      const [pair, acc] = await Promise.all([
        this.cache.ttl(k.pairLock),
        this.cache.ttl(k.accLock),
      ]);
      const wait = Math.max(pair, acc);
      if (wait > 0) this.tooMany(wait);
    } catch (e) {
      if (e instanceof HttpException) throw e;
    }
  }

  /** Senha errada (ou conta inexistente — mesma resposta para não revelar quem existe). */
  async registerFailure(
    scope: string,
    ip: string,
    account: string,
  ): Promise<void> {
    if (!this.cache) return;
    const k = this.keys(scope, ip, account);
    try {
      const pair = await this.cache.increment(k.pairFails, PAIR_WINDOW_S);
      if (pair >= FREE_FAILS) {
        const wait = Math.min(
          MAX_WAIT_S,
          BASE_WAIT_S * 2 ** (pair - FREE_FAILS),
        );
        await this.cache.set(k.pairLock, 1, wait);
      }
      const acc = await this.cache.increment(k.accFails, ACCOUNT_WINDOW_S);
      if (acc >= ACCOUNT_LIMIT) {
        await this.cache.set(k.accLock, 1, ACCOUNT_LOCK_S);
        console.error(
          `🚨 LOGIN: conta "${this.norm(account)}" com ${acc} senhas erradas em 1 h — travada por 15 min`,
        );
        this.security?.recordEvent(
          'login-conta-travada',
          ip,
          this.norm(account),
        );
      }
      const byIp = await this.cache.increment(k.ipFails, IP_WINDOW_S);
      if (byIp >= IP_LIMIT && this.security) {
        this.security.blockIp(
          ip,
          IP_BLOCK_MS,
          `varredura de senhas (${byIp} erros em 15 min)`,
        );
      }
    } catch {
      // Redis fora: segue sem a trava
    }
  }

  async registerSuccess(
    scope: string,
    ip: string,
    account: string,
  ): Promise<void> {
    if (!this.cache) return;
    const k = this.keys(scope, ip, account);
    try {
      await Promise.all([
        this.cache.del(k.pairFails),
        this.cache.del(k.pairLock),
      ]);
    } catch {
      // ignora
    }
  }
}
