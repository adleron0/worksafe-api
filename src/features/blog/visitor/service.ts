import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';

@Injectable()
export class VisitorService extends GenericService<
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
   * Define o status de bloqueio de um visitante
   */
  async setBlocked(id: number, blocked: boolean): Promise<IEntity> {
    try {
      const result = await this.prisma.blog_Visitor.update({
        where: { id },
        data: { blocked },
      });
      return result as IEntity;
    } catch (error) {
      throw new BadRequestException(error);
    }
  }
}
