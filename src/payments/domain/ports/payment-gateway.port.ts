import { paymentMethods, gateways } from '@prisma/client';
import { GatewayCapabilities } from './gateway-capabilities';

export * from './gateway-capabilities';

/**
 * Contrato que todo gateway de pagamento precisa cumprir.
 *
 * Escrito a partir do que o checkout REALMENTE usa, não do que seria elegante:
 * a interface anterior (common/gateways/interfaces) era órfã e suas assinaturas
 * divergiam da implementação, o que a tornava impossível de implementar de fato.
 *
 * Regra da camada: nada aqui pode citar um fornecedor. O nome "asaas" só
 * aparece dentro de infrastructure/adapters/asaas.
 */

export interface CustomerData {
  name?: string;
  document?: string;
  email?: string;
  phone?: string;
  address?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  zipCode?: string;
}

export interface CreditCardData {
  cardName: string;
  cardNumber: string;
  /** MM/YYYY — normalizado antes de chegar aqui. */
  expiryDate: string;
  cvv: string;
  token?: string;
  installments?: string | number;
}

/** Instrução de repasse a um recebedor secundário. */
export interface SplitInstruction {
  /** Identificador do recebedor no gateway (walletId, accountId, etc). */
  recipientId: string;
  percentage?: number;
  fixedValue?: number;
}

export interface CreatePaymentInput {
  customerId: string;
  /** Método no vocabulário do domínio; o adapter traduz. */
  method: paymentMethods;
  value: number;
  dueDate: Date;
  description: string;
  externalReference?: string;
  creditCard?: CreditCardData;
  holderInfo?: CustomerData;
  splits?: SplitInstruction[];
}

export interface UpdatePaymentInput {
  method: paymentMethods;
  value: number;
  dueDate: Date;
  description: string;
  creditCard?: CreditCardData;
  holderInfo?: CustomerData;
}

/**
 * Resposta crua do gateway. Propositalmente `any`: cada adapter devolve o
 * formato do seu fornecedor e o checkout consome via formatPaymentResponse.
 * Estreitar isto é trabalho da fase 2, junto com a extração dos mapeamentos.
 */
export type GatewayPayment = any;

/**
 * Formato normalizado devolvido ao cliente do checkout. É o que o
 * worksafe-site consome — mexer aqui quebra o checkout público, e o teste
 * de golden contract existe para travar isso.
 */
export interface PaymentResponse {
  id: string;
  status: string;
  value: number;
  netValue?: number;
  description: string;
  billingType: string;
  dueDate: string;
  externalReference?: string;
  transactionReceiptUrl?: string;
  invoiceUrl?: string;
  bankSlipUrl?: string;
  nossoNumero?: string;
  identificationField?: string;
  barCode?: string;
  digitableLine?: string;
  pixQrCode?: string;
  pixQrCodeBase64?: string;
  pixCopyPaste?: string;
  installmentNumber?: number;
  installmentCount?: number;
  error?: string;
}

export interface PaymentGatewayPort {
  readonly gateway: gateways;
  readonly capabilities: GatewayCapabilities;

  getOrCreateCustomer(
    customer: CustomerData,
    companyId: number,
  ): Promise<{ id: string } & Record<string, any>>;

  createPayment(
    input: CreatePaymentInput,
    companyId: number,
  ): Promise<GatewayPayment>;

  updatePayment(
    paymentId: string,
    input: UpdatePaymentInput,
    companyId: number,
  ): Promise<GatewayPayment>;

  getPaymentDetails(
    paymentId: string,
    companyId: number,
  ): Promise<GatewayPayment>;

  deletePayment(paymentId: string, companyId: number): Promise<any>;

  /** Traduz o status do fornecedor para o vocabulário de FinancialRecords. */
  mapPaymentStatus(gatewayStatus: string): string;

  /** Traduz o tipo de cobrança do fornecedor para o método do domínio. */
  mapPaymentMethod(gatewayBillingType: string): paymentMethods;

  processWebhook(payload: any, companyId: number): Promise<any>;

  configureWebhook(companyId: number, webhookId?: string): Promise<any>;

  /**
   * Deixa a credencial pronta para uso imediato (ex.: aquecer o cache que o
   * cliente HTTP consulta). Onde a credencial fica é detalhe do fornecedor,
   * por isso a decisão pertence ao adapter e não a quem salva o registro.
   */
  primeCredentials(companyId: number, payload: any): Promise<void>;
}
