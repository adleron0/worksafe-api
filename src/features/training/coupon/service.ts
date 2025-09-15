import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';

@Injectable()
export class CouponService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
  ) {
    super(prisma, uploadService);
  }

  /**
   * Valida se cupom pode ser usado
   * @param cpf - CPF do trainee (sem máscara)
   * @param code - Código do cupom
   * @param classId - ID da turma
   * @param internal - Se true, retorna dados de comissão (opcional, default: false)
   * @returns Objeto com validação e valores
   */
  async validateCoupon(
    cpf: string,
    code: string,
    classId: number,
    internal: boolean = false,
  ) {
    try {
      // 1. Buscar turma - USANDO PRISMASERVICE
      const courseClass = await this.prisma.selectOne('courseClass', {
        where: { id: classId },
        include: { course: true },
      });

      if (!courseClass || !courseClass.active) {
        const response: any = {
          valid: false,
          finalPrice: 0,
          discount: 0,
          message: 'Turma não encontrada ou inativa',
        };

        if (internal) {
          response.commissionPercentage = 0;
          response.commissionValue = 0;
        }

        return response;
      }

      // 2. Buscar cupom - USANDO PRISMASERVICE
      const coupon = await this.prisma.selectFirst('coupon', {
        where: {
          code: code.toUpperCase(),
          companyId: courseClass.companyId,
          active: true,
        },
        include: {
          seller: true,
          _count: {
            select: {
              financialRecords: {
                where: { status: { in: ['waiting', 'received'] } },
              },
            },
          },
        },
      });
      console.log('🚀 ~ CouponService ~ validateCoupon ~ coupon:', coupon);

      if (!coupon) {
        const response: any = {
          valid: false,
          finalPrice: Number(courseClass.price),
          discount: 0,
          message: 'Cupom não encontrado',
        };

        if (internal) {
          response.commissionPercentage = 0;
          response.commissionValue = 0;
        }

        return response;
      }

      // 3. Validar data de validade
      const now = new Date();
      if (
        coupon.validFrom > now ||
        (coupon.validUntil && coupon.validUntil < now)
      ) {
        const response: any = {
          valid: false,
          finalPrice: Number(courseClass.price),
          discount: 0,
          message: 'Cupom fora do período de validade',
        };

        if (internal) {
          response.commissionPercentage = 0;
          response.commissionValue = 0;
        }

        return response;
      }

      // 4. Validar restrições de curso/turma
      if (coupon.courseId && coupon.courseId !== courseClass.courseId) {
        const response: any = {
          valid: false,
          finalPrice: Number(courseClass.price),
          discount: 0,
          message: 'Cupom não válido para este curso',
        };

        if (internal) {
          response.commissionPercentage = 0;
          response.commissionValue = 0;
        }

        return response;
      }

      if (coupon.classId && coupon.classId !== courseClass.id) {
        const response: any = {
          valid: false,
          finalPrice: Number(courseClass.price),
          discount: 0,
          message: 'Cupom não válido para esta turma',
        };

        if (internal) {
          response.commissionPercentage = 0;
          response.commissionValue = 0;
        }

        return response;
      }

      // 5. Verificar limite total de uso
      if (
        coupon.usageLimit &&
        coupon._count.financialRecords >= coupon.usageLimit
      ) {
        const response: any = {
          valid: false,
          finalPrice: Number(courseClass.price),
          discount: 0,
          message: 'Cupom esgotado',
        };

        if (internal) {
          response.commissionPercentage = 0;
          response.commissionValue = 0;
        }

        return response;
      }

      // 6. Buscar trainee e verificar limite por aluno - USANDO PRISMASERVICE
      const trainee = await this.prisma.selectFirst('trainee', {
        where: { cpf, customerId: courseClass.customerId },
      });

      if (trainee) {
        // Contar uso do cupom pelo trainee - QUERY NATIVA (count não tem no PrismaService)
        const traineeUsage = await this.prisma.financialRecords.count({
          where: {
            couponId: coupon.id,
            traineeId: trainee.id,
            status: { in: ['waiting', 'received'] },
          },
        });

        if (traineeUsage >= coupon.usagePerCustomer) {
          const response: any = {
            valid: false,
            finalPrice: Number(courseClass.price),
            discount: 0,
            message: 'Limite de uso por aluno excedido',
          };

          if (internal) {
            response.commissionPercentage = 0;
            response.commissionValue = 0;
          }

          return response;
        }
      }

      // 7. Verificar primeira compra
      if (coupon.firstPurchaseOnly && trainee) {
        // Contar pedidos do trainee - QUERY NATIVA (count não tem no PrismaService)
        const hasOrders = await this.prisma.financialRecords.count({
          where: {
            traineeId: trainee.id,
            status: { in: ['waiting', 'received'] },
          },
        });

        if (hasOrders > 0) {
          const response: any = {
            valid: false,
            finalPrice: Number(courseClass.price),
            discount: 0,
            message: 'Cupom válido apenas para primeira compra',
          };

          if (internal) {
            response.commissionPercentage = 0;
            response.commissionValue = 0;
          }

          return response;
        }
      }

      // 8. Calcular desconto
      const originalPrice = courseClass.discountPrice
        ? Number(courseClass.discountPrice)
        : Number(courseClass.price);

      let discount = 0;
      if (coupon.discountType === 'percentage') {
        discount = (originalPrice * Number(coupon.discountValue)) / 100;
      } else {
        discount = Math.min(Number(coupon.discountValue), originalPrice);
      }

      // Aplicar limite máximo de desconto
      if (coupon.maxDiscountValue) {
        discount = Math.min(discount, Number(coupon.maxDiscountValue));
      }

      // 9. Verificar valor mínimo
      if (
        coupon.minPurchaseValue &&
        originalPrice < Number(coupon.minPurchaseValue)
      ) {
        const response: any = {
          valid: false,
          finalPrice: originalPrice,
          discount: 0,
          message: `Valor mínimo de compra: R$ ${coupon.minPurchaseValue}`,
        };

        if (internal) {
          response.commissionPercentage = 0;
          response.commissionValue = 0;
        }

        return response;
      }

      const finalPrice = originalPrice - discount;

      // 10. Calcular comissão (sobre valor final)
      let commissionPercentage = 0;
      let commissionValue = 0;

      if (coupon.commissionType === 'percentage' && coupon.commissionValue) {
        commissionPercentage = Number(coupon.commissionValue);
        commissionValue = (finalPrice * commissionPercentage) / 100;
      } else if (coupon.commissionType === 'fixed' && coupon.commissionValue) {
        commissionValue = Number(coupon.commissionValue);
        // Converter valor fixo em percentual sobre o valor final
        commissionPercentage = (commissionValue / finalPrice) * 100;
      }

      // ✅ Cupom válido!
      const response: any = {
        valid: true,
        finalPrice: Number(finalPrice.toFixed(2)),
        discount: Number(discount.toFixed(2)),
        message: 'Cupom aplicado com sucesso',
      };

      // Só retorna dados de comissão se internal for true
      if (internal) {
        response.commissionPercentage = Number(commissionPercentage.toFixed(2));
        response.commissionValue = Number(commissionValue.toFixed(2));
      }

      return response;
    } catch (error) {
      console.error('Erro ao validar cupom:', error);
      const response: any = {
        valid: false,
        finalPrice: 0,
        discount: 0,
        message: 'Erro ao processar cupom',
      };

      if (internal) {
        response.commissionPercentage = 0;
        response.commissionValue = 0;
      }

      return response;
    }
  }
}
