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
import { getExpirationDate } from 'src/utils/dataFunctions';
import { makeVariablesToReplace } from 'src/helpers/makeVariablesToReplace';

@Injectable()
export class TraineeCertificateService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(protected prisma: PrismaService) {
    super(prisma, null);
  }

  /**
   * Gera certificados para alunos de uma turma
   * @param classId - ID da turma
   * @param companyId - ID da empresa
   * @param subscriptionId - (Opcional) ID de uma subscription específica para gerar apenas um certificado
   * @returns Objeto com informações sobre os certificados gerados
   */
  async generateCertificates(
    classId: number,
    companyId: number,
    subscriptionId?: number,
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

      // Buscar as subscriptions - filtra por ID específico se fornecido
      const subscriptionWhere: any = {
        classId: classId,
        subscribeStatus: 'confirmed',
        inactiveAt: null,
      };

      if (subscriptionId) {
        subscriptionWhere.id = subscriptionId;
      }

      const subscriptions = await this.prisma.select(
        'courseClassSubscription',
        {
          where: subscriptionWhere,
          include: {
            trainee: {
              include: {
                city: true,
                state: true,
              },
            },
          },
        },
      );

      if (!subscriptions || subscriptions.length === 0) {
        throw new BadRequestException(
          subscriptionId
            ? 'Inscrição não encontrada ou não confirmada'
            : 'Turma não possui alunos confirmados',
        );
      }

      // Preparar dados dos certificados
      const certificatesData = [];
      const skippedStudents = [];

      for (const subscription of subscriptions) {
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
          skippedStudents.push({
            traineeId: subscription.traineeId,
            traineeName: subscription.trainee.name,
            reason: 'Já possui certificado',
          });
          continue;
        }

        // Se a turma requer exame, verificar se o aluno foi aprovado
        if (classData.allowExam) {
          const examResult = await this.prisma.selectFirst('courseClassExam', {
            where: {
              traineeId: subscription.traineeId,
              classId: classId,
              result: true, // Apenas aprovados
              inactiveAt: null,
            },
          });

          if (!examResult) {
            skippedStudents.push({
              traineeId: subscription.traineeId,
              traineeName: subscription.trainee.name,
              reason: 'Não foi aprovado no exame ou exame não realizado',
            });
            continue;
          }
        }

        // Calcular data de vencimento
        const expirationDate = getExpirationDate(
          classData.course.yearOfValidation,
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
          showOnWebsiteConsent: subscription.showOnWebsiteConsent || true,
        });
      }

      // Se não há certificados para gerar
      if (certificatesData.length === 0) {
        return {
          success: true,
          message: subscriptionId
            ? 'Certificado não pode ser gerado'
            : 'Nenhum certificado novo para gerar',
          data: {
            classId: classId,
            className: classData.name,
            courseName: classData.course.name,
            totalStudents: subscriptions.length,
            newCertificates: 0,
            skippedStudents: skippedStudents,
          },
        };
      }

      // Inserir certificados
      const logParams = {
        userId: 0, // Sistema
        companyId: companyId,
      };

      if (certificatesData.length === 1) {
        // Inserir único certificado
        await this.prisma.insert(
          'traineeCourseCertificate',
          certificatesData[0],
          logParams,
        );
      } else {
        // Inserir múltiplos certificados
        await this.prisma.bulkInsert(
          'traineeCourseCertificate',
          certificatesData,
        );
      }

      return {
        success: true,
        message: `${certificatesData.length} certificado(s) gerado(s) com sucesso`,
        data: {
          classId: classId,
          className: classData.name,
          courseName: classData.course.name,
          totalStudents: subscriptions.length,
          newCertificates: certificatesData.length,
          skippedStudents: skippedStudents,
        },
      };
    } catch (error) {
      console.log(
        '🚀 ~ TraineeCertificateService ~ generateCertificates ~ error:',
        error,
      );
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
