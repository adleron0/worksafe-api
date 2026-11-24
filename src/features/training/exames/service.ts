import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PrismaClient } from '@prisma/client';
import { correctExam } from 'src/helpers/exameHelper';
import { toBoolean } from 'src/utils/toBoolean';
import { TraineeCertificateService } from '../trainee_certificate/service';
import { CacheService } from 'src/common/cache/cache.service';
import { closeExamSession, hasExamSession } from './exam-session';

type entity = {
  model: keyof PrismaClient;
  name: string;
  route: string;
  permission: string;
};

@Injectable()
export class ExamesService {
  constructor(
    protected prisma: PrismaService,
    protected traineeCertificateService: TraineeCertificateService,
    protected cache: CacheService,
  ) {}

  /**
   * Com `cpf` + `classCode`: o aluno do CPF, na turma cujo código confere e
   * que tem prova (as mesmas regras do validate-student). Sem eles (front
   * antigo): exige a sessão aberta pelo validate-student para o par
   * traineeId/classId. Mensagem única para não confirmar CPF ou código.
   */
  private async authenticatedTraineeId(
    dto: any,
    classId: number,
  ): Promise<number> {
    const denied = () =>
      new BadRequestException(
        'Não foi possível validar o aluno. Informe novamente o CPF e o código da turma.',
      );
    const cpf = typeof dto.cpf === 'string' ? dto.cpf.replace(/\D/g, '') : '';
    const classCode =
      typeof dto.classCode === 'string' ? dto.classCode.trim() : '';
    if (cpf || classCode) {
      if (!cpf || !classCode) throw denied();
      const turma = await this.prisma.selectFirst('courseClass', {
        where: { id: classId, classCode, allowExam: true, inactiveAt: null },
        select: { id: true },
      });
      const trainee =
        turma &&
        (await this.prisma.selectFirst('trainee', {
          where: { cpf },
          select: { id: true },
        }));
      if (!trainee) throw denied();
      if (dto.traineeId && Number(dto.traineeId) !== trainee.id) throw denied();
      return trainee.id;
    }
    const traineeId = Number(dto.traineeId);
    if (!Number.isInteger(traineeId) || traineeId <= 0) throw denied();
    if (!(await hasExamSession(this.cache, traineeId, classId))) throw denied();
    return traineeId;
  }

  /**
   * Método para cadastrar exame com validação de trainee
   * Verifica se o trainee existe e está confirmado em alguma inscrição
   */
  async registerExam(dto: any, entity: entity) {
    try {
      // Quem é o aluno: CPF + código da turma (validados aqui) ou a sessão
      // aberta pelo validate-student. traineeId sozinho não prova nada — é
      // sequencial e qualquer um fazia a prova por qualquer aluno.
      const classId = Number(dto.classId);
      if (!Number.isInteger(classId) || classId <= 0) {
        throw new BadRequestException('Turma é obrigatória');
      }
      dto.traineeId = await this.authenticatedTraineeId(dto, classId);

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

      // Criar o exame. A rota é pública e chega como FormData (tudo string):
      // grava só os campos do modelo, já convertidos — antes ia `...dto` e o
      // Prisma recusava traineeId "13" (400 "Bad Request" ao enviar a prova).
      const created = await this.prisma.insert(
        entity.model,
        {
          traineeId: Number(dto.traineeId),
          courseId: Number(dto.courseId),
          classId: Number(dto.classId),
          companyId: Number(dto.companyId),
          examResponses: dto.examResponses,
          result: Boolean(dto.result),
          // ausente → mantém o padrão do banco (true)
          ...(dto.showOnWebsiteConsent !== undefined && {
            showOnWebsiteConsent: toBoolean(dto.showOnWebsiteConsent),
          }),
        },
        logParams,
      );

      await closeExamSession(this.cache, Number(dto.traineeId), classId).catch(
        () => undefined,
      );

      // Se o aluno foi aprovado, cria o certificado
      if (examResult.passed) {
        // Usar o serviço centralizado para gerar o certificado passando o ID da subscription
        await this.traineeCertificateService.generateCertificates(
          confirmedSubscription.classId,
          confirmedSubscription.companyId,
          [confirmedSubscription.id],
        );
      }

      return {
        success: true,
        message: 'Exame cadastrado com sucesso',
        // Sem examResponses: a prova corrigida é o gabarito da turma.
        data: { id: created.id, result: created.result },
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
