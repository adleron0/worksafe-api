import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';

@Injectable()
export class StudentService {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
  ) {
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
