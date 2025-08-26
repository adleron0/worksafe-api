import {
  Injectable,
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AsaasService } from 'src/common/gateways/asaas/asaas.service';
import { SubscriptionService } from 'src/features/training/subscription/service';
import { paymentMethods, gateways } from '@prisma/client';
import {
  CreditCardData,
  PaymentResponse,
} from 'src/common/gateways/interfaces/payment-gateway.interface';

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
  financialRecordId?: number; // ID do registro financeiro existente para atualizar
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly asaasService: AsaasService,
    @Inject(forwardRef(() => SubscriptionService))
    private readonly subscriptionService: SubscriptionService,
  ) {}

  /**
   * Processa o checkout de uma inscrição
   */
  async processCheckout(
    checkoutData: CheckoutData,
    companyId: number,
  ): Promise<any> {
    try {
      // 1. Busca os dados da inscrição com a turma
      const subscription = await this.getSubscriptionWithClass(
        checkoutData.subscriptionId,
      );

      // 2. Valida se o checkout está habilitado para a turma
      this.validateCheckoutEnabled(subscription.courseClass);

      // 3. Valida o método de pagamento
      this.validatePaymentMethod(
        subscription.courseClass,
        checkoutData.paymentMethod,
      );

      // 4. Calcula o valor correto
      const value = this.calculatePrice(subscription.courseClass);

      // 4.1. Para pagamento parcelado, calcula o valor da primeira parcela
      let financialRecordValue = value;
      if (
        checkoutData.paymentMethod === paymentMethods.cartaoCredito &&
        checkoutData.creditCard?.installments
      ) {
        const installments = Number(checkoutData.creditCard.installments);
        if (installments > 1) {
          financialRecordValue = Number((value / installments).toFixed(2));
          console.log(
            `Pagamento parcelado: ${installments}x de R$ ${financialRecordValue}`,
          );
        }
      }

      // 5. Busca o gateway configurado para a empresa
      const gateway = await this.getCompanyGateway(companyId);

      let financialRecordId: number;

      // 6. Verifica se deve atualizar um registro existente ou criar um novo
      if (checkoutData.financialRecordId) {
        // Busca o registro financeiro existente para verificar se tem pagamento no Asaas
        const existingRecord = await this.prisma.selectOne('financialRecords', {
          where: { id: checkoutData.financialRecordId },
        });

        console.log(
          'Atualizando registro financeiro existente:',
          checkoutData.financialRecordId,
        );
        console.log('Método anterior:', existingRecord.paymentMethod);
        console.log('Novo método:', checkoutData.paymentMethod);
        console.log('ExternalId existente:', existingRecord.externalId);
        console.log('Status atual:', existingRecord.status);

        // Se está mudando para cartão parcelado, precisa atualizar o valor do registro
        if (
          checkoutData.paymentMethod === paymentMethods.cartaoCredito &&
          checkoutData.creditCard?.installments &&
          Number(checkoutData.creditCard.installments) > 1
        ) {
          const installments = Number(checkoutData.creditCard.installments);
          const installmentValue = Number((value / installments).toFixed(2));

          console.log(
            `Mudando para cartão parcelado: ${installments}x de R$ ${installmentValue}`,
          );
          console.log(
            'Atualizando valor do registro financeiro existente para primeira parcela',
          );

          // Atualiza o valor e descrição do registro financeiro existente
          await this.prisma.update(
            'financialRecords',
            {
              value: installmentValue, // Atualiza para o valor da parcela
              description: `Parcela 1 de ${installments}. Inscrição - ${subscription.courseClass.name}`,
            },
            {}, // logParams
            null,
            checkoutData.financialRecordId,
          );
        }

        financialRecordId = checkoutData.financialRecordId;

        // Se tem pagamento no Asaas e mudou o método, NÃO cria novo pagamento
        // Vamos apenas atualizar o existente no processPayment
      } else {
        // Cria um novo registro financeiro
        const currentDate = new Date();
        const accrualDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 1);

        const financialRecord = await this.prisma.insert(
          'financialRecords',
          {
            accrualDate,
            companyId,
            gateway: gateway.gateway,
            status: 'processing',
            subscriptionId: subscription.id,
            traineeId: subscription.traineeId,
            customerId: subscription.courseClass.customerId,
            paymentMethod: checkoutData.paymentMethod,
            value: financialRecordValue, // Usa o valor da parcela se for parcelado
            dueDate,
            description:
              checkoutData.creditCard?.installments &&
              Number(checkoutData.creditCard.installments) > 1
                ? `Parcela 1 de ${checkoutData.creditCard.installments}. Inscrição - ${subscription.courseClass.name}`
                : `Inscrição - ${subscription.courseClass.name}`,
          },
          { companyId, userId: subscription.traineeId }, // logParams
        );

        financialRecordId = financialRecord.id;
      }

      // 7. Busca o registro financeiro para ver se tem externalId
      const financialRecord = await this.prisma.selectOne('financialRecords', {
        where: { id: financialRecordId },
      });

      // 8. Processa o pagamento de acordo com o gateway
      const paymentResult = await this.processPayment({
        financialRecordId,
        gateway: gateway.gateway,
        paymentMethod: checkoutData.paymentMethod,
        value,
        subscription,
        checkoutData,
        companyId,
        existingPaymentId: financialRecord.externalId, // Passa o ID do pagamento existente se houver
      });

      // 8. Atualiza o registro financeiro com os dados do pagamento
      await this.updateFinancialRecordWithPayment(
        financialRecordId,
        paymentResult,
        checkoutData.paymentMethod,
        financialRecord.externalId, // Passa o externalId original se existir
      );

      // 9. Busca o registro financeiro atualizado com campos específicos
      const updatedFinancialRecord = await this.prisma.selectOne(
        'financialRecords',
        {
          where: { id: financialRecordId },
          select: {
            id: true,
            subscriptionId: true,
            traineeId: true,
            customerId: true,
            companyId: true,
            paymentMethod: true,
            value: true,
            status: true,
            gateway: true,
            description: true,
            externalId: true,
            billUrl: true,
            billNumber: true,
            pixUrl: true,
            pixNumber: true,
            paidAt: true,
            createdAt: true,
            updatedAt: true,
            key: true,
          },
        },
      );

      // 10. Retorna os dados para o frontend
      return {
        success: true,
        financialRecordId,
        financialRecord: updatedFinancialRecord,
        payment: paymentResult,
      };
    } catch (error) {
      console.error('Erro no processamento do checkout:', error);
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(
        error.message || 'Erro ao processar checkout',
      );
    }
  }

  /**
   * Busca a inscrição com os dados da turma
   */
  private async getSubscriptionWithClass(subscriptionId: number): Promise<any> {
    const subscription = await this.prisma.selectFirst(
      'courseClassSubscription',
      {
        where: { id: subscriptionId },
        include: {
          trainee: true,
        },
      },
    );

    if (!subscription) {
      throw new HttpException('Inscrição não encontrada', HttpStatus.NOT_FOUND);
    }

    // Busca os dados da turma separadamente
    const courseClass = await this.prisma.selectFirst('courseClass', {
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
  private validatePaymentMethod(
    courseClass: any,
    paymentMethod: paymentMethods,
  ): void {
    if (
      !courseClass.paymentMethods ||
      !courseClass.paymentMethods.includes(paymentMethod)
    ) {
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
    const gateway = await this.prisma.selectFirst('companyGateWays', {
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
    existingPaymentId?: string;
  }): Promise<PaymentResponse> {
    const {
      gateway,
      paymentMethod,
      value,
      subscription,
      checkoutData,
      companyId,
      existingPaymentId,
    } = params;

    // Por enquanto, só suporta Asaas
    if (gateway !== gateways.asaas) {
      throw new HttpException(
        `Gateway ${gateway} ainda não está implementado`,
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    // Prepara os dados do cliente (usa dados da inscrição se não tiver trainee ainda)
    const customerData = this.prepareCustomerData(
      subscription.trainee || subscription, // Passa a própria inscrição se não tiver trainee
      checkoutData.customerData,
    );

    // Cria ou obtém o cliente no gateway
    const customer = await this.asaasService.getOrCreateCustomer(
      customerData,
      companyId,
    );

    // Mapeia o paymentMethod para o formato esperado pelo Asaas
    const mappedPaymentType = this.mapPaymentMethodToAsaas(paymentMethod);

    let payment: any;

    // Se já existe um pagamento, atualiza ao invés de criar novo
    if (existingPaymentId) {
      console.log(
        `Atualizando pagamento existente ${existingPaymentId} para método ${mappedPaymentType}`,
      );

      // Se está mudando para cartão de crédito, precisa processar de forma especial
      if (
        paymentMethod === paymentMethods.cartaoCredito &&
        checkoutData.creditCard
      ) {
        console.log(
          'Mudando para cartão de crédito - tentando processar pagamento existente',
        );

        // Atualiza o pagamento para CREDIT_CARD incluindo os dados do cartão
        const updateData = {
          paymentType: mappedPaymentType,
          value,
          dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
          description: `Inscrição - ${subscription.courseClass.name}`,
          creditCard: checkoutData.creditCard, // Inclui dados do cartão
          creditCardHolderInfo: customerData, // Inclui dados do titular
        };

        console.log('Atualizando pagamento existente com dados do cartão');
        console.log('Parcelamento:', checkoutData.creditCard.installments || 1);

        payment = await this.asaasService.updatePayment(
          existingPaymentId,
          updateData,
          companyId,
        );

        // Após atualizar, busca os detalhes completos do pagamento
        payment = await this.asaasService.getPaymentDetails(
          existingPaymentId,
          companyId,
        );

        // Verifica se o pagamento foi processado com sucesso
        if (payment.status === 'CONFIRMED' || payment.status === 'RECEIVED') {
          console.log('Pagamento com cartão processado com sucesso!');
        } else if (payment.status === 'DELETED' || payment.deleted === true) {
          // Se o pagamento foi deletado, significa que o Asaas criou novos (parcelamento)
          console.log(
            'Pagamento original deletado, novos pagamentos serão criados via webhook',
          );
        } else if (payment.status === 'PENDING') {
          console.log(
            'Pagamento atualizado mas ainda aguardando processamento',
          );

          // Se ainda está pendente, pode ser que o Asaas não processou o cartão
          // Neste caso, podemos tentar criar um novo pagamento
          if (!payment.creditCard) {
            console.log(
              'Asaas não processou o cartão, criando novo pagamento...',
            );

            try {
              await this.asaasService.deletePayment(
                existingPaymentId,
                companyId,
              );
            } catch (cancelError) {
              console.log('Erro ao cancelar pagamento anterior:', cancelError);
            }

            // Cria novo pagamento com cartão
            const paymentData = {
              customerId: customer.id,
              paymentType: mappedPaymentType,
              value,
              dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
              description: `Inscrição - ${subscription.courseClass.name}`,
              externalReference: `sub_${subscription.id}`,
              creditCard: checkoutData.creditCard,
              creditCardHolderInfo: customerData,
            };

            payment = await this.asaasService.createPayment(
              paymentData,
              companyId,
            );
          }
        }
      } else {
        // Para outros métodos (PIX/Boleto), apenas atualiza
        const updateData = {
          paymentType: mappedPaymentType,
          value,
          dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
          description: `Inscrição - ${subscription.courseClass.name}`,
        };

        payment = await this.asaasService.updatePayment(
          existingPaymentId,
          updateData,
          companyId,
        );

        // Após atualizar, busca os detalhes completos do pagamento
        payment = await this.asaasService.getPaymentDetails(
          existingPaymentId,
          companyId,
        );
      }
    } else {
      console.log(`Criando novo pagamento com método ${mappedPaymentType}`);

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
      payment = await this.asaasService.createPayment(paymentData, companyId);
    }

    // Se for cartão de crédito, processa imediatamente
    if (
      paymentMethod === paymentMethods.cartaoCredito &&
      checkoutData.creditCard
    ) {
      // O Asaas processa automaticamente quando enviamos os dados do cartão
    }

    // Adiciona os dados do PIX/Boleto do paymentDetail para o payment principal
    if (payment.paymentDetail) {
      if (payment.paymentDetail.pixData) {
        payment.pixData = payment.paymentDetail.pixData;
      }
      if (payment.paymentDetail.boletoData) {
        payment.boletoData = payment.paymentDetail.boletoData;
      }
      // Merge outros campos importantes
      Object.assign(payment, payment.paymentDetail);
    }

    // Retorna os dados específicos de acordo com o método de pagamento
    return this.formatPaymentResponse(payment, paymentMethod);
  }

  /**
   * Prepara os dados do cliente
   * Pode receber um trainee ou uma inscrição (quando trainee ainda não foi criado)
   */
  private prepareCustomerData(
    traineeOrSubscription: any,
    additionalData?: CustomerData,
  ): any {
    // Se não tem dados e nem trainee/inscrição, retorna erro
    if (!traineeOrSubscription && !additionalData) {
      throw new BadRequestException('Dados do cliente não fornecidos');
    }

    // Retorna um objeto com os campos obrigatórios para o Asaas
    // Usa CPF ou documento para identificar se é trainee ou inscrição
    const data = traineeOrSubscription || {};

    return {
      name: additionalData?.name || data.name || 'Não informado',
      document: additionalData?.document || data.cpf || '',
      email: additionalData?.email || data.email || '',
      phone: additionalData?.phone || data.phone || '',
      address: additionalData?.address || data.address || '',
      number: additionalData?.number || String(data.addressNumber || ''),
      complement:
        additionalData?.complement ||
        data.addressComplement ||
        data.complement ||
        '',
      neighborhood: additionalData?.neighborhood || data.neighborhood || '',
      zipCode: additionalData?.zipCode || data.zipCode || '',
    };
  }

  /**
   * Formata a resposta do pagamento de acordo com o método
   */
  private formatPaymentResponse(
    payment: any,
    paymentMethod: paymentMethods,
  ): PaymentResponse {
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
        response.nossoNumero = payment.nossoNumero;
        response.identificationField = payment.identificationField;
        // Linha digitável do boleto
        if (payment.boletoData) {
          response.barCode = payment.boletoData.barCode;
          response.digitableLine = payment.boletoData.digitableLine;
        }
        break;
      case paymentMethods.pix:
        if (payment.pixData) {
          // O Asaas retorna 'encodedImage' e 'payload'
          response.pixQrCode =
            payment.pixData.encodedImage || payment.pixData.qrCode;
          response.pixQrCodeBase64 = payment.pixData.encodedImage;
          response.pixCopyPaste = payment.pixData.payload;
        }
        console.log('PIX Response formatado:', {
          hasQrCode: !!response.pixQrCode,
          hasPayload: !!response.pixCopyPaste,
        });
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
    paymentMethod: paymentMethods,
    existingPaymentId?: string,
  ): Promise<void> {
    const updateData: any = {
      responseData: payment,
      paymentMethod: paymentMethod, // IMPORTANTE: Atualiza o método de pagamento
    };

    // Só atualiza o externalId se NÃO for reprocessamento
    // Em reprocessamento com cartão parcelado, o Asaas cancela o pagamento original
    // e cria novos, então mantemos o ID original para o webhook processar corretamente
    if (!existingPaymentId || payment.id === existingPaymentId) {
      updateData.externalId = payment.id;
    } else {
      console.log(
        `Mantendo externalId original: ${existingPaymentId}, novo será criado via webhook`,
      );
    }

    // Se o pagamento tem informação de parcela, atualiza a descrição
    // Isso ocorre quando o Asaas retorna informações de parcelamento
    if (payment.installmentNumber && payment.description) {
      updateData.description = payment.description;
    }

    // Limpa todos os campos de pagamento primeiro
    updateData.billUrl = null;
    updateData.billNumber = null;
    updateData.pixUrl = null;
    updateData.pixNumber = null;

    // Adiciona URLs específicas de acordo com o tipo de pagamento
    if (paymentMethod === paymentMethods.boleto && payment.bankSlipUrl) {
      updateData.billUrl = payment.bankSlipUrl;
      // A linha digitável do boleto ou o nosso número
      updateData.billNumber =
        payment.digitableLine ||
        payment.barCode ||
        payment.nossoNumero ||
        payment.identificationField;
    }

    if (paymentMethod === paymentMethods.pix && payment.pixCopyPaste) {
      // Para PIX, salva o QR Code base64 completo e o código copia-cola
      updateData.pixUrl = payment.pixQrCodeBase64 || payment.pixQrCode;
      updateData.pixNumber = payment.pixCopyPaste;
    }

    // Atualiza o status de acordo com o status do gateway
    if (payment.status === 'CONFIRMED' || payment.status === 'RECEIVED') {
      updateData.status = 'received';
      updateData.paidAt = new Date();
    } else if (payment.status === 'PENDING') {
      updateData.status = 'waiting';
    }

    console.log('=== ATUALIZANDO FINANCIAL RECORD ===');
    console.log('Financial Record ID:', financialRecordId);
    console.log('Novo método de pagamento:', paymentMethod);
    console.log('Update Data:', {
      externalId: updateData.externalId,
      status: updateData.status,
      paymentMethod: updateData.paymentMethod,
      billUrl: updateData.billUrl,
      billNumber: updateData.billNumber,
      pixUrl: updateData.pixUrl
        ? updateData.pixUrl.substring(0, 50) + '...'
        : null,
      pixNumber: updateData.pixNumber
        ? updateData.pixNumber.substring(0, 50) + '...'
        : null,
    });
    console.log('=== FIM UPDATE FINANCIAL RECORD ===');

    await this.prisma.update(
      'financialRecords',
      updateData,
      {}, // logParams vazio - operação interna
      null,
      financialRecordId,
    );
  }

  /**
   * Prepara os dados de atualização do registro financeiro baseado no webhook
   */
  private prepareFinancialRecordUpdate(webhookPayment: any): any {
    const updateData: any = {
      responseData: webhookPayment,
    };

    // IMPORTANTE: Se o pagamento foi deletado, marca como cancelado independente do status
    if (webhookPayment.deleted === true) {
      updateData.status = 'cancelled';
      updateData.inactiveAt = new Date();
      console.log(
        `Pagamento ${webhookPayment.id} foi DELETADO - marcando como cancelado`,
      );
      return updateData;
    }

    // Mapeia o status do pagamento
    updateData.status = this.mapPaymentStatus(webhookPayment.status);

    // Define a data de pagamento se foi recebido/confirmado
    if (['RECEIVED', 'CONFIRMED'].includes(webhookPayment.status)) {
      updateData.paidAt = new Date();
    }

    // Adiciona informações específicas do tipo de pagamento
    if (webhookPayment.billingType === 'BOLETO' && webhookPayment.bankSlipUrl) {
      updateData.billUrl = webhookPayment.bankSlipUrl;
      updateData.billNumber =
        webhookPayment.identificationField || webhookPayment.nossoNumero;
    }

    if (webhookPayment.billingType === 'PIX') {
      // Busca dados do PIX no paymentDetail se disponível
      if (webhookPayment.paymentDetail?.pixData) {
        updateData.pixUrl = webhookPayment.paymentDetail.pixData.encodedImage;
        updateData.pixNumber = webhookPayment.paymentDetail.pixData.payload;
      }
    }

    return updateData;
  }

  /**
   * Atualiza o status da inscrição baseado no status do pagamento
   */
  private async updateSubscriptionStatus(
    subscriptionId: number,
    webhookPayment: any,
    companyId: number,
  ): Promise<void> {
    // Se o pagamento foi deletado ou cancelado
    if (
      webhookPayment.deleted === true ||
      ['REFUNDED', 'CANCELED', 'DELETED'].includes(webhookPayment.status)
    ) {
      console.log(
        `Pagamento cancelado/deletado. Atualizando inscrição ${subscriptionId}`,
      );
      await this.prisma.update(
        'courseClassSubscription',
        {
          subscribeStatus: 'declined',
          declinedReason: webhookPayment.deleted
            ? 'Pagamento deletado'
            : `Pagamento ${webhookPayment.status}`,
          inactiveAt: new Date(),
        },
        {}, // logParams vazio - operação interna do webhook
        null,
        subscriptionId,
      );
      return;
    }

    // Se o pagamento foi confirmado
    if (['RECEIVED', 'CONFIRMED'].includes(webhookPayment.status)) {
      console.log(
        `Pagamento confirmado! Confirmando inscrição ${subscriptionId} e criando trainee...`,
      );

      // Usa o método do SubscriptionService que cria o trainee e confirma a inscrição
      await this.subscriptionService.confirmSubscriptionPayment(
        subscriptionId,
        webhookPayment,
      );

      console.log(`Inscrição ${subscriptionId} confirmada com sucesso!`);
    }
  }

  /**
   * Processa webhook de pagamento
   */
  async processPaymentWebhook(
    webhookData: any,
    companyId: number,
  ): Promise<void> {
    try {
      // Por enquanto, só processa webhooks do Asaas
      const processedData = await this.asaasService.processWebhook(
        webhookData,
        companyId,
      );

      // Verifica se o processedData tem a estrutura esperada
      if (processedData?.success && processedData.record) {
        console.log('Webhook processado com sucesso:', processedData.record.id);
      }

      // Se o webhook tem dados de pagamento direto
      if (!webhookData.payment) {
        console.log('Webhook sem dados de pagamento, ignorando');
        return;
      }

      const payment = webhookData.payment;
      // Ignora se não for um ID de pagamento válido
      if (!payment.id || !payment.id.includes('pay_')) {
        console.log('ID de pagamento inválido, ignorando:', payment.id);
        return;
      }

      // Prepara os dados de atualização
      const updateData = this.prepareFinancialRecordUpdate(payment);

      // Busca ou cria o registro financeiro usando upsert
      const financialRecord = await this.prisma.selectFirst(
        'financialRecords',
        {
          where: {
            externalId: payment.id,
            companyId,
          },
          include: {
            subscription: true,
          },
        },
      );

      if (!financialRecord) {
        console.log(
          `Registro financeiro não encontrado para pagamento ${payment.id}`,
        );
        // Pode ser um pagamento de parcelamento, vamos tentar criar se tiver referência
        if (
          payment.externalReference &&
          payment.externalReference.startsWith('sub_')
        ) {
          const subscriptionId = parseInt(
            payment.externalReference.replace('sub_', ''),
          );
          // Verifica se a inscrição existe com a turma para obter o customerId
          const subscription = await this.prisma.selectFirst(
            'courseClassSubscription',
            {
              where: { id: subscriptionId },
              include: {
                class: true, // Inclui a turma para obter o customerId
              },
            },
          );

          if (subscription && subscription.class) {
            console.log(
              `Criando novo registro financeiro para parcela do pagamento ${payment.id}`,
            );
            // Cria novo registro financeiro para a parcela
            const currentDate = new Date();
            const accrualDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 1);

            await this.prisma.insert(
              'financialRecords',
              {
                accrualDate,
                companyId,
                gateway: 'asaas',
                status: 'processing',
                subscriptionId: subscription.id,
                traineeId: subscription.traineeId,
                customerId: subscription.class.customerId, // Agora usando o customerId da turma
                paymentMethod: this.mapAsaasPaymentMethodToInternal(
                  payment.billingType,
                ),
                value: payment.value,
                dueDate,
                description:
                  payment.description ||
                  `Parcela - Inscrição ${subscriptionId}`,
                externalId: payment.id,
                ...updateData,
              },
              {}, // logParams vazio - operação interna do webhook
            );
          }
        }
        return;
      }

      console.log(
        `Atualizando registro financeiro ${financialRecord.id} com webhook`,
      );
      // Atualiza o registro financeiro
      await this.prisma.update(
        'financialRecords',
        updateData,
        {}, // logParams vazio - operação interna do webhook
        null,
        financialRecord.id,
      );

      // Atualiza o status da inscrição se houver
      if (financialRecord.subscriptionId) {
        await this.updateSubscriptionStatus(
          financialRecord.subscriptionId,
          payment,
          companyId,
        );
      }
    } catch (error) {
      console.error('Erro ao processar webhook:', error);
      throw error;
    }
  }

  /**
   * Mapeia o tipo de pagamento do Asaas para o formato interno
   */
  private mapAsaasPaymentMethodToInternal(billingType: string): paymentMethods {
    const map = {
      BOLETO: paymentMethods.boleto,
      PIX: paymentMethods.pix,
      CREDIT_CARD: paymentMethods.cartaoCredito,
    };
    return map[billingType] || paymentMethods.pix;
  }

  /**
   * Mapeia o status do gateway para o status interno
   */
  private mapPaymentStatus(gatewayStatus: string): any {
    const statusMap = {
      PENDING: 'waiting',
      RECEIVED: 'received', // Pagamento recebido
      CONFIRMED: 'received', // Pagamento confirmado
      AUTHORIZED: 'processing', // Cartão autorizado mas não capturado
      OVERDUE: 'overdue', // Vencido
      REFUNDED: 'cancelled', // Reembolsado
      REFUND_IN_PROGRESS: 'cancelled', // Reembolso em progresso
      CANCELED: 'cancelled', // Cancelado
      DELETED: 'cancelled', // Deletado
      FAILED: 'declined', // Falhou
      CHARGEBACK: 'chargeback', // Chargeback
    };

    return statusMap[gatewayStatus] || 'processing';
  }

  /**
   * Mapeia o paymentMethod interno para o formato do Asaas
   */
  private mapPaymentMethodToAsaas(
    paymentMethod: paymentMethods,
  ): 'boleto' | 'pix' | 'cartao' {
    const map = {
      [paymentMethods.boleto]: 'boleto' as const,
      [paymentMethods.pix]: 'pix' as const,
      [paymentMethods.cartaoCredito]: 'cartao' as const,
    };
    return map[paymentMethod];
  }
}
