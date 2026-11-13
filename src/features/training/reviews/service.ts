import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { toBoolean } from 'src/utils/toBoolean';

@Injectable()
export class ReviewsService {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
  ) {}

  /**
   * Método específico para criação de review pelos alunos
   */
  async createReview(_search: any, entity: any, CreateDto: any): Promise<any> {
    try {
      // Rota pública com FormData: tudo chega como string. Converte antes de
      // consultar/gravar (o Prisma recusa "13" em campo Int).
      const traineeId = Number(CreateDto.traineeId);
      const classId = Number(CreateDto.classId);
      if (!Number.isInteger(traineeId) || !Number.isInteger(classId)) {
        throw new BadRequestException('Aluno e turma são obrigatórios');
      }
      const generalRating = Number(CreateDto.generalRating);
      if (
        !Number.isInteger(generalRating) ||
        generalRating < 0 ||
        generalRating > 5
      ) {
        throw new BadRequestException('Nota inválida');
      }

      // Validar se o aluno pertence à turma
      {
        const subscription = await this.prisma.selectFirst(
          'courseClassSubscription',
          {
            where: {
              traineeId,
              classId,
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
        where: { traineeId, classId, inactiveAt: null },
      });

      if (existingReview) {
        throw new BadRequestException(
          'Você já enviou uma avaliação para esta turma',
        );
      }

      // Buscar informações da turma para obter o courseId
      const classInfo = await this.prisma.selectOne('courseClass', {
        where: {
          id: classId,
        },
      });

      if (!classInfo) {
        throw new BadRequestException('Turma não encontrada');
      }

      // Adicionar o courseId ao CreateDto e valores padrão para campos JSON obrigatórios
      const parseJson = (value: unknown) => {
        if (typeof value !== 'string') return value || {};
        try {
          return JSON.parse(value);
        } catch {
          return {};
        }
      };
      const reviewData = {
        traineeId,
        classId,
        courseId: classInfo.courseId,
        companyId: classInfo.companyId,
        generalRating,
        opinionRating: CreateDto.opinionRating
          ? String(CreateDto.opinionRating)
          : null,
        authorizationExposeReview: toBoolean(
          CreateDto.authorizationExposeReview,
        ),
        courseReview: parseJson(CreateDto.courseReview),
        instructorReview: parseJson(CreateDto.instructorReview),
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
