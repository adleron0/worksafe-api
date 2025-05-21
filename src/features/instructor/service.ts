import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GenericService } from 'src/features/generic/generic.service';
// entity template imports
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/features/prisma/prisma.service';
import { PrismaClient } from '@prisma/client';
import { UploadService } from '../upload/upload.service';

type logParams = {
  userId: string;
  companyId: string;
};

type entity = {
  model: keyof PrismaClient;
  name: string;
  route: string;
  permission: string;
};

@Injectable()
export class InstructorService extends GenericService<
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

  async signature(
    id: number,
    dto: UpdateDto,
    logParams: logParams,
    entity: entity,
    file?: Express.MulterS3.File,
  ): Promise<IEntity> {
    try {
      const verifyExist = await this.prisma.selectOne(entity.model, {
        where: {
          id: Number(id),
        },
      });

      if (!verifyExist) {
        throw new NotFoundException(`${entity.name} não encontrado`);
      }

      // Se uma nova imagem foi enviada, exclui a imagem antiga e define a nova URL
      if (file) {
        if (verifyExist.signatureUrl) {
          await this.uploadService.deleteImageFromS3(verifyExist.signatureUrl);
        }
        dto['signatureUrl'] = file.location;
      }

      // Se `dto.signatureUrl` é null e não há nova imagem, exclui a imagem existente
      if (!dto['signatureUrl'] && !file && verifyExist.signatureUrl) {
        await this.uploadService.deleteImageFromS3(verifyExist.signatureUrl);
        dto['signatureUrl'] = null;
      }

      const updated = await this.prisma.update(
        entity.model,
        {
          ...dto,
        },
        logParams,
        {},
        id,
      );
      return updated;
    } catch (error) {
      console.log('🚀 ~ error:', error);
      throw new BadRequestException(error);
    }
  }
}
