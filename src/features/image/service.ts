import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from '../upload/upload.service';

@Injectable()
export class ImageService {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
  ) {}

  async deleteImage(id: number, companyId: number, logParams?: any): Promise<void> {
    try {
      const image = await this.prisma.selectFirst('image', {
        where: { id: Number(id), companyId },
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

  /**
   * Upload de imagem para o S3
   * @param file Arquivo enviado via multer
   * @returns URL da imagem no S3
   */
  async uploadToS3(file: Express.MulterS3.File): Promise<{ url: string }> {
    try {
      if (!file) {
        throw new BadRequestException('Nenhum arquivo foi enviado');
      }

      if (!file.location) {
        throw new BadRequestException('Erro ao fazer upload do arquivo');
      }

      return {
        url: file.location,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        'Erro ao fazer upload da imagem: ' + error.message,
      );
    }
  }
}
