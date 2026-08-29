import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { gateways } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentGatewayPort } from 'src/payments/domain/ports/payment-gateway.port';
import { AsaasAdapter } from './adapters/asaas/asaas.adapter';

/**
 * Resolve qual gateway atende uma empresa e devolve o adapter correspondente.
 *
 * Substitui a GatewayFactory, que tinha o switch certo mas nunca era chamada
 * pelo checkout — o orquestrador falava direto com o AsaasService.
 */
@Injectable()
export class GatewayResolver {
  private readonly adapters: Map<gateways, PaymentGatewayPort>;

  constructor(
    private readonly prisma: PrismaService,
    asaasAdapter: AsaasAdapter,
  ) {
    // Registrar um gateway novo é adicionar uma linha aqui.
    this.adapters = new Map<gateways, PaymentGatewayPort>([
      [gateways.asaas, asaasAdapter],
    ]);
  }

  /** Adapter por nome, sem consultar o banco. Usado por webhook e configuração. */
  byName(gateway: gateways): PaymentGatewayPort {
    const adapter = this.adapters.get(gateway);
    if (!adapter) {
      throw new HttpException(
        `Gateway ${gateway} ainda não está implementado`,
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    return adapter;
  }

  supports(gateway: gateways): boolean {
    return this.adapters.has(gateway);
  }

  /**
   * Gateway ativo da empresa.
   *
   * Desempate explícito (risco R5 do plano): com mais de um gateway ativo — o
   * cenário de uma migração, com o antigo e o novo convivendo — a escolha
   * antes dependia da ordem que o banco devolvesse. Aqui é sempre o mais
   * recente entre os implementados, e o critério fica registrado.
   */
  async forCompany(
    companyId: number,
  ): Promise<{ adapter: PaymentGatewayPort; record: any }> {
    const active = await this.prisma.select('companyGateWays', {
      where: { companyId, active: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!active || active.length === 0) {
      throw new HttpException(
        'Nenhum gateway de pagamento configurado para esta empresa',
        HttpStatus.NOT_FOUND,
      );
    }

    const usable = active.find((g: any) => this.supports(g.gateway));

    if (!usable) {
      throw new HttpException(
        `Gateway ${active[0].gateway} ainda não está implementado`,
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    return { adapter: this.byName(usable.gateway), record: usable };
  }
}
