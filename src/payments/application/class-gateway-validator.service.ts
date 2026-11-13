import { BadRequestException, Injectable } from '@nestjs/common';
import { paymentMethods } from '@prisma/client';
import { GatewayResolver } from '../infrastructure/gateway-resolver';
import { capabilityChecks } from '../domain/ports/gateway-capabilities';

/**
 * Valida a configuração de pagamento de uma turma contra o que o provedor
 * escolhido sabe fazer.
 *
 * A razão de existir é o momento: sem esta checagem, uma turma configurada
 * com boleto num provedor que não emite boleto só falha quando o COMPRADOR
 * tenta pagar — no pior lugar possível. Aqui o erro aparece para quem está
 * montando a turma, que é quem pode corrigir.
 */
@Injectable()
export class ClassGatewayValidator {
  constructor(private readonly gatewayResolver: GatewayResolver) {}

  private nomeAmigavel(metodo: paymentMethods): string {
    return (
      {
        [paymentMethods.pix]: 'PIX',
        [paymentMethods.boleto]: 'boleto',
        [paymentMethods.cartaoCredito]: 'cartão de crédito',
        [paymentMethods.transferencia]: 'transferência',
        [paymentMethods.dinheiro]: 'dinheiro',
      }[metodo] || metodo
    );
  }

  /**
   * Recebe o estado que a turma TERÁ depois de salva (dto mesclado ao atual),
   * porque validar só o dto deixaria passar update parcial — trocar o
   * provedor sem tocar em paymentMethods, por exemplo.
   */
  async validate(estadoFinal: {
    companyGatewayId?: number | null;
    companyId?: number | null;
    allowCheckout?: boolean;
    paymentMethods?: paymentMethods[] | null;
    dividedIn?: number | null;
  }): Promise<void> {
    // Sem provedor explícito, a turma segue o da empresa e não há o que
    // travar aqui: trocar o provedor da empresa é outra operação.
    if (!estadoFinal.companyGatewayId) return;

    const { adapter } = await this.gatewayResolver.forCourseClass({
      companyGatewayId: estadoFinal.companyGatewayId,
      companyId: estadoFinal.companyId,
    });
    const caps = adapter.capabilities;

    const metodos = estadoFinal.paymentMethods ?? [];
    const naoSuportados = metodos.filter((m) => !caps.methods.includes(m));

    if (naoSuportados.length > 0) {
      const lista = naoSuportados.map((m) => this.nomeAmigavel(m)).join(', ');
      throw new BadRequestException(
        `O provedor ${adapter.gateway} não aceita ${lista}. ` +
          `Remova esse método da turma ou escolha outro provedor.`,
      );
    }

    const parcelas = Number(estadoFinal.dividedIn || 1);
    if (parcelas > caps.maxInstallments) {
      throw new BadRequestException(
        `O provedor ${adapter.gateway} parcela em até ${caps.maxInstallments}x, ` +
          `mas a turma está configurada para ${parcelas}x.`,
      );
    }

    // Cobrança automatizada com método declarado é o caso normal. O inverso
    // — checkout ligado num provedor que não cobra — é intencional e válido:
    // o aluno se inscreve pelo site e o pagamento é combinado por fora.
    if (
      estadoFinal.allowCheckout &&
      !capabilityChecks.charges(caps) &&
      metodos.length === 0
    ) {
      throw new BadRequestException(
        `A turma tem checkout habilitado mas o provedor ${adapter.gateway} não ` +
          `gera cobrança e nenhum método de pagamento foi informado. ` +
          `Informe ao menos um método para orientar o comprador.`,
      );
    }
  }
}
