import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { SplitStatus } from '@prisma/client';

interface CreateSplitTransactionDto {
  financialRecordId: number;
  toWalletId: string;
  sellerId: number;
  originalValue: number;
  splitValue: number;
  splitPercentage?: number;
  splitDescription: string;
  companyId: number;
  asaasSplitId?: string;
}

interface UpdateSplitTransactionDto {
  status?: SplitStatus;
  processedAt?: Date;
  settledAt?: Date;
  withdrawnAt?: Date;
  asaasSplitId?: string;
  asaasTransferId?: string;
  gatewayResponse?: any;
  hasDivergence?: boolean;
  divergenceReason?: string;
  divergenceResolvedAt?: Date;
}

@Injectable()
export class SplitTransactionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria um novo registro de split transaction
   */
  async createSplitTransaction(data: CreateSplitTransactionDto) {
    try {
      // Calcula o valor líquido (estimado - 2.99% de taxa do Asaas)
      const netValue = data.splitValue * 0.9701;

      const splitTransaction = await this.prisma.splitTransaction.create({
        data: {
          financialRecordId: data.financialRecordId,
          toWalletId: data.toWalletId,
          sellerId: data.sellerId,
          originalValue: data.originalValue,
          splitValue: data.splitValue,
          splitPercentage: data.splitPercentage,
          netValue: netValue,
          splitDescription: data.splitDescription,
          companyId: data.companyId,
          status: SplitStatus.PENDING,
          asaasSplitId: data.asaasSplitId,
        },
      });

      console.log('Split Transaction criado:', splitTransaction.id);
      return splitTransaction;
    } catch (error) {
      console.error('Erro ao criar SplitTransaction:', error);
      // Não lança erro para não bloquear o fluxo principal
      return null;
    }
  }

  /**
   * Atualiza o status de um split transaction
   */
  async updateSplitTransaction(id: number, data: UpdateSplitTransactionDto) {
    try {
      const updated = await this.prisma.splitTransaction.update({
        where: { id },
        data,
      });

      console.log(`Split Transaction ${id} atualizado:`, data.status);
      return updated;
    } catch (error) {
      console.error(`Erro ao atualizar SplitTransaction ${id}:`, error);
      throw error;
    }
  }

  /**
   * Busca split transaction por financialRecordId
   */
  async findByFinancialRecord(financialRecordId: number) {
    return this.prisma.splitTransaction.findMany({
      where: { financialRecordId },
      include: {
        seller: true,
      },
    });
  }

  /**
   * Busca split transaction por sellerId
   */
  async findBySeller(sellerId: number, status?: SplitStatus) {
    const where: any = { sellerId };
    if (status) {
      where.status = status;
    }

    return this.prisma.splitTransaction.findMany({
      where,
      include: {
        financialRecord: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Busca split transaction por asaasSplitId
   */
  async findByAsaasSplitId(asaasSplitId: string) {
    return this.prisma.splitTransaction.findFirst({
      where: { asaasSplitId },
    });
  }

  /**
   * Processa webhook de split do Asaas
   */
  async processWebhook(asaasSplitId: string, eventType: string, data: any) {
    try {
      const split = await this.findByAsaasSplitId(asaasSplitId);

      if (!split) {
        console.log(`Split não encontrado para asaasSplitId: ${asaasSplitId}`);
        return;
      }

      const updateData: UpdateSplitTransactionDto = {
        gatewayResponse: data,
      };

      // Atualiza status baseado no evento
      switch (eventType) {
        case 'SPLIT_PROCESSED':
        case 'PAYMENT_CONFIRMED':
          updateData.status = SplitStatus.CONFIRMED;
          updateData.processedAt = new Date();
          break;

        case 'SPLIT_SETTLED':
        case 'PAYMENT_RECEIVED':
          updateData.status = SplitStatus.SETTLED;
          updateData.settledAt = new Date();
          break;

        case 'SPLIT_WITHDRAWN':
          updateData.status = SplitStatus.WITHDRAWN;
          updateData.withdrawnAt = new Date();
          break;

        case 'SPLIT_FAILED':
        case 'PAYMENT_DELETED':
          updateData.status = SplitStatus.FAILED;
          updateData.hasDivergence = true;
          updateData.divergenceReason =
            data.reason || 'Falha no processamento do split';
          break;

        case 'PAYMENT_REFUNDED':
        case 'SPLIT_REFUNDED':
          updateData.status = SplitStatus.REFUNDED;
          updateData.hasDivergence = true;
          updateData.divergenceReason = 'Pagamento estornado';
          break;

        case 'TRANSFER_CREATED':
          if (data.transferId) {
            updateData.asaasTransferId = data.transferId;
          }
          break;
      }

      await this.updateSplitTransaction(split.id, updateData);
      console.log(`Webhook de split processado: ${eventType}`);
    } catch (error) {
      console.error('Erro ao processar webhook de split:', error);
    }
  }

  /**
   * Calcula totais de splits por vendedor
   */
  async calculateSellerTotals(
    sellerId: number,
    startDate?: Date,
    endDate?: Date,
  ) {
    const where: any = { sellerId };

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const splits = await this.prisma.splitTransaction.findMany({
      where,
    });

    const totals = {
      pending: 0,
      confirmed: 0,
      settled: 0,
      withdrawn: 0,
      failed: 0,
      refunded: 0,
      total: 0,
    };

    splits.forEach((split) => {
      const value = Number(split.splitValue);
      totals.total += value;

      switch (split.status) {
        case SplitStatus.PENDING:
          totals.pending += value;
          break;
        case SplitStatus.CONFIRMED:
          totals.confirmed += value;
          break;
        case SplitStatus.SETTLED:
          totals.settled += value;
          break;
        case SplitStatus.WITHDRAWN:
          totals.withdrawn += value;
          break;
        case SplitStatus.FAILED:
          totals.failed += value;
          break;
        case SplitStatus.REFUNDED:
          totals.refunded += value;
          break;
      }
    });

    return totals;
  }
}
