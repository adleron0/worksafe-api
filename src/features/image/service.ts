import { GenericService } from 'src/features/generic/generic.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from '../upload/upload.service';

@Injectable()
export class ImageService extends GenericService<
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

  async deleteImage(id: number, logParams?: any): Promise<void> {
    try {
      const image = await this.prisma.selectOne('image', {
        where: { id: Number(id) },
      });

      if (!image) {
        throw new NotFoundException('Imagem não encontrada');
      }

      await this.uploadService.deleteImageFromS3(image.imageUrl);

      await this.prisma.erase(
        'image',
        { where: { id: Number(id) } },
        logParams,
        false,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException('Erro ao deletar imagem: ' + error.message);
    }
  }
}
