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
import { getExpirationDate } from 'src/utils/dataFunctions';
import { makeVariablesToReplace } from 'src/helpers/makeVariablesToReplace';

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
      // Buscar a turma com todas as informações necessárias
      const classData = await this.prisma.selectFirst('courseClass', {
        where: {
          id: classId,
          inactiveAt: null,
        },
        include: {
          course: true,
          certificate: true,
          instructors: {
            include: {
              instructor: true,
            },
          },
          subscriptions: {
            where: {
              subscribeStatus: 'confirmed',
              inactiveAt: null,
            },
            include: {
              trainee: {
                include: {
                  city: true,
                  state: true,
                },
              },
            },
          },
        },
      });

      if (!classData) {
        throw new NotFoundException('Turma não encontrada');
      }

      if (!classData.certificate) {
        throw new BadRequestException(
          'Turma não possui certificado configurado',
        );
      }

      if (!classData.subscriptions || classData.subscriptions.length === 0) {
        throw new BadRequestException('Turma não possui alunos confirmados');
      }

      // Verificar se a turma permite geração de certificados sem exame
      if (classData.allowExam) {
        throw new BadRequestException(
          'Esta turma requer exame para geração de certificados. Use a rota de exames.',
        );
      }

      const logParams = {
        userId,
        companyId,
      };

      // Preparar dados dos certificados para todos os alunos
      const certificatesData = [];

      for (const subscription of classData.subscriptions) {
        // Verificar se o aluno já possui certificado para esta turma
        const existingCertificate = await this.prisma.selectFirst(
          'traineeCourseCertificate',
          {
            where: {
              traineeId: subscription.traineeId,
              classId: classId,
              inactiveAt: null,
            },
          },
        );

        if (existingCertificate) {
          console.log(
            `Aluno ${subscription.trainee.name} já possui certificado para esta turma`,
          );
          continue; // Pula para o próximo aluno
        }

        // Calcular data de vencimento
        const expirationDate = getExpirationDate(
          classData.course.yearOfValidation || 1,
        );

        // Preparar dados da subscription com estrutura completa
        const subscriptionWithFullData = {
          ...subscription,
          class: {
            ...classData,
            course: classData.course,
            instructors: classData.instructors,
          },
        };

        // Gerar variáveis para substituição
        const variablesToReplace = makeVariablesToReplace(
          subscriptionWithFullData,
          expirationDate,
        );

        // Adicionar dados do certificado ao array
        certificatesData.push({
          fabricJsonFront: classData.certificate.fabricJsonFront,
          fabricJsonBack: classData.certificate.fabricJsonBack,
          courseId: classData.courseId,
          traineeId: subscription.traineeId,
          classId: classId,
          expirationDate: expirationDate,
          variableToReplace: variablesToReplace,
          companyId: companyId,
          showOnWebsiteConsent: true, // Padrão true, pode ser ajustado conforme necessário
        });
      }

      if (certificatesData.length === 0) {
        return {
          success: true,
          message: 'Todos os alunos já possuem certificados para esta turma',
          data: {
            classId: classId,
            className: classData.name,
            courseName: classData.course.name,
            totalStudents: classData.subscriptions.length,
            newCertificates: 0,
          },
        };
      }

      // Inserir todos os certificados de uma vez usando bulkInsert
      await this.prisma.bulkInsert(
        'traineeCourseCertificate',
        certificatesData,
      );

      return {
        success: true,
        message: `Certificados gerados com sucesso para ${certificatesData.length} aluno(s)`,
        data: {
          classId: classId,
          className: classData.name,
          courseName: classData.course.name,
          totalStudents: classData.subscriptions.length,
          newCertificates: certificatesData.length,
          skippedStudents:
            classData.subscriptions.length - certificatesData.length,
        },
      };
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
