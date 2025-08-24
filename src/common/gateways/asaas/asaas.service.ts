import {
  Injectable,
  HttpException,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import statusMappings from './asaas.status';
import { CacheService } from 'src/common/cache/cache.service';

const BASE_URL = {
  prod: 'https://api.asaas.com/v3',
  sandbox: 'https://sandbox.asaas.com/api/v3',
};

const ENDPOINTS = {
  accounts: '/accounts',
  customers: '/customers',
  payments: '/payments',
  webhooks: '/webhooks',
};

const PAYMENT_TYPES = {
  boleto: 'BOLETO',
  pix: 'PIX',
  cartao: 'CREDIT_CARD',
};

const INVERT_PAYMENT_TYPES = {
  BOLETO: 'boleto',
  PIX: 'pix',
  CREDIT_CARD: 'cartaoCredito',
};

const WEBHOOK_EVENTS = [
  'PAYMENT_CREATED',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_UPDATED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
  'PAYMENT_DELETED',
  'PAYMENT_REFUNDED',
  'PAYMENT_REFUND_IN_PROGRESS',
];

interface CustomerData {
  name: string;
  document: string;
  email: string;
  phone: string;
  address?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  zipCode?: string;
}

interface PaymentData {
  customerId: string;
  paymentType: 'boleto' | 'pix' | 'cartao';
  value: number;
  dueDate: Date | string;
  description: string;
  externalReference?: string;
  creditCard?: CreditCardData;
  creditCardHolderInfo?: CustomerData;
}

interface CreditCardData {
  cardName: string;
  cardNumber: string;
  expiryDate: string;
  cvv: string;
  token?: string;
  installments?: string | number;
}

interface WebhookData {
  event: string;
  payment?: any;
}

interface AsaasConfig {
  baseUrl: string;
  token: string;
}

@Injectable()
export class AsaasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
  ) {}

  private toBool(value: any): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return value.toLowerCase() === 'development';
    }
    return Boolean(value);
  }

  private getHeaders(token: string) {
    return {
      headers: {
        'Content-Type': 'application/json',
        access_token: token,
      },
    };
  }

  private async getToken(companyId: number): Promise<string> {
    try {
      // Tenta recuperar do cache Redis primeiro
      const cacheKey = `asaasToken:${companyId}`;
      const cachedToken = await this.cacheService.get(cacheKey);

      if (cachedToken) {
        return cachedToken;
      }

      // Se não encontrou no cache, busca no banco de dados
      const companyGateway = await this.prisma.selectFirst('companyGateWays', {
        where: {
          companyId,
          gateway: 'asaas',
          active: true,
        },
      });

      if (!companyGateway || !companyGateway.payload) {
        throw new HttpException(
          'Token Asaas não encontrado para esta empresa',
          HttpStatus.NOT_FOUND,
        );
      }

      const payload = companyGateway.payload as any;
      const token = payload.token;

      if (!token) {
        throw new HttpException(
          'Token não encontrado no payload',
          HttpStatus.NOT_FOUND,
        );
      }

      // Armazena no cache para futuras requisições (TTL de 30 dias)
      await this.cacheService.set(cacheKey, token, 2592000);

      return token;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Não foi possível obter o token da empresa',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async getConfig(
    companyId: number,
    token: string = null,
  ): Promise<AsaasConfig> {
    if (!token) {
      token = await this.getToken(companyId);
    }

    const isSandbox = this.toBool(this.configService.get('BASE_SETUP'));
    const tokenSandbox = this.configService.get('TOKEN_ASAAS_SANDBOX');

    return {
      baseUrl: isSandbox ? BASE_URL.sandbox : BASE_URL.prod,
      token: isSandbox ? tokenSandbox : token,
    };
  }

  private handleAsaasError(error: any): string {
    if (error?.response?.data?.errors?.[0]) {
      return error.response.data.errors[0].description;
    }

    if (typeof error === 'string') {
      return error;
    }

    if (error?.response?.data?.message) {
      return error.response.data.message;
    }

    console.error('Erro na API Asaas:', error);
    return 'Erro na solicitação à API Asaas';
  }

  async createCustomer(customer: CustomerData, companyId: number) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const url = `${baseUrl}${ENDPOINTS.customers}`;

    const data = {
      cpfCnpj: customer.document.replace(/[^\d]/g, ''),
      name: customer.name,
      email: customer.email,
      mobilePhone: customer.phone,
      address: customer.address,
      addressNumber: customer.number,
      addressComplement: customer.complement,
      province: customer.neighborhood,
      postalCode: customer.zipCode?.replace(/[^\d]/g, ''),
    };

    try {
      const response = await axios.post(url, data, headers);
      return response.data;
    } catch (error) {
      throw new HttpException(
        this.handleAsaasError(error),
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async getCustomer(customer: CustomerData, companyId: number) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const documentoLimpo = customer.document.replace(/[^\d]/g, '');
    const url = `${baseUrl}${ENDPOINTS.customers}?cpfCnpj=${documentoLimpo}`;

    try {
      const response = await axios.get(url, headers);
      if (response.data?.data?.length > 0) {
        return response.data.data[0];
      }
      throw new Error('Cliente não encontrado');
    } catch {
      return this.createCustomer(customer, companyId);
    }
  }

  async getOrCreateCustomer(customer: CustomerData, companyId: number) {
    try {
      // Primeiro tenta buscar o cliente pelo CPF
      const existingCustomer = await this.getCustomerByCpf(
        customer.document,
        companyId,
      );
      if (existingCustomer) {
        return existingCustomer;
      }
      // Se não encontrar, cria um novo
      return await this.createCustomer(customer, companyId);
    } catch {
      // Se houver erro na busca, tenta criar
      return await this.createCustomer(customer, companyId);
    }
  }

  async getCustomerById(customerId: string, companyId: number) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const url = `${baseUrl}${ENDPOINTS.customers}/${customerId}`;

    try {
      const response = await axios.get(url, headers);
      return response.data;
    } catch (error) {
      throw new HttpException(
        this.handleAsaasError(error),
        HttpStatus.NOT_FOUND,
      );
    }
  }

  async getCustomerByCpf(cpf: string | number, companyId: number) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const cpfLimpo = String(cpf).replace(/[^\d]/g, '');
    const url = `${baseUrl}${ENDPOINTS.customers}?cpfCnpj=${cpfLimpo}`;

    try {
      const response = await axios.get(url, headers);
      if (response.data?.data?.length > 0) {
        return response.data.data[0];
      }
      return null;
    } catch (error) {
      console.error('Erro ao buscar cliente por CPF:', error);
      return null;
    }
  }

  private prepareCreditCardData(creditCardData: CreditCardData) {
    const { cardName, cardNumber, expiryDate, cvv } = creditCardData;

    // Validação básica dos dados
    if (!expiryDate) {
      throw new BadRequestException('Data de validade do cartão é obrigatória');
    }

    const [expiryMonth, expiryYear] = expiryDate.split('/');

    return {
      holderName: cardName || 'Titular do Cartão',
      number: cardNumber?.replace(/\s/g, '') || '',
      expiryMonth: expiryMonth || '',
      expiryYear: expiryYear || '',
      ccv: cvv || '',
    };
  }

  private prepareCreditCardHolderInfo(customer: CustomerData) {
    return {
      name: customer.name,
      email: customer.email,
      cpfCnpj: customer.document.replace(/[^\d]/g, ''),
      postalCode: customer.zipCode,
      address: customer.address,
      addressNumber: customer.number,
      addressComplement: customer.complement,
      phone: customer.phone,
      mobilePhone: customer.phone,
    };
  }

  async createPayment(paymentData: PaymentData, companyId: number) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const url = `${baseUrl}${ENDPOINTS.payments}`;

    let dueDate = paymentData.dueDate;
    if (dueDate) {
      dueDate = new Date(paymentData.dueDate);
      if (dueDate < new Date()) {
        dueDate = new Date();
      }
    }

    const data: any = {
      customer: paymentData.customerId,
      billingType: PAYMENT_TYPES[paymentData.paymentType],
      value: paymentData.value,
      dueDate: dueDate || new Date(),
      externalReference: paymentData.externalReference,
      description: paymentData.description,
    };

    if (paymentData.paymentType === 'cartao' && paymentData.creditCard) {
      if (paymentData.creditCard.token) {
        data.creditCardToken = paymentData.creditCard.token;
      } else {
        data.creditCard = this.prepareCreditCardData(paymentData.creditCard);
        data.creditCardHolderInfo = this.prepareCreditCardHolderInfo(
          paymentData.creditCardHolderInfo,
        );
      }

      // Adiciona suporte a parcelamento
      if (paymentData.creditCard.installments) {
        const installments = Number(paymentData.creditCard.installments);
        if (installments > 1) {
          data.installmentCount = installments;
          // Calcula o valor de cada parcela
          data.installmentValue = Number(
            (paymentData.value / installments).toFixed(2),
          );
          console.log(
            `Pagamento parcelado em ${installments}x de R$ ${data.installmentValue}`,
          );
        }
      }
    }

    console.log('=== DADOS ENVIADOS PARA ASAAS ===');
    console.log('URL:', url);
    console.log('Payload:', JSON.stringify(data, null, 2));
    console.log('=== FIM DADOS ASAAS ===');

    try {
      const response = await axios.post(url, data, headers);
      const createdPayment = response.data;

      const paymentDetail = await this.getPaymentDetails(
        createdPayment.id,
        companyId,
      );
      createdPayment.paymentDetail = paymentDetail;

      return createdPayment;
    } catch (error) {
      throw new HttpException(
        this.handleAsaasError(error),
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async getPaymentDetails(
    paymentId: string,
    companyId: number,
    includePixBoleto = true,
  ) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const url = `${baseUrl}${ENDPOINTS.payments}/${paymentId}`;

    try {
      const response = await axios.get(url, headers);
      const paymentData = response.data;

      if (includePixBoleto) {
        if (paymentData.billingType === PAYMENT_TYPES.pix) {
          paymentData.pixData = await this.getPixData(paymentId, companyId);
        }

        if (paymentData.billingType === PAYMENT_TYPES.boleto) {
          paymentData.boletoData = await this.getBoletoData(
            paymentId,
            companyId,
          );
        }
      }

      return paymentData;
    } catch (error) {
      throw new HttpException(
        this.handleAsaasError(error),
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async getPixData(paymentId: string, companyId: number) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const url = `${baseUrl}${ENDPOINTS.payments}/${paymentId}/pixQrCode`;

    try {
      const response = await axios.get(url, headers);
      console.log('=== PIX DATA RETORNADO ===');
      console.log('QR Code disponível:', !!response.data?.encodedImage);
      console.log('Payload disponível:', !!response.data?.payload);
      console.log('=== FIM PIX DATA ===');
      return response.data;
    } catch (error) {
      console.error('Erro ao buscar dados do PIX:', error);
      throw this.handleAsaasError(error);
    }
  }

  private async getBoletoData(paymentId: string, companyId: number) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const url = `${baseUrl}${ENDPOINTS.payments}/${paymentId}/identificationField`;

    try {
      const response = await axios.get(url, headers);
      return response.data;
    } catch (error) {
      throw this.handleAsaasError(error);
    }
  }

  async updatePayment(
    paymentId: string,
    updateData: Partial<PaymentData>,
    companyId: number,
  ) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const url = `${baseUrl}${ENDPOINTS.payments}/${paymentId}`;

    const data: any = {};

    if (updateData.value) {
      data.value = updateData.value;
    }

    if (updateData.dueDate) {
      data.dueDate = updateData.dueDate;
    }

    if (updateData.description) {
      data.description = updateData.description;
    }

    if (updateData.paymentType && PAYMENT_TYPES[updateData.paymentType]) {
      data.billingType = PAYMENT_TYPES[updateData.paymentType];
    }

    // Se está mudando para cartão e tem dados do cartão, adiciona
    if (updateData.paymentType === 'cartao' && updateData.creditCard) {
      data.creditCard = this.prepareCreditCardData(updateData.creditCard);
      if (updateData.creditCardHolderInfo) {
        data.creditCardHolderInfo = this.prepareCreditCardHolderInfo(
          updateData.creditCardHolderInfo,
        );
      }

      // Adiciona suporte a parcelamento no update
      if (updateData.creditCard.installments) {
        const installments = Number(updateData.creditCard.installments);
        if (installments > 1) {
          data.installmentCount = installments;
          // Calcula o valor de cada parcela
          data.installmentValue = Number(
            (updateData.value / installments).toFixed(2),
          );
          console.log(
            `Atualizando pagamento para parcelado: ${installments}x de R$ ${data.installmentValue}`,
          );
        }
      }
    }

    console.log('=== ATUALIZANDO PAGAMENTO NO ASAAS ===');
    console.log('URL:', url);
    console.log('Payload:', JSON.stringify(data, null, 2));
    console.log('=== FIM DADOS UPDATE ASAAS ===');

    try {
      const response = await axios.put(url, data, headers);
      console.log('Resposta do Asaas:', response.data.status);
      return response.data;
    } catch (error) {
      throw new HttpException(
        this.handleAsaasError(error),
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Tenta processar um pagamento existente com cartão de crédito
   * NOTA: Este método pode não funcionar dependendo das regras do Asaas
   */
  async processExistingPaymentWithCard(
    paymentId: string,
    creditCard: CreditCardData,
    creditCardHolderInfo: CustomerData,
    companyId: number,
  ) {
    try {
      // Tenta atualizar o pagamento incluindo os dados do cartão
      const updateData: any = {
        paymentType: 'cartao',
        creditCard,
        creditCardHolderInfo,
      };

      const result = await this.updatePayment(paymentId, updateData, companyId);

      // Busca os detalhes atualizados
      const payment = await this.getPaymentDetails(paymentId, companyId);

      return payment;
    } catch (error) {
      console.error('Erro ao processar cartão em pagamento existente:', error);
      throw error;
    }
  }

  async deletePayment(paymentId: string, companyId: number) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const url = `${baseUrl}${ENDPOINTS.payments}/${paymentId}`;

    try {
      const response = await axios.delete(url, headers);
      return response.data;
    } catch (error) {
      throw new HttpException(
        this.handleAsaasError(error),
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async confirmManualPayment(
    paymentId: string,
    paymentDate: string,
    value: number,
    companyId: number,
  ) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const url = `${baseUrl}${ENDPOINTS.payments}/${paymentId}/receiveInCash`;

    const data = {
      value,
      paymentDate,
      notifyCustomer: false,
    };

    try {
      const response = await axios.post(url, data, headers);
      return response.data;
    } catch (error) {
      throw new HttpException(
        this.handleAsaasError(error),
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async listPaymentsByCustomer(customerId: string, companyId: number) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);

    const allData = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    try {
      while (hasMore) {
        const url = `${baseUrl}${ENDPOINTS.payments}?customer=${customerId}&limit=${limit}&offset=${offset}`;
        const response = await axios.get(url, headers);

        if (response.data?.data) {
          allData.push(...response.data.data);
          offset += limit;
          hasMore = response.data.hasMore;
        } else {
          hasMore = false;
        }
      }

      return allData;
    } catch (error) {
      console.error('Erro ao listar cobranças do customer:', error);
      throw new HttpException(
        this.handleAsaasError(error),
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async configureWebhooks(companyId: number, webhookId?: string) {
    const { baseUrl, token } = await this.getConfig(companyId);
    const headers = this.getHeaders(token);
    const webhookUrl =
      this.configService.get('WEBHOOK_URL') ||
      'https://api.worksafebrasil.com.br';

    const data = {
      name: 'WorkSafe Webhooks',
      sendType: 'SEQUENTIALLY',
      email: 'webhooks@worksafe.com.br',
      enabled: true,
      interrupted: false,
      url: `${webhookUrl}/webhooks/asaas/${companyId}`,
      events: WEBHOOK_EVENTS,
    };

    try {
      let response: any;
      if (!webhookId) {
        const url = `${baseUrl}${ENDPOINTS.webhooks}`;
        response = await axios.post(url, data, headers);
      } else {
        const url = `${baseUrl}${ENDPOINTS.webhooks}/${webhookId}`;
        response = await axios.put(url, data, headers);
      }

      return response.data;
    } catch (error) {
      throw new HttpException(
        this.handleAsaasError(error),
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async processWebhook(webhookData: WebhookData, companyId: number) {
    try {
      const payment = webhookData.payment;
      if (!payment) {
        return { success: false, message: 'Payment data not found' };
      }

      // Verifica se o pagamento foi deletado
      console.log('=== VERIFICANDO DELETED NO WEBHOOK ===');
      console.log('payment.deleted:', payment.deleted);
      console.log('payment.deleted === true:', payment.deleted === true);
      console.log('typeof payment.deleted:', typeof payment.deleted);

      if (payment.deleted === true) {
        console.log(`Webhook: Pagamento ${payment.id} foi deletado no Asaas`);

        // Se existe registro, marca como cancelado
        const existingRecord = await this.prisma.selectFirst('financialRecords', {
          where: {
            externalId: payment.id,
            companyId,
          },
        });

        console.log('Registro existente encontrado:', existingRecord?.id);

        if (existingRecord) {
          console.log('Status atual do registro:', existingRecord.status);
          console.log('Tentando atualizar para cancelled...');

          try {
            // Força o status para cancelled, ignorando o status do Asaas
            const updatedRecord = await this.prisma.update(
              'financialRecords',
              {
                status: 'cancelled' as const,
                observations: 'Pagamento cancelado/deletado pelo gateway',
                responseData: payment, // Salva o payload completo para histórico
              },
              {}, // logParams vazio - operação interna do webhook
              null,
              existingRecord.id,
            );
            console.log(
              `Registro ${existingRecord.id} marcado como cancelled (deletado no Asaas)`,
            );
            console.log('Status após update:', updatedRecord.status);
            return { success: true, record: updatedRecord };
          } catch (error) {
            console.error('Erro ao atualizar registro:', error);
            throw error;
          }
        }

        // Se não existe registro, não cria (pois foi deletado)
        console.log('Pagamento deletado não tem registro, ignorando...');
        return {
          success: true,
          message: 'Payment deleted, no record to update',
        };
      }

      // IMPORTANTE: Se o pagamento foi deletado, já processamos acima e retornamos
      // Não deve continuar para o código abaixo

      const existingRecord = await this.prisma.selectFirst('financialRecords', {
        where: {
          externalId: payment.id,
          companyId,
        },
      });

      if (!existingRecord) {
        const dueDate = new Date(payment.dueDate);
        const accrualDate = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, '0')}`;

        // Extrai o subscriptionId do externalReference (remove "sub_" do início)
        let subscriptionId = null;
        if (
          payment.externalReference &&
          payment.externalReference.startsWith('sub_')
        ) {
          subscriptionId = parseInt(
            payment.externalReference.replace('sub_', ''),
          );
        }

        // Para pagamentos parcelados, verifica se já existe o registro da primeira parcela
        // Se for parcela 2 ou maior, cria novo registro
        const isInstallment =
          payment.installmentNumber && payment.installmentNumber > 1;

        const newRecord = await this.prisma.insert(
          'financialRecords',
          {
            accrualDate,
            companyId,
            subscriptionId,
            externalId: payment.id,
            gateway: 'asaas',
            status: this.mapPaymentStatus(payment.status),
            value: payment.value,
            dueDate,
            paidAt: payment.confirmedDate
              ? new Date(payment.confirmedDate)
              : null,
            paymentMethod: (INVERT_PAYMENT_TYPES[payment.billingType] ||
              'pix') as 'cartaoCredito' | 'boleto' | 'pix',
            observations: isInstallment
              ? `Registro criado via webhook - Parcela ${payment.installmentNumber} de ${payment.description}`
              : 'Registro criado via webhook',
            responseData: payment,
          },
          {}, // logParams vazio - operação interna do webhook
        );

        console.log('Novo registro financeiro criado via webhook:', {
          id: newRecord.id,
          subscriptionId,
          installmentNumber: payment.installmentNumber,
          value: payment.value,
        });

        return { success: true, record: newRecord };
      }

      // VERIFICAÇÃO ADICIONAL: Se deleted, não deveria chegar aqui
      if (payment.deleted === true) {
        console.error('ERRO: Código não deveria chegar aqui com deleted=true!');
        // Força retorno para evitar update incorreto
        return {
          success: true,
          message: 'Payment already processed as deleted',
        };
      }

      // Se o pagamento está deletado, força status cancelled
      const statusToUpdate = this.mapPaymentStatus(payment.status);

      const updatedRecord = await this.prisma.update(
        'financialRecords',
        {
          status: statusToUpdate,
          paidAt: payment.confirmedDate
            ? new Date(payment.confirmedDate)
            : null,
          responseData: payment,
        },
        {}, // logParams vazio - operação interna do webhook
        null,
        existingRecord.id,
      );

      return { success: true, record: updatedRecord };
    } catch (error) {
      console.error('Erro ao processar webhook:', error);
      return { success: false, error: error.message };
    }
  }

  private mapPaymentStatus(
    asaasStatus: string,
  ):
    | 'processing'
    | 'waiting'
    | 'received'
    | 'declined'
    | 'chargeback'
    | 'cancelled'
    | 'overdue' {
    return statusMappings.asaasStatus[asaasStatus] || 'processing';
  }

  async savePaymentToDatabase(paymentData: any, companyId: number) {
    try {
      const dueDate = new Date(paymentData.dueDate);
      const accrualDate = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, '0')}`;

      const financialRecord = await this.prisma.insert(
        'financialRecords',
        {
          accrualDate,
          companyId,
          externalId: paymentData.id,
          gateway: 'asaas',
          status: this.mapPaymentStatus(paymentData.status),
          value: paymentData.value,
          dueDate,
          paidAt: paymentData.confirmedDate
            ? new Date(paymentData.confirmedDate)
            : null,
          paymentMethod: (INVERT_PAYMENT_TYPES[paymentData.billingType] ||
            'pix') as 'cartaoCredito' | 'boleto' | 'pix',
          pixUrl: paymentData.pixData?.qrCode || null,
          pixNumber: paymentData.pixData?.payload || null,
          billUrl: paymentData.boletoData?.bankSlipUrl || null,
          billNumber: paymentData.boletoData?.identificationField || null,
        },
        {}, // logParams vazio - operação interna
      );

      return financialRecord;
    } catch (error) {
      console.error('Erro ao salvar pagamento no banco:', error);
      throw new HttpException(
        'Erro ao salvar pagamento no banco de dados',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
