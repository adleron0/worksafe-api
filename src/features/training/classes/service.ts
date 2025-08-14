import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { GenericService } from 'src/features/generic/generic.service';
// entity template imports
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { removeCorrectAnswers } from 'src/helpers/exameHelper';

@Injectable()
export class ClassesService extends GenericService<
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
   * Valida o aluno pelo CPF e código da turma
   * Retorna informações do trainee, turma e exame do curso
   */
  async validateStudent(cpf: string, classCode: string, classId: number) {
    try {
      // Validar parâmetros
      if (!cpf || !classCode || !classId) {
        throw new BadRequestException('CPF e código da turma são obrigatórios');
      }

      // Limpar CPF (remover pontos e traços)
      const cleanCpf = cpf.replace(/[.-]/g, '');

      // Buscar o trainee pelo CPF com suas inscrições
      const trainee = await this.prisma.selectFirst('trainee', {
        where: {
          cpf: cleanCpf,
        },
        include: {
          subscription: {
            where: {
              subscribeStatus: 'confirmed',
              inactiveAt: null,
            },
            include: {
              class: {
                include: {
                  course: true,
                },
              },
            },
          },
        },
      });

      if (!trainee) {
        throw new NotFoundException('Aluno não encontrado com este CPF');
      }

      if (!trainee.subscription || trainee.subscription.length === 0) {
        throw new BadRequestException(
          'Aluno não possui inscrições confirmadas',
        );
      }

      // Buscar a turma pelo código
      const classData = await this.prisma.selectFirst('courseClass', {
        where: {
          id: classId,
          classCode: classCode,
          inactiveAt: null,
          allowExam: true, // Verifica se a turma permite exame
        },
        include: {
          course: true,
        },
      });

      if (!classData) {
        throw new NotFoundException('Turma não encontrada com este código');
      }

      // Verificar se o aluno está inscrito e confirmado nesta turma específica
      const subscription = trainee.subscription.find(
        (sub: any) => sub.classId === classData.id,
      );

      if (!subscription) {
        throw new BadRequestException(
          `Aluno não está inscrito na turma ${classData.name}`,
        );
      }

      // Buscar se já existe exame para este aluno nesta turma
      const existingExam = await this.prisma.selectFirst('courseClassExam', {
        where: {
          traineeId: trainee.id,
          classId: classData.id,
          inactiveAt: null,
        },
      });

      if (existingExam) {
        throw new BadRequestException(`Aluno já realizou o exame do curso!`);
      }

      // Remover respostas corretas do exame antes de enviar ao aluno
      let examWithoutAnswers = null;

      if (classData.course.exam) {
        examWithoutAnswers = removeCorrectAnswers(classData.course.exam);
      }

      // Retornar as informações solicitadas
      return {
        traineeId: trainee.id,
        classId: classData.id,
        courseId: classData.course.id,
        courseName: classData.course.name,
        traineeName: trainee.name,
        className: classData.name,
        exam: examWithoutAnswers, // JSON sem as respostas corretas
      };
    } catch (error) {
      console.log('🚀 ~ ClassesService ~ validateStudent ~ error:', error);
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException('Erro ao validar aluno');
    }
  }
}
