import { Injectable } from '@nestjs/common';
import { gateways } from '@prisma/client';
import { AsaasService } from './asaas/asaas.service';

@Injectable()
export class GatewayFactory {
  constructor(private readonly asaasService: AsaasService) {}

  /**
   * Configura webhook para o gateway especificado
   */
  async configureWebhook(
    gateway: gateways,
    companyId: number,
    webhookId?: string,
  ): Promise<any> {
    // Método específico para cada gateway
    switch (gateway) {
      case gateways.asaas:
        return await this.asaasService.configureWebhooks(companyId, webhookId);

      // Futuros gateways podem ser adicionados aqui
      case gateways.stripe:
      case gateways.efi:
      case gateways.mercadoPago:
      case gateways.pagSeguro:
      case gateways.paypal:
        throw new Error(`Gateway ${gateway} ainda não está implementado`);

      default:
        throw new Error(`Gateway ${gateway} não reconhecido`);
    }
  }

  /**
   * Processa webhook do gateway especificado
   */
  async processWebhook(
    gateway: gateways,
    webhookData: any,
    companyId: number,
  ): Promise<any> {
    switch (gateway) {
      case gateways.asaas:
        return await this.asaasService.processWebhook(webhookData, companyId);

      // Futuros gateways
      default:
        throw new Error(
          `Processamento de webhook para ${gateway} não implementado`,
        );
    }
  }

  /**
   * Valida configuração do gateway
   */
  validateGatewayConfig(gateway: gateways, config: any): boolean {
    switch (gateway) {
      case gateways.asaas:
        return config && config.token && typeof config.token === 'string';

      case gateways.stripe:
        return (
          config && config.secretKey && typeof config.secretKey === 'string'
        );

      // Adicionar validações para outros gateways conforme necessário
      default:
        return false;
    }
  }
}
