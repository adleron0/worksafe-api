import { GenericService } from 'src/features/generic/generic.service';
import { PrismaClient } from '@prisma/client';
import { BadRequestException, Injectable, Inject, forwardRef } from '@nestjs/common';
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
      const verify = await this.prisma.selectFirst(entity.model, {
        where: {
          ...search,
        },
      });
      if (verify) {
        throw new BadRequestException(`${entity.name} já cadastrado`);
      }

      // Pesquisa a turma com todos os dados necessários
      const courseClass = await this.prisma.selectFirst('courseClass', {
        where: {
          companyId: Number(search.companyId),
          id: Number(search.classId),
        },
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
        if (dto.paymentMethod === 'cartaoCredito' && !dto.creditCard) {
          throw new BadRequestException(
            'Dados do cartão são obrigatórios para pagamento com cartão de crédito',
          );
        }
      }

      const logParams = {
        userId: 0,
        companyId: dto.companyId || null,
      };

      // Remove campos de pagamento do DTO antes de criar a inscrição
      const { paymentMethod, creditCard, customerData, ...subscriptionData } = dto;

      const created = await this.prisma.insert(
        entity.model,
        {
          ...subscriptionData,
        },
        logParams,
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
          if (paymentMethod === 'cartaoCredito' && checkoutResult.payment?.status === 'CONFIRMED') {
            await this.prisma.update(entity.model, created.id, {
              subscribeStatus: 'confirmed',
              confirmedAt: new Date(),
            });
          }

          // Retorna a inscrição com os dados do pagamento
          return {
            ...created,
            payment: checkoutResult.payment,
            financialRecordId: checkoutResult.financialRecordId,
          };
        } catch (error) {
          // Se falhar o pagamento, ainda assim retorna a inscrição criada
          console.error('Erro ao processar pagamento:', error);
          return {
            ...created,
            paymentError: error.message || 'Erro ao processar pagamento',
          };
        }
      }

      return created;
    } catch (error) {
      console.log("🚀 ~ SubscriptionService ~ subscription ~ error:", error)
      throw new BadRequestException(error);
    }
  }

}
