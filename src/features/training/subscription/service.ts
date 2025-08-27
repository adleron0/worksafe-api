import { GenericService } from 'src/features/generic/generic.service';
import { PrismaClient } from '@prisma/client';
import {
  BadRequestException,
  Injectable,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CheckoutService } from 'src/features/gateway/checkout/checkout.service';
import { CacheService } from 'src/common/cache/cache.service';

type entity = {
  model: keyof PrismaClient;
  name: string;
  route: string;
  permission: string;
};

@Injectable()
export class SubscriptionService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(
    protected prisma: PrismaService,
    @Inject(forwardRef(() => CheckoutService))
    private checkoutService: CheckoutService,
    private cacheService: CacheService,
  ) {
    super(prisma, null);
  }

  /**
   * Método específico customizado
   */
  async subscription(search: any, entity: entity, dto: CreateDto) {
    try {
      // Debug - verificar search params
      console.log('Search params:', search);
      console.log('Class ID:', search.classId);
      console.log('Company ID:', search.companyId);

      // PRIMEIRO: Pesquisa a turma para obter o companyId
      const whereClause: any = {
        id: Number(search.classId),
      };

      // Só adiciona companyId se estiver definido
      if (search.companyId && !isNaN(Number(search.companyId))) {
        whereClause.companyId = Number(search.companyId);
      }

      const courseClass = await this.prisma.selectFirst('courseClass', {
        where: whereClause,
        select: {
          id: true,
          maxSubscriptions: true,
          name: true,
          allowCheckout: true,
          paymentMethods: true,
          price: true,
          discountPrice: true,
          companyId: true,
        },
      });

      console.log('Course Class found:', courseClass);

      if (!courseClass) {
        throw new BadRequestException(
          `Turma com ID ${search.classId} não encontrada`,
        );
      }

      // Atualiza o companyId no search se não tinha
      if (!search.companyId) {
        search.companyId = courseClass.companyId;
      }

      // Cria a inscrição e processa pagamento se necessário
      return await this.createSubscriptionWithPayment(
        null,
        search,
        entity,
        dto,
        courseClass,
      );
    } catch (error) {
      console.log('🚀 ~ SubscriptionService ~ subscription ~ error:', error);
      throw new BadRequestException(error.message || error);
    }
  }

  private async createSubscriptionWithPayment(
    tx: any,
    search: any,
    entity: entity,
    dto: CreateDto,
    courseClass: any,
  ) {
    // SEGUNDO: Busca trainee existente (mas NÃO cria ainda)
    const trainee = await this.prisma.selectFirst('trainee', {
      where: {
        cpf: dto.cpf,
        companyId: courseClass.companyId,
      },
    });

    // TERCEIRO: Verifica se já existe inscrição para este CPF nesta turma
    const existingSubscription = await this.prisma.selectFirst(entity.model, {
      where: {
        cpf: dto.cpf,
        classId: Number(search.classId),
      },
    });

    // Se já existe inscrição, verifica o status e tenta reprocessar se necessário
    if (existingSubscription) {
      // Se já está confirmado, não permite nova tentativa
      if (existingSubscription.subscribeStatus === 'confirmed') {
        throw new BadRequestException(
          `Este aluno já está inscrito e confirmado nesta turma`,
        );
      }

      // Se está pendente e tem checkout, tenta reprocessar o pagamento
      if (courseClass.allowCheckout && dto.paymentMethod) {
        return await this.reprocessPayment(
          existingSubscription,
          dto,
          courseClass,
          entity,
        );
      }

      // Se não tem checkout ou não enviou método de pagamento, retorna erro
      throw new BadRequestException(
        `Este aluno já possui uma inscrição pendente nesta turma`,
      );
    }

    // Se existe trainee, adiciona o traineeId ao DTO (mas só será usado se o pagamento for confirmado)
    dto.traineeId = trainee?.id || null;

    // Verifica se o limite de inscrições foi atingido
    if (courseClass && courseClass.maxSubscriptions) {
      const total = await this.prisma.select(entity.model, {
        where: {
          companyId: Number(search.companyId),
          classId: Number(search.classId),
          subscribeStatus: 'confirmed',
        },
      });
      if (total.length >= Number(courseClass.maxSubscriptions)) {
        throw new BadRequestException(
          `O limite de inscrições para a turma ${courseClass.name} foi atingido`,
        );
      }
    }

    // Valida checkout se necessário
    if (courseClass.allowCheckout && dto.paymentMethod) {
      // Valida método de pagamento
      if (!courseClass.paymentMethods?.includes(dto.paymentMethod)) {
        throw new BadRequestException(
          `Método de pagamento ${dto.paymentMethod} não é aceito para esta turma`,
        );
      }

      // Valida dados do cartão se necessário
      if (dto.paymentMethod === 'cartaoCredito') {
        if (!dto.creditCard) {
          throw new BadRequestException(
            'Dados do cartão são obrigatórios para pagamento com cartão de crédito',
          );
        }

        // Validação para garantir que creditCard não é string [object Object]
        if (
          typeof dto.creditCard === 'string' &&
          dto.creditCard === '[object Object]'
        ) {
          throw new BadRequestException(
            'Dados do cartão foram enviados incorretamente. Por favor, envie como JSON string.',
          );
        }

        // Formata dados do cartão
        if (dto.creditCard && typeof dto.creditCard === 'object') {
          // Remove espaços do número do cartão
          if (dto.creditCard.cardNumber) {
            dto.creditCard.cardNumber = dto.creditCard.cardNumber.replace(
              /\s/g,
              '',
            );
          }

          // Converte data de validade MM/YY para MM/YYYY
          if (
            dto.creditCard.expiryDate &&
            dto.creditCard.expiryDate.includes('/')
          ) {
            const [month, year] = dto.creditCard.expiryDate.split('/');
            if (year && year.length === 2) {
              dto.creditCard.expiryDate = `${month}/20${year}`;
            }
          }

          // Garante que cardName existe (usa o nome do cliente se não tiver)
          if (!dto.creditCard.cardName && dto.name) {
            dto.creditCard.cardName = dto.name;
          }
        }
      }
    }

    // Usa logParams vazio para evitar problemas com o sistema de logs
    const logParams = {};

    // Remove campos de pagamento e endereço do DTO antes de criar a inscrição
    const { paymentMethod, creditCard, customerData } = dto;

    // Garante que os dados corretos sejam salvos para a inscrição
    const dataToCreate = {
      name: dto.name,
      cpf: dto.cpf,
      email: dto.email,
      phone: dto.phone,
      traineeId: trainee?.id || null, // Só vincula se já existir trainee
      classId: Number(search.classId),
      companyId: courseClass.companyId,
      subscribeStatus: dto.subscribeStatus || 'pending',
      // Salva dados de endereço na inscrição
      address: dto.address,
      addressNumber: dto.addressNumber,
      addressComplement: dto.addressComplement,
      neighborhood: dto.neighborhood,
      city: dto.city,
      state: dto.state,
      zipCode: dto.zipCode,
      occupation: dto.occupation,
      workedAt: dto.workedAt,
    };

    const created = await this.prisma.insert(
      entity.model,
      dataToCreate,
      logParams,
      tx,
    );

    // Se tem checkout habilitado e método de pagamento, processa
    if (courseClass.allowCheckout && paymentMethod) {
      try {
        const checkoutResult = await this.checkoutService.processCheckout(
          {
            subscriptionId: created.id,
            paymentMethod,
            creditCard,
            customerData,
          },
          courseClass.companyId,
        );

        // Se for cartão e foi aprovado, confirma inscrição e cria trainee
        if (
          paymentMethod === 'cartaoCredito' &&
          checkoutResult.payment?.status === 'CONFIRMED'
        ) {
          // Usa o método centralizado de confirmação
          await this.confirmSubscriptionPayment(
            created.id,
            checkoutResult.payment,
          );
        }

        // Retorna a inscrição com os dados do pagamento e o registro financeiro completo
        return {
          ...created,
          payment: checkoutResult.payment,
          financialRecordId: checkoutResult.financialRecordId,
          financialRecord: checkoutResult.financialRecord,
        };
      } catch (paymentError) {
        // Se o pagamento falhar, ainda retorna a inscrição criada
        console.error('Erro no processamento do checkout:', paymentError);

        // Mantém a inscrição como pendente já que o pagamento falhou
        // O status 'pending' já está definido, então não precisa atualizar

        return {
          ...created,
          paymentError: paymentError.message || 'Erro ao processar pagamento',
        };
      }
    }

    return created;
  }

  /**
   * Reprocessa o pagamento de uma inscrição existente
   */
  private async reprocessPayment(
    subscription: any,
    dto: CreateDto,
    courseClass: any,
    entity: entity,
  ) {
    console.log('=== REPROCESSANDO PAGAMENTO ===');
    console.log('Inscrição existente:', subscription.id);

    const { paymentMethod, creditCard, customerData } = dto;

    // Busca o registro financeiro mais recente
    const existingFinancialRecord = await this.prisma.selectFirst(
      'financialRecords',
      {
        where: { subscriptionId: subscription.id },
        orderBy: { id: 'desc' },
      },
    );

    // Valida se pode reprocessar
    if (existingFinancialRecord?.status === 'received') {
      throw new BadRequestException(
        'O pagamento desta inscrição já foi confirmado',
      );
    }

    // Determina se deve processar novo pagamento
    const shouldProcessPayment =
      !existingFinancialRecord ||
      existingFinancialRecord.paymentMethod !== paymentMethod ||
      (paymentMethod === 'cartaoCredito' && creditCard);

    if (shouldProcessPayment) {
      return await this.processNewPayment(
        subscription,
        { paymentMethod, creditCard, customerData },
        courseClass.companyId,
        existingFinancialRecord?.id,
      );
    } else {
      // Retorna dados existentes de PIX/Boleto
      return await this.getExistingPaymentData(
        subscription,
        existingFinancialRecord.id,
      );
    }
  }

  /**
   * Processa um novo pagamento ou reprocessa com novo método
   */
  private async processNewPayment(
    subscription: any,
    paymentData: { paymentMethod: any; creditCard?: any; customerData?: any },
    companyId: number,
    financialRecordId?: number,
  ): Promise<any> {
    try {
      const checkoutResult = await this.checkoutService.processCheckout(
        {
          subscriptionId: subscription.id,
          ...paymentData,
          financialRecordId, // Usa registro existente se houver
        },
        companyId,
      );

      // Confirma inscrição se cartão foi aprovado
      if (
        paymentData.paymentMethod === 'cartaoCredito' &&
        checkoutResult.payment?.status === 'CONFIRMED'
      ) {
        await this.confirmSubscriptionPayment(
          subscription.id,
          checkoutResult.payment,
        );
      }

      return {
        ...subscription,
        payment: checkoutResult.payment,
        financialRecordId: checkoutResult.financialRecordId,
        financialRecord: checkoutResult.financialRecord,
      };
    } catch (error) {
      console.error('Erro ao processar pagamento:', error);
      throw new BadRequestException(
        error.message || 'Erro ao processar pagamento',
      );
    }
  }

  /**
   * Retorna dados de pagamento existente
   */
  private async getExistingPaymentData(
    subscription: any,
    financialRecordId: number,
  ): Promise<any> {
    const financialRecord = await this.prisma.selectFirst('financialRecords', {
      where: { id: financialRecordId },
      select: {
        id: true,
        status: true,
        paymentMethod: true,
        value: true,
        dueDate: true,
        paidAt: true,
        billUrl: true,
        billNumber: true,
        pixUrl: true,
        pixNumber: true,
        externalId: true,
        key: true,
        responseData: true,
      },
    });

    return {
      ...subscription,
      payment: financialRecord.responseData || {},
      financialRecordId: financialRecord.id,
      financialRecord: {
        id: financialRecord.id,
        status: financialRecord.status,
        paymentMethod: financialRecord.paymentMethod,
        value: financialRecord.value,
        dueDate: financialRecord.dueDate,
        paidAt: financialRecord.paidAt,
        billUrl: financialRecord.billUrl,
        billNumber: financialRecord.billNumber,
        pixUrl: financialRecord.pixUrl,
        pixNumber: financialRecord.pixNumber,
        externalId: financialRecord.externalId,
        key: financialRecord.key,
      },
    };
  }

  /**
   * Busca ou cria um trainee com base nos dados da inscrição
   * Usado quando o pagamento é confirmado
   */
  private async findOrCreateTrainee(
    subscriptionData: any,
    companyId: number,
    subscriptionId?: number,
  ): Promise<number> {
    // Usa selectOrCreate para buscar ou criar o trainee
    // NOTA: trainee não tem campos neighborhood, city, state como strings
    // Esses campos ficam apenas na subscription
    const traineeData = {
      name: subscriptionData.name,
      cpf: subscriptionData.cpf,
      email: subscriptionData.email,
      phone: subscriptionData.phone,
      companyId: companyId,
      occupation: subscriptionData.occupation || null,
      address: subscriptionData.address || null,
      addressNumber: subscriptionData.addressNumber
        ? String(subscriptionData.addressNumber)
        : null,
      complement:
        subscriptionData.addressComplement ||
        subscriptionData.complement ||
        null,
      zipCode: subscriptionData.zipCode || null,
    };

    // Corrigindo a estrutura para selectOrCreate
    const whereCondition = {
      cpf: subscriptionData.cpf,
      companyId: companyId,
    };

    const trainee = await this.prisma.selectOrCreate(
      'trainee',
      whereCondition,
      traineeData,
      {}, // logParams vazio - operação interna do sistema
    );

    if (trainee.created) {
      console.log(
        `Trainee criado após confirmação de pagamento: ${trainee.data.id} - ${trainee.data.name}`,
      );
    } else {
      console.log(
        `Trainee existente encontrado: ${trainee.data.id} - ${trainee.data.name}`,
      );
    }

    return trainee.data.id;
  }

  /**
   * Confirma uma inscrição após webhook de pagamento
   * Cria o trainee se necessário e atualiza o status
   */
  async confirmSubscriptionPayment(
    subscriptionId: number,
    paymentData?: any,
  ): Promise<any> {
    try {
      // Busca a inscrição com os dados necessários
      const subscription = await this.prisma.selectFirst(
        'courseClassSubscription',
        {
          where: { id: subscriptionId },
          include: {
            class: true,
          },
        },
      );

      if (!subscription) {
        throw new BadRequestException('Inscrição não encontrada');
      }

      // SEMPRE verifica e cria o trainee se não existir
      // (mesmo que a inscrição já esteja confirmada)
      let traineeId = subscription.traineeId;

      if (!traineeId) {
        console.log(`Inscrição ${subscriptionId} sem trainee, criando...`);
        traineeId = await this.findOrCreateTrainee(
          subscription,
          subscription.companyId,
          subscriptionId,
        );
      } else {
        console.log(`Inscrição ${subscriptionId} já tem trainee: ${traineeId}`);
      }

      // Só atualiza se não estava confirmada ou se não tinha trainee
      if (
        subscription.subscribeStatus !== 'confirmed' ||
        !subscription.traineeId
      ) {
        const updatedSubscription = await this.prisma.update(
          'courseClassSubscription',
          {
            subscribeStatus: 'confirmed',
            confirmedAt: subscription.confirmedAt || new Date(),
            traineeId: traineeId,
          },
          {}, // logParams vazio - operação do webhook
          null,
          subscriptionId,
        );

        console.log(
          `Inscrição ${subscriptionId} atualizada com trainee ${traineeId}`,
        );

        return updatedSubscription;
      }

      // Invalida o cache da turma após confirmar a inscrição
      if (subscription.classId) {
        const cachePatterns = [
          `training-classes:*classId=${subscription.classId}*`,
          `cache:*/classes?*classId=${subscription.classId}*`,
          `training-classes:*id=${subscription.classId}*`,
          `cache:*/classes?*id=${subscription.classId}*`,
        ];

        for (const pattern of cachePatterns) {
          await this.cacheService.reset(pattern);
          console.log(`Cache invalidado para pattern: ${pattern}`);
        }
      }

      console.log(`Inscrição ${subscriptionId} já estava completa`);
      return subscription;
    } catch (error) {
      console.error('Erro ao confirmar inscrição:', error);
      throw error;
    }
  }
}
