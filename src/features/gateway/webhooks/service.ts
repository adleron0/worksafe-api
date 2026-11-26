import { gatewayScope } from 'src/payments/gateway-scope';
import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
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

  /**
   * Autenticação do webhook pelo header `asaas-access-token`.
   *
   * Token esperado: `payload.webhookToken` do CompanyGateWays ativo da
   * empresa (o GatewayCredentialsService gera e registra no Asaas como
   * authToken ao salvar o gateway), com fallback no env ASAAS_WEBHOOK_TOKEN.
   *
   * Sem token configurado (nem da empresa nem global) o evento é RECUSADO:
   * aceitar deixava qualquer um forjar PAYMENT_CONFIRMED. Idem para empresa
   * sem gateway Asaas ativo — não há o que confirmar lá.
   *
   * Válvula de emergência: `WEBHOOK_REQUIRE_TOKEN=false` volta ao modo de
   * transição (aceita, com alerta, quando não há token). Existe porque o
   * Asaas envia em sendType SEQUENTIALLY e um não-2xx INTERROMPE a fila
   * inteira: se a produção ainda não tiver o token, recusar pararia todos os
   * pagamentos. Padrão: exigir.
   */
  async verifyWebhookToken(
    gateway: string,
    companyId: number,
    received: string | undefined,
  ): Promise<boolean> {
    if (gateway !== 'asaas') return false;
    if (!Number.isInteger(companyId) || companyId <= 0) return false;

    const requireToken =
      String(process.env.WEBHOOK_REQUIRE_TOKEN ?? 'true').toLowerCase() !==
      'false';

    const companyGateway = await this.prisma.companyGateWays.findFirst({
      where: { companyId, gateway: 'asaas', active: true },
    });
    if (!companyGateway && requireToken) {
      console.warn(
        `[webhook] empresa ${companyId} sem gateway Asaas ativo — evento recusado.`,
      );
      return false;
    }

    // Vários CNPJs com conta Asaas própria: cada conta tem o seu token. O que
    // bater diz de qual conta é o evento, e o processamento usa a chave dela.
    if (received) {
      const all = await this.prisma.companyGateWays.findMany({ where: { companyId, gateway: 'asaas', active: true } });
      if (all.length > 1) {
        for (const config of all) {
          const token = (config.payload as any)?.webhookToken;
          if (!token) continue;
          const x = Buffer.from(received);
          const y = Buffer.from(String(token));
          if (x.length === y.length && timingSafeEqual(x, y)) {
            gatewayScope.enter({ companyGatewayId: config.id });
            return true;
          }
        }
      }
    }

    const expected: string | undefined =
      (companyGateway?.payload as any)?.webhookToken ||
      process.env.ASAAS_WEBHOOK_TOKEN;
    if (!expected) {
      if (!requireToken) {
        console.warn(
          `[webhook] empresa ${companyId} sem webhookToken — aceito porque WEBHOOK_REQUIRE_TOKEN=false. ` +
            'Salve de novo a integração Asaas no sistema para gerar e registrar o token.',
        );
        return true;
      }
      console.error(
        `[webhook] empresa ${companyId} sem webhookToken nem ASAAS_WEBHOOK_TOKEN — evento recusado. ` +
          'Salve de novo a integração Asaas no sistema para gerar e registrar o token.',
      );
      return false;
    }
    if (!received) return false;

    const a = Buffer.from(received);
    const b = Buffer.from(String(expected));
    return a.length === b.length && timingSafeEqual(a, b);
  }

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
