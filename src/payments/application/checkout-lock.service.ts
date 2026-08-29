import { Injectable } from '@nestjs/common';
import { CacheService } from 'src/common/cache/cache.service';

/**
 * Serializa tentativas de checkout concorrentes do mesmo comprador na mesma
 * turma.
 *
 * Por que existe: o fluxo de inscrição faz check-then-act — consulta se já
 * existe inscrição para (cpf, classId) e só então cria — sem transação e sem
 * constraint única no banco. Duas requisições em voo ao mesmo tempo passam
 * as duas pela checagem e geram DUAS cobranças no gateway. Um duplo clique
 * no botão de pagar bastava para cobrar em dobro.
 *
 * Por que um lock no Redis e não uma constraint: adicionar @@unique(cpf,
 * classId) é a correção definitiva, mas exige migração sobre dados vivos que
 * podem já conter duplicatas históricas — precisa de limpeza antes. E um
 * advisory lock do Postgres via Prisma esbarra no pool de conexões, porque o
 * unlock precisa cair na mesma conexão. O Redis já é dependência obrigatória
 * da aplicação e resolve os dois problemas.
 *
 * O lock é deliberadamente curto e expira sozinho: se o processo morrer no
 * meio, o comprador consegue tentar de novo em segundos em vez de ficar
 * travado.
 */
@Injectable()
export class CheckoutLockService {
  private static readonly TTL_SECONDS = 30;

  constructor(private readonly cache: CacheService) {}

  private key(classId: number, cpf: string): string {
    const cleanCpf = String(cpf || '').replace(/\D/g, '');
    return `checkout:lock:${classId}:${cleanCpf}`;
  }

  /**
   * Executa `fn` com exclusividade para o par (turma, cpf).
   *
   * Usa INCR como mutex: só o primeiro a incrementar recebe 1. Se o Redis
   * estiver indisponível, a operação segue sem lock — indisponibilidade de
   * cache não pode impedir uma venda, e o risco volta a ser o de antes, não
   * pior.
   */
  async runExclusive<T>(
    classId: number,
    cpf: string,
    fn: () => Promise<T>,
    onBusy: () => T | Promise<T>,
  ): Promise<T> {
    const key = this.key(classId, cpf);
    let holders: number;

    // O try cobre SOMENTE a aquisição. Envolver mais do que isso faria o
    // catch de indisponibilidade do Redis engolir a rejeição legítima do
    // lock e reexecutar o fluxo sem exclusividade — ou seja, cobrando duas
    // vezes justamente no caso que este serviço existe para evitar.
    try {
      holders = await this.cache.increment(
        key,
        CheckoutLockService.TTL_SECONDS,
      );
    } catch (error) {
      console.error('Lock de checkout indisponível, seguindo sem ele:', error);
      return fn();
    }

    if (holders !== 1) {
      console.warn(
        `Checkout concorrente detectado para turma ${classId} — segunda tentativa recusada`,
      );
      return onBusy();
    }

    try {
      return await fn();
    } finally {
      try {
        await this.cache.del(key);
      } catch {
        /* o TTL cobre a liberação */
      }
    }
  }
}
