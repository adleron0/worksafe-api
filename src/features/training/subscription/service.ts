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
    // SEGUNDO: Busca ou cria o Trainee usando o companyId da turma
    let trainee = await this.prisma.selectFirst('trainee', {
      where: {
        cpf: dto.cpf,
        companyId: courseClass.companyId,
      },
    });

    if (!trainee) {
      // Cria o trainee se não existir
      const traineeData: any = {
        name: dto.name,
        cpf: dto.cpf,
        email: dto.email,
        phone: dto.phone,
        companyId: courseClass.companyId,
        occupation: dto.occupation,
        address: dto.address,
        addressNumber: dto.addressNumber ? Number(dto.addressNumber) : null,
        complement: dto.addressComplement,
        zipCode: dto.zipCode,
      };

      const traineeLogParams = {
        userId: 1, // Usar userId 1 como sistema/admin por enquanto
        companyId: courseClass.companyId,
      };

      trainee = await this.prisma.insert(
        'trainee',
        traineeData,
        traineeLogParams,
        tx,
      );
      console.log('Trainee criado:', trainee);
    } else {
      console.log('Trainee encontrado:', trainee);
    }

    // TERCEIRO: Verifica se já existe inscrição para este trainee nesta turma
    const existingSubscription = await this.prisma.selectFirst(entity.model, {
      where: {
        traineeId: trainee.id,
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

    // Adiciona o traineeId ao DTO
    dto.traineeId = trainee.id;

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
        if (typeof dto.creditCard === 'string' && dto.creditCard === '[object Object]') {
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

    const logParams = {
      userId: 1, // Usar userId 1 como sistema/admin por enquanto
      companyId: courseClass.companyId, // Usa o companyId da turma
    };

    // Remove campos de pagamento e endereço do DTO antes de criar a inscrição
    const { paymentMethod, creditCard, customerData } = dto;

    // Garante que os dados corretos sejam salvos para a inscrição
    const dataToCreate = {
      name: dto.name,
      cpf: dto.cpf,
      email: dto.email,
      phone: dto.phone,
      traineeId: trainee.id,
      classId: Number(search.classId),
      companyId: courseClass.companyId,
      subscribeStatus: dto.subscribeStatus || 'pending',
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

        // Se for cartão e foi aprovado, atualiza status da inscrição
        if (
          paymentMethod === 'cartaoCredito' &&
          checkoutResult.payment?.status === 'CONFIRMED'
        ) {
          await this.prisma.update(
            entity.model,
            {
              subscribeStatus: 'confirmed',
              confirmedAt: new Date(),
            },
            logParams,
            null,
            created.id,
            null, // Sem transação aqui
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
    console.log('Método atual:', dto.paymentMethod);

    // Busca o registro financeiro existente
    const existingFinancialRecord = await this.prisma.selectFirst(
      'financialRecords',
      {
        where: {
          subscriptionId: subscription.id,
        },
        orderBy: { id: 'desc' }, // Pega o mais recente
      },
    );

    const { paymentMethod, creditCard, customerData } = dto;

    // Se tem registro financeiro existente
    if (existingFinancialRecord) {
      console.log('Registro financeiro encontrado:', existingFinancialRecord.id);
      console.log('Status atual:', existingFinancialRecord.status);
      console.log('Método anterior no BD:', existingFinancialRecord.paymentMethod);
      console.log('Novo método solicitado:', paymentMethod);
      console.log('Métodos são diferentes?', existingFinancialRecord.paymentMethod !== paymentMethod);

      // Se o pagamento já foi recebido, não permite reprocessar
      if (existingFinancialRecord.status === 'received') {
        throw new BadRequestException(
          'O pagamento desta inscrição já foi confirmado',
        );
      }

      // Se está mudando o método de pagamento ou reprocessando
      if (existingFinancialRecord.paymentMethod !== paymentMethod || 
          (paymentMethod === 'cartaoCredito' && creditCard)) {
        console.log('Processando pagamento com novo método ou dados...');
        console.log('Motivo: mudança de método ou reprocessamento de cartão');
        
        // Processa o pagamento (vai atualizar o registro financeiro existente)
        try {
          const checkoutResult = await this.checkoutService.processCheckout(
            {
              subscriptionId: subscription.id,
              paymentMethod,
              creditCard,
              customerData,
              financialRecordId: existingFinancialRecord.id, // Passa o ID do registro existente
            },
            courseClass.companyId,
          );

          // Se for cartão e foi aprovado, atualiza status da inscrição
          if (
            paymentMethod === 'cartaoCredito' &&
            checkoutResult.payment?.status === 'CONFIRMED'
          ) {
            await this.prisma.update(
              entity.model,
              {
                subscribeStatus: 'confirmed',
                confirmedAt: new Date(),
              },
              { userId: 1, companyId: courseClass.companyId },
              null,
              subscription.id,
              null,
            );
          }

          // Retorna a inscrição com os novos dados
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
      } else {
        // Para PIX/Boleto com mesmo método, retorna os dados existentes
        console.log('Retornando dados existentes de PIX/Boleto...');
        
        // Busca os dados completos do registro financeiro
        const financialRecordData = await this.prisma.selectFirst(
          'financialRecords',
          {
            where: { id: existingFinancialRecord.id },
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
          },
        );

        // Formata a resposta do payment baseado no responseData
        const paymentData = financialRecordData.responseData || {};
        
        return {
          ...subscription,
          payment: paymentData,
          financialRecordId: financialRecordData.id,
          financialRecord: {
            id: financialRecordData.id,
            status: financialRecordData.status,
            paymentMethod: financialRecordData.paymentMethod,
            value: financialRecordData.value,
            dueDate: financialRecordData.dueDate,
            paidAt: financialRecordData.paidAt,
            billUrl: financialRecordData.billUrl,
            billNumber: financialRecordData.billNumber,
            pixUrl: financialRecordData.pixUrl,
            pixNumber: financialRecordData.pixNumber,
            externalId: financialRecordData.externalId,
            key: financialRecordData.key,
          },
        };
      }
    } else {
      // Não tem registro financeiro, cria novo pagamento
      console.log('Sem registro financeiro, criando novo pagamento...');
      
      try {
        const checkoutResult = await this.checkoutService.processCheckout(
          {
            subscriptionId: subscription.id,
            paymentMethod,
            creditCard,
            customerData,
          },
          courseClass.companyId,
        );

        // Se for cartão e foi aprovado, atualiza status
        if (
          paymentMethod === 'cartaoCredito' &&
          checkoutResult.payment?.status === 'CONFIRMED'
        ) {
          await this.prisma.update(
            entity.model,
            {
              subscribeStatus: 'confirmed',
              confirmedAt: new Date(),
            },
            { userId: 1, companyId: courseClass.companyId },
            null,
            subscription.id,
            null,
          );
        }

        return {
          ...subscription,
          payment: checkoutResult.payment,
          financialRecordId: checkoutResult.financialRecordId,
          financialRecord: checkoutResult.financialRecord,
        };
      } catch (error) {
        console.error('Erro ao criar novo pagamento:', error);
        throw new BadRequestException(
          error.message || 'Erro ao processar pagamento',
        );
      }
    }
  }

}
