import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { gateways } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentGatewayPort } from 'src/payments/domain/ports/payment-gateway.port';
import { AsaasAdapter } from './adapters/asaas/asaas.adapter';
import { ManualAdapter } from './adapters/manual/manual.adapter';

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
    manualAdapter: ManualAdapter,
  ) {
    // Registrar um gateway novo é adicionar uma linha aqui.
    this.adapters = new Map<gateways, PaymentGatewayPort>([
      [gateways.asaas, asaasAdapter],
      [gateways.manual, manualAdapter],
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
   * Provedor de uma TURMA.
   *
   * Precedência: a configuração escolhida na turma vence; sem ela, cai no
   * provedor ativo da empresa. É isso que permite migrar de provedor uma
   * turma por vez, ou deixar turmas de baixo valor num provedor mais barato
   * enquanto as que precisam de boleto seguem no outro.
   *
   * A configuração da turma é respeitada mesmo se estiver inativa — desligar
   * um provedor não pode redirecionar silenciosamente cobranças de turmas que
   * o escolheram de propósito; melhor falhar e ser corrigido.
   */
  async forCourseClass(
    courseClass: { companyGatewayId?: number | null; companyId?: number | null; entityId?: number | null },
  ): Promise<{ adapter: PaymentGatewayPort; record: any }> {
    if (!courseClass.companyGatewayId) {
      // sem escolha na turma: a conta do CNPJ da turma (cada CNPJ tem a sua)
      return this.forCompany(courseClass.companyId, courseClass.entityId);
    }

    const escolhido = await this.prisma.selectFirst('companyGateWays', {
      where: { id: courseClass.companyGatewayId },
    });

    if (!escolhido) {
      throw new HttpException(
        'O provedor de pagamento configurado para esta turma não existe mais',
        HttpStatus.NOT_FOUND,
      );
    }

    if (!this.supports(escolhido.gateway)) {
      throw new HttpException(
        `Gateway ${escolhido.gateway} ainda não está implementado`,
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    return { adapter: this.byName(escolhido.gateway), record: escolhido };
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
    entityId?: number | null,
  ): Promise<{ adapter: PaymentGatewayPort; record: any }> {
    const found = await this.prisma.select('companyGateWays', {
      where: { companyId, active: true },
      orderBy: { createdAt: 'desc' },
    });
    // a do CNPJ pedido primeiro; depois as sem CNPJ; por último as de outro CNPJ
    const rank = (g: any) => (entityId && g.entityId === entityId ? 0 : !g.entityId ? 1 : 2);
    const active = [...(found ?? [])].sort((a: any, b: any) => rank(a) - rank(b));

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
