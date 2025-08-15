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
import { PrismaClient } from '@prisma/client';
import { getExpirationDate } from 'src/utils/dataFunctions';
import { makeVariablesToReplace } from 'src/helpers/makeVariablesToReplace';
import { correctExam } from 'src/helpers/exameHelper';

type entity = {
  model: keyof PrismaClient;
  name: string;
  route: string;
  permission: string;
};

@Injectable()
export class ExamesService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(protected prisma: PrismaService) {
    super(prisma, null);
  }

  /**
   * Método para cadastrar exame com validação de trainee
   * Verifica se o trainee existe e está confirmado em alguma inscrição
   */
  async registerExam(dto: CreateDto, entity: entity) {
    try {
      // Validar se o traineeId foi fornecido
      if (!dto.traineeId) {
        throw new BadRequestException('ID do aluno é obrigatório');
      }

      // Buscar o trainee para validar se existe
      const trainee = await this.prisma.selectOne('trainee', {
        where: {
          id: Number(dto.traineeId),
        },
      });

      if (!trainee) {
        throw new NotFoundException('Aluno não encontrado');
      }

      // Verificar se o trainee tem alguma inscrição confirmada
      const confirmedSubscription = await this.prisma.selectFirst(
        'courseClassSubscription',
        {
          where: {
            traineeId: Number(dto.traineeId),
            subscribeStatus: 'confirmed',
            classId: Number(dto.classId),
            inactiveAt: null,
          },
          include: {
            class: {
              include: {
                course: true,
                certificate: true,
                instructors: {
                  include: {
                    instructor: true,
                  },
                },
              },
            },
            trainee: true,
          },
        },
      );

      if (!confirmedSubscription) {
        throw new BadRequestException(
          'Aluno não possui inscrição confirmada em nenhuma turma',
        );
      }

      // Se passou pelas validações, processar o exame
      const logParams = {
        userId: 0, // Sistema/público
        companyId: confirmedSubscription.companyId,
      };

      // Adicionar informações adicionais ao DTO
      dto.companyId = confirmedSubscription.companyId;
      dto.classId = confirmedSubscription.classId;
      dto.courseId = confirmedSubscription.class.courseId;

      // Corrigir o exame comparando respostas do aluno com o gabarito
      const originalExam = confirmedSubscription.class.course.exam;
      const studentAnswers = dto.examResponses as any; // Respostas enviadas pelo aluno (JSON convertido para array)
      const passingGrade = confirmedSubscription.class.course.media || 6;

      const examResult = correctExam(
        originalExam,
        studentAnswers,
        passingGrade,
      );

      // Atualizar o DTO com o resultado da correção
      dto.examResponses = examResult.questions as any; // Exame corrigido com marcações
      dto.result = examResult.passed; // Se foi aprovado ou não
      const nota = examResult.nota; // Nota do aluno

      // Verificar se já existe um exame para este trainee nesta turma
      const existingExam = await this.prisma.selectFirst(entity.model, {
        where: {
          traineeId: Number(dto.traineeId),
          classId: confirmedSubscription.classId,
          inactiveAt: null,
        },
      });

      if (existingExam) {
        throw new BadRequestException(
          `Aluno já possui exame cadastrado para a turma ${confirmedSubscription.class.name}`,
        );
      }

      // Criar o exame
      const created = await this.prisma.insert(
        entity.model,
        {
          ...dto,
        },
        logParams,
      );

      // Se o aluno foi aprovado, cria o certificado
      if (examResult.passed) {
        const traineeCertificateData = {};

        const certificate = confirmedSubscription.class.certificate;
        const course = confirmedSubscription.class.course;

        // Calcular data de vencimento
        const expirationDate = getExpirationDate(course.yearOfValidation);

        // Gerar variáveis para substituição
        const variablesToReplace = makeVariablesToReplace(
          confirmedSubscription,
          expirationDate,
        );

        traineeCertificateData['fabricJsonFront'] = certificate.fabricJsonFront;
        traineeCertificateData['fabricJsonBack'] = certificate.fabricJsonBack;
        traineeCertificateData['courseId'] = dto.courseId;
        traineeCertificateData['traineeId'] = dto.traineeId;
        traineeCertificateData['classId'] = dto.classId;
        traineeCertificateData['expirationDate'] = expirationDate;
        traineeCertificateData['variableToReplace'] = variablesToReplace;
        traineeCertificateData['companyId'] = confirmedSubscription.companyId;

        // Criar o certificado do trainee
        await this.prisma.insert(
          'traineeCourseCertificate',
          traineeCertificateData,
          logParams,
        );
      }

      return {
        success: true,
        message: 'Exame cadastrado com sucesso',
        data: created,
        approved: examResult.passed,
        nota: nota,
        media: passingGrade,
        correctAnswers: examResult.correctAnswers,
        totalQuestions: examResult.totalQuestions,
        subscription: {
          classId: confirmedSubscription.classId,
          className: confirmedSubscription.class.name,
          courseName: confirmedSubscription.class.course.name,
        },
      };
    } catch (error) {
      console.log('🚀 ~ ExamesService ~ registerExam ~ error:', error);
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException('Erro ao cadastrar exame');
    }
  }
}
