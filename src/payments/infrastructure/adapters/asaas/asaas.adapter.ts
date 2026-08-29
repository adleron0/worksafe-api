import { Injectable } from '@nestjs/common';
import { paymentMethods, gateways } from '@prisma/client';
import { AsaasService } from 'src/common/gateways/asaas/asaas.service';
import { CacheService } from 'src/common/cache/cache.service';
import {
  SellerIdentity,
  SubAccountCapablePort,
  SubAccountResult,
} from 'src/payments/domain/ports/subaccount-capable.port';
import {
  CreatePaymentInput,
  CustomerData,
  GatewayCapabilities,
  GatewayPayment,
  PaymentGatewayPort,
  UpdatePaymentInput,
} from 'src/payments/domain/ports/payment-gateway.port';

/**
 * Adapter do Asaas.
 *
 * Nesta fase ele DELEGA ao AsaasService existente em vez de reescrevê-lo: a
 * troca é de indireção, não de lógica, para que o comportamento observado
 * pelos testes e2e continue idêntico. O que muda de lugar aqui é só o que é
 * genuinamente tradução de fornecedor — os mapas de método e de status, que
 * viviam soltos no checkout.
 *
 * A mudança de vocabulário fica contida aqui: o domínio fala
 * `paymentMethods.cartaoCredito`, o Asaas fala `'cartao'` / `'CREDIT_CARD'`.
 */
@Injectable()
export class AsaasAdapter implements SubAccountCapablePort {
  readonly gateway = gateways.asaas;

  readonly capabilities: GatewayCapabilities = {
    methods: [
      paymentMethods.pix,
      paymentMethods.boleto,
      paymentMethods.cartaoCredito,
    ],
    split: true,
    subAccounts: true,
    maxInstallments: 12,
    clientSideTokenization: false,
  };

  constructor(
    private readonly asaas: AsaasService,
    private readonly cache: CacheService,
  ) {}

  /**
   * O AsaasService resolve o token por `asaasToken:<companyId>` no Redis antes
   * de cair no banco. Aquecer essa chave aqui mantém o formato dela contido
   * no adapter, em vez de espalhado pelo rules.ts da entidade.
   */
  async primeCredentials(companyId: number, payload: any): Promise<void> {
    if (!payload?.token) return;
    await this.cache.set(`asaasToken:${companyId}`, payload.token, 2592000);
  }

  /** Vocabulário do domínio -> tipo aceito pelo AsaasService. */
  private toAsaasType(method: paymentMethods): 'boleto' | 'pix' | 'cartao' {
    const map = {
      [paymentMethods.boleto]: 'boleto' as const,
      [paymentMethods.pix]: 'pix' as const,
      [paymentMethods.cartaoCredito]: 'cartao' as const,
    };
    return map[method];
  }

  async getOrCreateCustomer(customer: CustomerData, companyId: number) {
    return this.asaas.getOrCreateCustomer(customer as any, companyId);
  }

  async createPayment(
    input: CreatePaymentInput,
    companyId: number,
  ): Promise<GatewayPayment> {
    const payload: any = {
      customerId: input.customerId,
      paymentType: this.toAsaasType(input.method),
      value: input.value,
      dueDate: input.dueDate,
      description: input.description,
      externalReference: input.externalReference,
      creditCard: input.creditCard,
      creditCardHolderInfo: input.holderInfo,
    };

    if (input.splits?.length) {
      payload.splits = input.splits.map((s) => ({
        walletId: s.recipientId,
        percentualValue: s.percentage,
        fixedValue: s.fixedValue,
      }));
    }

    return this.asaas.createPayment(payload, companyId);
  }

  async updatePayment(
    paymentId: string,
    input: UpdatePaymentInput,
    companyId: number,
  ): Promise<GatewayPayment> {
    return this.asaas.updatePayment(
      paymentId,
      {
        paymentType: this.toAsaasType(input.method),
        value: input.value,
        dueDate: input.dueDate,
        description: input.description,
        ...(input.creditCard ? { creditCard: input.creditCard } : {}),
        ...(input.holderInfo ? { creditCardHolderInfo: input.holderInfo } : {}),
      } as any,
      companyId,
    );
  }

  async getPaymentDetails(paymentId: string, companyId: number) {
    return this.asaas.getPaymentDetails(paymentId, companyId);
  }

  async deletePayment(paymentId: string, companyId: number) {
    return this.asaas.deletePayment(paymentId, companyId);
  }

  /**
   * ATENÇÃO (R4): este mapa reproduz exatamente o que o checkout fazia antes,
   * inclusive REFUNDED -> cancelled. Ele diverge de asaas.status.ts, que mapeia
   * REFUNDED -> declined. Unificar os dois é decisão contábil pendente e por
   * isso NÃO foi feita aqui — mudaria o Contas a Receber sem aviso.
   */
  mapPaymentStatus(gatewayStatus: string): string {
    const statusMap = {
      PENDING: 'waiting',
      RECEIVED: 'received',
      CONFIRMED: 'received',
      AUTHORIZED: 'processing',
      OVERDUE: 'overdue',
      REFUNDED: 'cancelled',
      REFUND_IN_PROGRESS: 'cancelled',
      CANCELED: 'cancelled',
      DELETED: 'cancelled',
      FAILED: 'declined',
      CHARGEBACK: 'chargeback',
    };
    return statusMap[gatewayStatus] || 'processing';
  }

  mapPaymentMethod(billingType: string): paymentMethods {
    const map = {
      BOLETO: paymentMethods.boleto,
      PIX: paymentMethods.pix,
      CREDIT_CARD: paymentMethods.cartaoCredito,
    };
    return map[billingType] || paymentMethods.pix;
  }

  async processWebhook(payload: any, companyId: number) {
    return this.asaas.processWebhook(payload, companyId);
  }

  async configureWebhook(companyId: number, webhookId?: string) {
    return this.asaas.configureWebhooks(companyId, webhookId);
  }

  /** SubAccountCapablePort — o Asaas provisiona subcontas com walletId. */
  async getOrCreateSubAccount(
    seller: SellerIdentity,
  ): Promise<SubAccountResult> {
    return this.asaas.getOrCreateSubAccount(seller as any);
  }
}
