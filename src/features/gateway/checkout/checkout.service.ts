import { Injectable, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AsaasService } from 'src/common/gateways/asaas/asaas.service';
import { FinancialrecordsService } from '../financialrecords/service';
import { paymentMethods, gateways } from '@prisma/client';
import { CreditCardData, PaymentResponse } from 'src/common/gateways/interfaces/payment-gateway.interface';

// Usa o tipo CustomerData da interface, mas com todos campos opcionais
interface CustomerData {
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

export interface CheckoutData {
  subscriptionId: number;
  paymentMethod: paymentMethods;
  creditCard?: CreditCardData;
  customerData?: CustomerData;
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly asaasService: AsaasService,
    private readonly financialRecordsService: FinancialrecordsService,
  ) {}

  /**
   * Processa o checkout de uma inscrição
   */
  async processCheckout(checkoutData: CheckoutData, companyId: number): Promise<any> {
    try {
      // 1. Busca os dados da inscrição com a turma
      const subscription = await this.getSubscriptionWithClass(checkoutData.subscriptionId);
      
      // 2. Valida se o checkout está habilitado para a turma
      this.validateCheckoutEnabled(subscription.courseClass);
      
      // 3. Valida o método de pagamento
      this.validatePaymentMethod(subscription.courseClass, checkoutData.paymentMethod);
      
      // 4. Calcula o valor correto
      const value = this.calculatePrice(subscription.courseClass);
      
      // 5. Busca o gateway configurado para a empresa
      const gateway = await this.getCompanyGateway(companyId);
      
      // 6. Cria o registro financeiro
      const financialRecord = await this.financialRecordsService.createFinancialRecord({
        subscriptionId: subscription.id,
        traineeId: subscription.traineeId,
        customerId: subscription.courseClass.customerId,
        companyId,
        classId: subscription.courseClassId,
        paymentMethod: checkoutData.paymentMethod,
        value,
        gateway: gateway.gateway,
        description: `Inscrição - ${subscription.courseClass.name}`,
      });

      // 7. Processa o pagamento de acordo com o gateway
      const paymentResult = await this.processPayment({
        financialRecordId: financialRecord.id,
        gateway: gateway.gateway,
        paymentMethod: checkoutData.paymentMethod,
        value,
        subscription,
        checkoutData,
        companyId,
      });

      // 8. Atualiza o registro financeiro com os dados do pagamento
      await this.updateFinancialRecordWithPayment(financialRecord.id, paymentResult);

      // 9. Retorna os dados para o frontend
      return {
        success: true,
        financialRecordId: financialRecord.id,
        payment: paymentResult,
      };
    } catch (error) {
      console.error('Erro no processamento do checkout:', error);
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(error.message || 'Erro ao processar checkout');
    }
  }

  /**
   * Busca a inscrição com os dados da turma
   */
  private async getSubscriptionWithClass(subscriptionId: number): Promise<any> {
    const subscription = await this.prisma.courseClassSubscription.findFirst({
      where: { id: subscriptionId },
      include: {
        trainee: true,
      },
    });

    if (!subscription) {
      throw new HttpException('Inscrição não encontrada', HttpStatus.NOT_FOUND);
    }

    // Busca os dados da turma separadamente
    const courseClass = await this.prisma.courseClass.findFirst({
      where: { id: subscription.classId },
      include: {
        course: true,
        customer: true,
      },
    });

    if (!courseClass) {
      throw new HttpException('Turma não encontrada', HttpStatus.NOT_FOUND);
    }

    // Combina os dados
    const result = {
      ...subscription,
      courseClass,
    };

    return result;
  }

