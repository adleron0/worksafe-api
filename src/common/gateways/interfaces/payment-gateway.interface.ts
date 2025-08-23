import { paymentMethods } from '@prisma/client';

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
  expiryDate: string; // MM/YYYY
  cvv: string;
  token?: string;
}

export interface PaymentData {
  customerId: string;
  paymentMethod: paymentMethods;
  value: number;
  dueDate: Date | string;
  description: string;
  externalReference?: string;
  creditCard?: CreditCardData;
  creditCardHolderInfo?: CustomerData;
}

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
  pixQrCode?: string;
  pixQrCodeBase64?: string;
  pixCopyPaste?: string;
  error?: string;
}

export interface WebhookPayload {
  event: string;
  payment?: any;
  [key: string]: any;
}

export interface PaymentGateway {
  // Customer management
  createCustomer(customer: CustomerData, companyId: number): Promise<any>;
  getCustomer(customerId: string, companyId: number): Promise<any>;
  updateCustomer(
    customerId: string,
    customer: CustomerData,
    companyId: number,
  ): Promise<any>;

  // Payment management
  createPayment(
    payment: PaymentData,
    companyId: number,
  ): Promise<PaymentResponse>;
  getPayment(paymentId: string, companyId: number): Promise<PaymentResponse>;
  cancelPayment(paymentId: string, companyId: number): Promise<any>;

  // Payment details
  getPixData(paymentId: string, companyId: number): Promise<any>;
  getBoletoData(paymentId: string, companyId: number): Promise<any>;

  // Webhook management
  configureWebhook(companyId: number, webhookId?: string): Promise<any>;
  processWebhook(payload: WebhookPayload, companyId: number): Promise<any>;

  // Status mapping
  mapPaymentStatus(gatewayStatus: string): string;
}
