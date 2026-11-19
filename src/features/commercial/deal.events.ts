import { Injectable, Logger } from '@nestjs/common';

/**
 * Aviso de que uma proposta foi decidida (aceita, recusada, cancelada, expirada).
 * A negociação escuta para conferir a condição do desconto conjunto; fica numa
 * peça sem dependências para a proposta e o link do cliente não dependerem da
 * negociação (e vice-versa).
 */
type Listener = (companyId: number, proposalId: number) => Promise<void>;

@Injectable()
export class DealEvents {
  private readonly logger = new Logger(DealEvents.name);
  private readonly listeners: Listener[] = [];

  subscribe(listener: Listener) { this.listeners.push(listener); }

  async decided(companyId: number, proposalId: number) {
    for (const listener of this.listeners) {
      try { await listener(companyId, proposalId); } catch (error) { this.logger.error(`Negociação: falha ao conferir a proposta ${proposalId}`, error as Error); }
    }
  }
}
