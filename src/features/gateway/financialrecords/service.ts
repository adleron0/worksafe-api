import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';

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
   * Método específico customizado
   */
  // async customMethod(params: any): Promise<IEntity | null> {
  //   try {
  //     const result = await this.prisma.selectOne('modelName', {
  //       where: {
  //         id: Number(params.id),
  //       },
  //     });
  //   } catch (error) {
  //     throw new BadRequestException(error);
  //   }
  // }
}
