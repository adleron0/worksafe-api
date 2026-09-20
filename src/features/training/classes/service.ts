import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
// entity template imports
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { removeCorrectAnswers } from 'src/helpers/exameHelper';
import { TraineeCertificateService } from '../trainee_certificate/service';

@Injectable()
export class ClassesService {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
    protected traineeCertificateService: TraineeCertificateService,
  ) {
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

  /**
   * Gera certificados para todos os alunos confirmados de uma turma
   * Útil para turmas sem exame/prova
   */
  async generateCertificates(
    classId: number,
    userId: number,
    companyId: number,
  ) {
    try {
      // Buscar a turma para validação inicial
      const classData = await this.prisma.selectFirst('courseClass', {
        where: {
          id: classId,
          inactiveAt: null,
        },
      });

      if (!classData) {
        throw new NotFoundException('Turma não encontrada');
      }

      // Verificar se a turma permite geração de certificados sem exame
      if (classData.allowExam) {
        throw new BadRequestException(
          'Esta turma requer exame para geração de certificados. Use a rota de exames.',
        );
      }

      // Usar o serviço centralizado para gerar os certificados
      const result = await this.traineeCertificateService.generateCertificates(
        classId,
        companyId,
      );

      return result;
    } catch (error) {
      console.log('🚀 ~ ClassesService ~ generateCertificates ~ error:', error);
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException('Erro ao gerar certificados');
    }
  }
}
