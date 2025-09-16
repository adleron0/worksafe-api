import { GenericService } from 'src/features/generic/generic.service';
import { Injectable } from '@nestjs/common';
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
   * Cria uma resposta padronizada para validação de cupom
   */
  private createValidationResponse(
    valid: boolean,
    finalPrice: number,
    discount: number,
    message: string,
    internal: boolean,
    extras?: {
      commissionPercentage?: number;
      commissionValue?: number;
      couponId?: number;
      sellerId?: number;
      sellerWalletId?: string | null;
    },
  ): any {
    const response: any = {
      valid,
      finalPrice,
      discount,
      message,
    };

    if (internal) {
      if (valid && extras) {
        response.commissionPercentage = extras.commissionPercentage || 0;
        response.commissionValue = extras.commissionValue || 0;
        response.couponId = extras.couponId;
        response.sellerId = extras.sellerId;
        response.sellerWalletId = extras.sellerWalletId;
      } else {
        response.commissionPercentage = 0;
        response.commissionValue = 0;
      }
    }

    return response;
  }

  /**
   * Calcula o preço base da turma (com desconto se houver)
   */
  private getClassPrice(courseClass: any): number {
    return Number(courseClass.discountPrice) || Number(courseClass.price);
  }

  /**
   * Calcula comissão baseada no cupom e valor final
   */
  private calculateCommission(
    coupon: any,
    finalPrice: number,
  ): {
    commissionPercentage: number;
    commissionValue: number;
  } {
    let commissionPercentage = 0;
    let commissionValue = 0;

    if (coupon.commissionType === 'percentage' && coupon.commissionValue) {
      commissionPercentage = Number(coupon.commissionValue);
      commissionValue = (finalPrice * commissionPercentage) / 100;
    } else if (coupon.commissionType === 'fixed' && coupon.commissionValue) {
      commissionValue = Number(coupon.commissionValue);
      commissionPercentage = (commissionValue / finalPrice) * 100;
    }

    return {
      commissionPercentage: Number(commissionPercentage.toFixed(2)),
      commissionValue: Number(commissionValue.toFixed(2)),
    };
  }

  /**
   * Valida e retorna o walletId do vendedor para o ambiente correto
   */
  private getSellerWalletId(seller: any): string | null {
    if (!seller?.sellerConfig) {
      return null;
    }

    try {
      const config = typeof seller.sellerConfig === 'string'
        ? JSON.parse(seller.sellerConfig)
        : seller.sellerConfig;

      // Verifica se tem a estrutura correta
      if (!config.gateways?.asaas) {
        return null;
      }

      // Determina o ambiente baseado na variável de ambiente
      const isDevelopment = process.env.BASE_SETUP === 'development';
      const environment = isDevelopment ? 'sandbox' : 'production';

      // Verifica se existe configuração para o ambiente
      const asaasConfig = config.gateways.asaas[environment];

      if (!asaasConfig) {
        return null;
      }

      // Valida campos obrigatórios
      const requiredFields = ['apiKey', 'walletId', 'accountId'];
      const hasAllFields = requiredFields.every(field => asaasConfig[field]);

      if (!hasAllFields) {
        return null;
      }

      // Valida se a conta está ativa
      if (asaasConfig.accountStatus !== 'ACTIVE') {
        return null;
      }

      // Retorna apenas o walletId do ambiente correto
      return asaasConfig.walletId;
    } catch (error) {
      console.error('Erro ao validar sellerConfig:', error);
      return null;
    }
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
        return this.createValidationResponse(
          false,
          0, // finalPrice = 0 quando turma não encontrada
          0,
          'Turma não encontrada ou inativa',
          internal,
        );
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

      if (!coupon) {
        return this.createValidationResponse(
          false,
          this.getClassPrice(courseClass),
          0,
          'Cupom não encontrado',
          internal,
        );
      }

      // 3. Validar data de validade
      const now = new Date();
      if (
        coupon.validFrom > now ||
        (coupon.validUntil && coupon.validUntil < now)
      ) {
        return this.createValidationResponse(
          false,
          this.getClassPrice(courseClass),
          0,
          'Cupom fora do período de validade',
          internal,
        );
      }

      // 4. Validar restrições de curso/turma
      if (coupon.courseId && coupon.courseId !== courseClass.courseId) {
        return this.createValidationResponse(
          false,
          this.getClassPrice(courseClass),
          0,
          'Cupom não válido para este curso',
          internal,
        );
      }

      if (coupon.classId && coupon.classId !== courseClass.id) {
        return this.createValidationResponse(
          false,
          this.getClassPrice(courseClass),
          0,
          'Cupom não válido para esta turma',
          internal,
        );
      }

      // 5. Verificar limite total de uso
      if (
        coupon.usageLimit &&
        coupon._count.financialRecords >= coupon.usageLimit
      ) {
        return this.createValidationResponse(
          false,
          this.getClassPrice(courseClass),
          0,
          'Cupom esgotado',
          internal,
        );
      }

      // 6. Buscar trainee e verificar limite por aluno - USANDO PRISMASERVICE
      const trainee = await this.prisma.selectFirst('trainee', {
        where: {
          cpf,
        },
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
          return this.createValidationResponse(
            false,
            this.getClassPrice(courseClass),
            0,
            'Limite de uso por aluno excedido',
            internal,
          );
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
          return this.createValidationResponse(
            false,
            this.getClassPrice(courseClass),
            0,
            'Cupom válido apenas para primeira compra',
            internal,
          );
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
        return this.createValidationResponse(
          false,
          originalPrice, // Usa o preço original calculado, não o getClassPrice
          0,
          `Valor mínimo de compra: R$ ${coupon.minPurchaseValue}`,
          internal,
        );
      }

      const finalPrice = originalPrice - discount;

      // 10. Calcular comissão (sobre valor final)
      const commission = this.calculateCommission(coupon, finalPrice);

      // 11. Obter walletId do vendedor se internal = true
      let sellerWalletId = null;
      if (internal && coupon.seller) {
        sellerWalletId = this.getSellerWalletId(coupon.seller);
      }

      // ✅ Cupom válido!
      return this.createValidationResponse(
        true,
        Number(finalPrice.toFixed(2)),
        Number(discount.toFixed(2)),
        'Cupom aplicado com sucesso',
        internal,
        {
          commissionPercentage: commission.commissionPercentage,
          commissionValue: commission.commissionValue,
          couponId: coupon.id,
          sellerId: coupon.sellerId,
          sellerWalletId: sellerWalletId,
        },
      );
    } catch (error) {
      console.error('Erro ao validar cupom:', error);
      return this.createValidationResponse(
        false,
        0, // finalPrice = 0 em caso de erro
        0,
        'Erro ao processar cupom',
        internal,
      );
    }
  }
}
