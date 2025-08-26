import { GenericService } from 'src/features/generic/generic.service';
import {
  BadRequestException,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { financialRecordsStatus } from '@prisma/client';

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

  // Métodos removidos - usar PrismaService diretamente:
  // - createFinancialRecord: usar prisma.insert('financialRecords', ...)
  // - updateFinancialRecord: usar prisma.update('financialRecords', ...)
  // - getFinancialRecordById: usar prisma.selectOne('financialRecords', ...)
  // - getFinancialRecordSummary: usar prisma.selectOne('financialRecords', { select: {...} })

  /**
   * Busca um registro financeiro pela key (UUID)
   */
  async getFinancialRecordByKey(key: string): Promise<any> {
    console.log(
      '🚀 ~ FinancialrecordsService ~ getFinancialRecordByKey ~ key:',
      key,
    );
    try {
      const record = await this.prisma.selectFirst('financialRecords', {
        where: { key },
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
        },
      });

      if (!record) {
        throw new HttpException(
          'Registro financeiro não encontrado',
          HttpStatus.NOT_FOUND,
        );
      }

      return record;
    } catch (error) {
      console.log(
        '🚀 ~ FinancialrecordsService ~ getFinancialRecordByKey ~ error:',
        error,
      );
      if (error instanceof HttpException) throw error;
      throw new BadRequestException('Erro ao buscar registro financeiro');
    }
  }

  /**
   * Marca um registro financeiro como pago
   */
  async markAsPaid(id: number, externalData?: any): Promise<any> {
    const updateData: any = {
      status: financialRecordsStatus.received,
      paidAt: new Date(),
    };

    if (externalData) {
      updateData.responseData = externalData;
    }

    return await this.prisma.update(
      'financialRecords',
      updateData,
      {}, // logParams
      null,
      id,
    );
  }

  /**
   * Marca um registro financeiro como cancelado
   */
  async markAsCancelled(id: number, reason?: string): Promise<any> {
    const updateData: any = {
      status: financialRecordsStatus.cancelled,
      observations: reason,
    };

    return await this.prisma.update(
      'financialRecords',
      updateData,
      {}, // logParams
      null,
      id,
    );
  }
}
