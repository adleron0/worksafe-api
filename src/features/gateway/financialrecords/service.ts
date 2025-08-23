import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { paymentMethods, financialRecordsStatus } from '@prisma/client';

@Injectable()
export class FinancialrecordsService extends GenericService<
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
   * Cria um registro financeiro para uma inscrição
   */
  async createFinancialRecord(params: {
    subscriptionId: number;
    traineeId: number;
    customerId?: number;
    companyId: number;
    classId: number;
    paymentMethod: paymentMethods;
    value: number;
    gateway: string;
    description?: string;
  }): Promise<any> {
    try {
      const currentDate = new Date();
      const accrualDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
      
      // Adiciona 1 dia ao vencimento
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 1);

      const financialRecord = await this.prisma.financialRecords.create({
        data: {
          accrualDate,
          companyId: params.companyId,
          gateway: params.gateway as any,
          status: financialRecordsStatus.processing,
          subscriptionId: params.subscriptionId,
          traineeId: params.traineeId,
          customerId: params.customerId,
          paymentMethod: params.paymentMethod,
          value: params.value,
          dueDate,
          description: params.description || `Inscrição no curso - Turma ${params.classId}`,
        },
      });

      return financialRecord;
    } catch (error) {
      console.error('Erro ao criar registro financeiro:', error);
      throw new BadRequestException('Erro ao criar registro financeiro');
    }
  }

  /**
   * Atualiza um registro financeiro com os dados de resposta do gateway
   */
  async updateFinancialRecord(
    id: number,
    data: {
      status?: financialRecordsStatus;
      externalId?: string;
      billUrl?: string;
      billNumber?: string;
      pixUrl?: string;
      pixNumber?: string;
      responseData?: any;
      errorData?: any;
      paidAt?: Date;
    },
  ): Promise<any> {
    try {
      const updated = await this.prisma.financialRecords.update({
        where: { id },
        data,
      });
      return updated;
    } catch (error) {
      console.error('Erro ao atualizar registro financeiro:', error);
      throw new BadRequestException('Erro ao atualizar registro financeiro');
    }
  }

  /**
   * Busca um registro financeiro pelo ID
   */
  async getFinancialRecordById(id: number): Promise<any> {
    try {
      const record = await this.prisma.financialRecords.findFirst({
        where: { id },
        include: {
          subscription: true,
          trainee: true,
          customer: true,
          company: true,
        },
      });

      if (!record) {
        throw new HttpException('Registro financeiro não encontrado', HttpStatus.NOT_FOUND);
      }

      return record;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadRequestException('Erro ao buscar registro financeiro');
    }
  }

  /**
   * Marca um registro financeiro como pago
   */
  async markAsPaid(id: number, externalData?: any): Promise<any> {
    try {
      const updateData: any = {
        status: financialRecordsStatus.received,
        paidAt: new Date(),
      };

      if (externalData) {
        updateData.responseData = externalData;
      }

      return await this.updateFinancialRecord(id, updateData);
    } catch (error) {
      throw new BadRequestException('Erro ao marcar registro como pago');
    }
  }

  /**
   * Marca um registro financeiro como cancelado
   */
  async markAsCancelled(id: number, reason?: string): Promise<any> {
    try {
      const updateData: any = {
        status: financialRecordsStatus.cancelled,
        observations: reason,
      };

      return await this.updateFinancialRecord(id, updateData);
    } catch (error) {
      throw new BadRequestException('Erro ao cancelar registro financeiro');
    }
  }
}
