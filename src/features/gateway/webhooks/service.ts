import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { gateways } from '@prisma/client';
import { CheckoutService } from '../checkout/checkout.service';
import { GatewayResolver } from 'src/payments/infrastructure/gateway-resolver';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gatewayResolver: GatewayResolver,
    @Inject(forwardRef(() => CheckoutService))
    private readonly checkoutService: CheckoutService,
  ) {}

  async registerWebhook(
    gateway: string,
    companyId: number,
    payload: any,
  ): Promise<any> {
    try {
      // Registra o webhook no banco
      const webhook = await this.prisma.webhooks.create({
        data: {
          companyId,
          gateway: gateway as gateways,
          payload,
          error: null,
          processedAt: null,
        },
      });

      // O dispatch deixou de ser `if (gateway === 'asaas')`: qualquer gateway
      // com adapter registrado é processado. Somar um fornecedor não toca
      // este arquivo.
      if (this.gatewayResolver.supports(gateway as gateways)) {
        await this.processPaymentEvent(payload, companyId, gateway as gateways);
      } else {
        console.log(
          `Gateway ${gateway} sem adapter registrado — webhook apenas armazenado`,
        );
      }

      // Marca o webhook como processado
      await this.prisma.webhooks.update({
        where: { id: webhook.id },
        data: { processedAt: new Date() },
      });

      return {
        success: true,
        webhookId: webhook.id,
        message: 'Webhook processado com sucesso',
      };
    } catch (error) {
      // Registra o erro
      await this.prisma.webhooks.create({
        data: {
          companyId,
          gateway: gateway as gateways,
          payload,
          error: error.message || error,
          processedAt: new Date(),
        },
      });

      console.error('Erro ao processar webhook:', error);

      // ATENÇÃO (R2): continua respondendo sucesso de propósito. O webhook do
      // Asaas é registrado com sendType SEQUENTIALLY — devolver não-2xx faz o
      // gateway INTERROMPER a fila e parar de entregar todos os eventos
      // seguintes, o que deixaria pagamentos legítimos sem confirmação.
      // Endurecer isto exige antes retry interno + reconciliação (fase 3).
      return {
        success: false,
        message: 'Webhook registrado com erro',
        error: error.message,
      };
    }
  }

  /** Encaminha eventos de pagamento; outros eventos são só armazenados. */
  private async processPaymentEvent(
    payload: any,
    companyId: number,
    gateway: gateways,
  ) {
    if (payload?.event && String(payload.event).startsWith('PAYMENT_')) {
      await this.checkoutService.processPaymentWebhook(
        payload,
        companyId,
        gateway,
      );
    }
  }
}
