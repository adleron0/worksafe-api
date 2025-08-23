import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { gateways } from '@prisma/client';
import { CheckoutService } from '../checkout/checkout.service';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
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

      // Processa o webhook de acordo com o gateway
      if (gateway === 'asaas') {
        await this.processAsaasWebhook(payload, companyId);
      }
      // Adicionar outros gateways conforme necessário

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
      return {
        success: false,
        message: 'Webhook registrado com erro',
        error: error.message,
      };
    }
  }

  /**
   * Processa webhook do Asaas
   */
  private async processAsaasWebhook(payload: any, companyId: number) {
    try {
      // Verifica se é um evento de pagamento
      if (payload.event && payload.event.startsWith('PAYMENT_')) {
        await this.checkoutService.processPaymentWebhook(payload, companyId);
      }
    } catch (error) {
      console.error('Erro ao processar webhook Asaas:', error);
      throw error;
    }
  }
}