  /**
   * Valida se o checkout está habilitado para a turma
   */
  private validateCheckoutEnabled(courseClass: any): void {
    if (!courseClass.allowCheckout) {
      throw new HttpException(
        'Checkout não está habilitado para esta turma',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Valida se o método de pagamento é aceito pela turma
   */
  private validatePaymentMethod(courseClass: any, paymentMethod: paymentMethods): void {
    if (!courseClass.paymentMethods || !courseClass.paymentMethods.includes(paymentMethod)) {
      throw new HttpException(
        `Método de pagamento ${paymentMethod} não é aceito para esta turma`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Calcula o preço correto (usa discountPrice se existir, senão usa price)
   */
  private calculatePrice(courseClass: any): number {
    const price = courseClass.discountPrice || courseClass.price;
    
    if (!price || price <= 0) {
      throw new HttpException(
        'Preço inválido para esta turma',
        HttpStatus.BAD_REQUEST,
      );
    }

    return Number(price);
  }

  /**
   * Busca o gateway configurado para a empresa
   */
  private async getCompanyGateway(companyId: number): Promise<any> {
    const gateway = await this.prisma.companyGateWays.findFirst({
      where: {
        companyId,
        active: true,
      },
    });

    if (!gateway) {
      throw new HttpException(
        'Nenhum gateway de pagamento configurado para esta empresa',
        HttpStatus.NOT_FOUND,
      );
    }

    return gateway;
  }

  /**
   * Processa o pagamento de acordo com o gateway
   */
  private async processPayment(params: {
    financialRecordId: number;
    gateway: gateways;
    paymentMethod: paymentMethods;
    value: number;
    subscription: any;
    checkoutData: CheckoutData;
    companyId: number;
  }): Promise<PaymentResponse> {
    const { gateway, paymentMethod, value, subscription, checkoutData, companyId } = params;

    // Por enquanto, só suporta Asaas
    if (gateway !== gateways.asaas) {
      throw new HttpException(
        `Gateway ${gateway} ainda não está implementado`,
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    // Prepara os dados do cliente
    const customerData = this.prepareCustomerData(subscription.trainee, checkoutData.customerData);

    // Cria ou obtém o cliente no gateway
    const customer = await this.asaasService.getOrCreateCustomer(customerData, companyId);

    // Mapeia o paymentMethod para o formato esperado pelo Asaas
    const mappedPaymentType = this.mapPaymentMethodToAsaas(paymentMethod);

    // Prepara os dados do pagamento
    const paymentData = {
      customerId: customer.id,
      paymentType: mappedPaymentType,
      value,
      dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000), // Vencimento para amanhã
      description: `Inscrição - ${subscription.courseClass.name}`,
      externalReference: `sub_${subscription.id}`,
      creditCard: checkoutData.creditCard,
      creditCardHolderInfo: customerData,
    };

    // Cria o pagamento no gateway
    const payment = await this.asaasService.createPayment(paymentData, companyId);

    // Se for cartão de crédito, processa imediatamente
    if (paymentMethod === paymentMethods.cartaoCredito && checkoutData.creditCard) {
      // O Asaas processa automaticamente quando enviamos os dados do cartão
    }

    // Retorna os dados específicos de acordo com o método de pagamento
    return this.formatPaymentResponse(payment, paymentMethod);
  }

  /**
   * Prepara os dados do cliente
   */
  private prepareCustomerData(trainee: any, additionalData?: CustomerData): any {
    // Retorna um objeto com os campos obrigatórios para o Asaas
    return {
      name: additionalData?.name || trainee.name || 'Não informado',
      document: additionalData?.document || trainee.cpf || '',
      email: additionalData?.email || trainee.email || '',
      phone: additionalData?.phone || trainee.phone || '',
      address: additionalData?.address || trainee.address || '',
      number: additionalData?.number || String(trainee.addressNumber || ''),
      complement: additionalData?.complement || trainee.complement || '',
      neighborhood: additionalData?.neighborhood || trainee.neighborhood || '',
      zipCode: additionalData?.zipCode || trainee.zipCode || '',
    };
  }

  /**
   * Formata a resposta do pagamento de acordo com o método
   */
  private formatPaymentResponse(payment: any, paymentMethod: paymentMethods): PaymentResponse {
    const response: PaymentResponse = {
      id: payment.id,
      status: payment.status,
      value: payment.value,
      netValue: payment.netValue,
      description: payment.description,
      billingType: payment.billingType,
      dueDate: payment.dueDate,
      externalReference: payment.externalReference,
    };

    // Adiciona dados específicos de acordo com o método de pagamento
    switch (paymentMethod) {
      case paymentMethods.boleto:
        response.bankSlipUrl = payment.bankSlipUrl;
        response.invoiceUrl = payment.invoiceUrl;
        break;
      case paymentMethods.pix:
        if (payment.pixData) {
          response.pixQrCode = payment.pixData.qrCode;
          response.pixQrCodeBase64 = payment.pixData.qrCodeBase64;
          response.pixCopyPaste = payment.pixData.payload;
        }
        break;
      case paymentMethods.cartaoCredito:
        response.transactionReceiptUrl = payment.transactionReceiptUrl;
        break;
    }

    return response;
  }

  /**
   * Atualiza o registro financeiro com os dados do pagamento
   */
  private async updateFinancialRecordWithPayment(
    financialRecordId: number,
    payment: PaymentResponse,
  ): Promise<void> {
    const updateData: any = {
      externalId: payment.id,
      responseData: payment,
    };

    // Adiciona URLs específicas de acordo com o tipo de pagamento
    if (payment.bankSlipUrl) {
      updateData.billUrl = payment.bankSlipUrl;
      updateData.billNumber = payment.id;
    }

    if (payment.pixCopyPaste) {
      updateData.pixUrl = payment.pixQrCode;
      updateData.pixNumber = payment.pixCopyPaste;
    }

    // Atualiza o status de acordo com o status do gateway
    if (payment.status === 'CONFIRMED' || payment.status === 'RECEIVED') {
      updateData.status = 'received';
      updateData.paidAt = new Date();
    } else if (payment.status === 'PENDING') {
      updateData.status = 'waiting';
    }

    await this.financialRecordsService.updateFinancialRecord(financialRecordId, updateData);
  }

  /**
   * Processa webhook de pagamento
   */
  async processPaymentWebhook(webhookData: any, companyId: number): Promise<void> {
    try {
      // Por enquanto, só processa webhooks do Asaas
      const processedData = await this.asaasService.processWebhook(webhookData, companyId);
      
      // Verifica se o processedData tem a estrutura esperada
      if (processedData && 'success' in processedData && processedData.success) {
        // Se tem record, significa que foi processado um pagamento
        if ('record' in processedData && processedData.record) {
          // O registro já foi atualizado pelo processWebhook do AsaasService
          console.log('Webhook processado com sucesso:', processedData.record.id);
        }
      }
      
      // Se o webhook tem dados de pagamento direto (para processamento customizado)
      if (webhookData.payment) {
        const financialRecord = await this.prisma.financialRecords.findFirst({
          where: {
            externalId: webhookData.payment.id,
            companyId,
          },
          include: {
            subscription: true,
          },
        });

        if (financialRecord) {
          const status = this.mapPaymentStatus(webhookData.payment.status);
          
          // Atualiza o registro financeiro
          await this.financialRecordsService.updateFinancialRecord(financialRecord.id, {
            status,
            responseData: webhookData.payment,
            paidAt: webhookData.payment.status === 'RECEIVED' ? new Date() : null,
          });

          // Se o pagamento foi confirmado e tem inscrição associada
          if (webhookData.payment.status === 'RECEIVED' && financialRecord.subscription) {
            console.log(`Pagamento confirmado! Atualizando inscrição ${financialRecord.subscriptionId}`);
            
            // Atualiza a inscrição para confirmada
            await this.prisma.courseClassSubscription.update({
              where: { id: financialRecord.subscriptionId },
              data: {
                subscribeStatus: 'confirmed',
                confirmedAt: new Date(),
              },
            });
            
            console.log(`Inscrição ${financialRecord.subscriptionId} confirmada com sucesso!`);
          }

          // Se o pagamento foi cancelado/recusado
          if (['REFUNDED', 'CANCELED'].includes(webhookData.payment.status) && financialRecord.subscription) {
            console.log(`Pagamento cancelado/recusado. Atualizando inscrição ${financialRecord.subscriptionId}`);
            
            await this.prisma.courseClassSubscription.update({
              where: { id: financialRecord.subscriptionId },
              data: {
                subscribeStatus: 'declined',
                declinedReason: `Pagamento ${webhookData.payment.status}`,
                inactiveAt: new Date(),
              },
            });
          }
        }
      }
    } catch (error) {
      console.error('Erro ao processar webhook:', error);
      throw error;
    }
  }

  /**
   * Mapeia o status do gateway para o status interno
   */
  private mapPaymentStatus(gatewayStatus: string): any {
    const statusMap = {
      'PENDING': 'waiting',
      'RECEIVED': 'received',       // Pagamento recebido
      'CONFIRMED': 'received',      // Pagamento confirmado
      'AUTHORIZED': 'processing',   // Cartão autorizado mas não capturado
      'OVERDUE': 'overdue',        // Vencido
      'REFUNDED': 'cancelled',     // Reembolsado
      'REFUND_IN_PROGRESS': 'cancelled', // Reembolso em progresso
      'CANCELED': 'cancelled',     // Cancelado
      'DELETED': 'cancelled',      // Deletado
      'FAILED': 'declined',        // Falhou
      'CHARGEBACK': 'chargeback',  // Chargeback
    };

    return statusMap[gatewayStatus] || 'processing';
  }

  /**
   * Mapeia o paymentMethod interno para o formato do Asaas
   */
  private mapPaymentMethodToAsaas(paymentMethod: paymentMethods): 'boleto' | 'pix' | 'cartao' {
    const map = {
      [paymentMethods.boleto]: 'boleto' as const,
      [paymentMethods.pix]: 'pix' as const,
      [paymentMethods.cartaoCredito]: 'cartao' as const,
    };
    return map[paymentMethod];
  }
}