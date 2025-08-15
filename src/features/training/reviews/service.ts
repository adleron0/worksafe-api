import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';

@Injectable()
export class ReviewsService extends GenericService<
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
   * Método específico para criação de review pelos alunos
   */
  async createReview(
    search: any,
    entity: any,
    CreateDto: CreateDto,
  ): Promise<IEntity> {
    try {
      // Validar se o aluno pertence à turma
      if (CreateDto.traineeId && CreateDto.classId) {
        const subscription = await this.prisma.selectFirst(
          'courseClassSubscription',
          {
            where: {
              traineeId: CreateDto.traineeId,
              classId: CreateDto.classId,
              subscribeStatus: 'confirmed',
              inactiveAt: null,
            },
          },
        );

        if (!subscription) {
          throw new BadRequestException(
            'Aluno não está inscrito nesta turma ou inscrição não está aprovada',
          );
        }
      }

      // Verificar se já existe uma review deste aluno para esta turma
      const existingReview = await this.prisma.selectFirst('courseReview', {
        where: search,
      });

      if (existingReview) {
        throw new BadRequestException(
          'Você já enviou uma avaliação para esta turma',
        );
      }

      // Buscar informações da turma para obter o courseId
      const classInfo = await this.prisma.selectOne('courseClass', {
        where: {
          id: CreateDto.classId,
        },
      });

      if (!classInfo) {
        throw new BadRequestException('Turma não encontrada');
      }

      // Adicionar o courseId ao CreateDto e valores padrão para campos JSON obrigatórios
      const reviewData = {
        ...CreateDto,
        courseId: classInfo.courseId,
        companyId: classInfo.companyId,
        courseReview: CreateDto.courseReview || {},
        instructorReview: CreateDto.instructorReview || {},
      };

      const logParams = {
        userId: 0, // Sistema/público
        companyId: classInfo.companyId,
      };

      // Criar o review
      const result = await this.prisma.insert(
        entity.model,
        reviewData,
        logParams,
      );

      return result;
    } catch (error) {
      throw new BadRequestException(error.message || error);
    }
  }
}
