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

/** Nota da prova (0–10, uma casa) a partir das respostas corrigidas gravadas. */
function examScoreOf(responses: unknown): number | null {
  const questions = Array.isArray(responses) ? responses : null;
  if (!questions || questions.length === 0) return null;
  const correct = questions.filter(
    (q: { options?: { isUserCorrect?: boolean }[] }) =>
      Array.isArray(q?.options) &&
      q.options.some((o) => o?.isUserCorrect === true),
  ).length;
  return Math.round((correct / questions.length) * 100) / 10;
}

@Injectable()
export class ClassesService {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
    protected traineeCertificateService: TraineeCertificateService,
  ) {}

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

  /**
   * Gera (ou atualiza) certificados só para as inscrições escolhidas.
   * Atualização preserva a data de vencimento original; não exige exame.
   */
  async generateCertificatesSelective(
    classId: number,
    companyId: number,
    subscriptionIds: number[],
  ) {
    if (!subscriptionIds || subscriptionIds.length === 0) {
      throw new BadRequestException(
        'Deve informar pelo menos um subscriptionId',
      );
    }
    // Escopo da empresa: turma de outra empresa é 404, não processamento.
    const classData = await this.prisma.selectFirst('courseClass', {
      where: { id: classId, companyId, inactiveAt: null },
    });
    if (!classData) {
      throw new NotFoundException('Turma não encontrada');
    }
    try {
      return await this.traineeCertificateService.generateCertificates(
        classId,
        companyId,
        subscriptionIds,
        true, // allowUpsert
        true, // skipExame
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      )
        throw error;
      console.error('[classes] generateCertificatesSelective:', error);
      throw new BadRequestException('Erro ao gerar certificados seletivos');
    }
  }

  /**
   * Candidatos a aluno destaque: certificados emitidos da turma com a nota da
   * prova (acertos ÷ questões × 10, calculada do exame corrigido que já fica
   * gravado). Ordena pela nota; `suggested` marca quem tem a maior nota
   * (empates entram todos). A decisão continua manual.
   */
  async highlightCandidates(classId: number, companyId: number) {
    const turma = await this.prisma.courseClass.findFirst({
      // turma cancelada continua com certificados válidos: não filtra inactiveAt
      where: { id: classId, companyId },
      select: {
        id: true,
        name: true,
        highlightTheme: true,
        highlightLabel: true,
        highlightPattern: true,
        highlightBorder: true,
      },
    });
    if (!turma) throw new NotFoundException('Turma não encontrada');

    const [certificates, exams] = await Promise.all([
      this.prisma.traineeCourseCertificate.findMany({
        where: { classId, companyId, inactiveAt: null },
        select: {
          id: true,
          key: true,
          traineeId: true,
          highlightStudent: true,
          highlightTheme: true,
          highlightLabel: true,
          highlightPattern: true,
          highlightBorder: true,
          trainee: { select: { id: true, name: true, imageUrl: true } },
        },
      }),
      this.prisma.courseClassExam.findMany({
        where: { classId, inactiveAt: null },
        select: { traineeId: true, examResponses: true, result: true },
      }),
    ]);

    const examByTrainee = new Map(
      exams.map((e) => [
        e.traineeId,
        { score: examScoreOf(e.examResponses), passed: e.result },
      ]),
    );

    const rows = certificates
      .map((c) => ({
        ...c,
        examScore: examByTrainee.get(c.traineeId)?.score ?? null,
        examPassed: examByTrainee.get(c.traineeId)?.passed ?? null,
      }))
      .sort(
        (a, b) =>
          (b.examScore ?? -1) - (a.examScore ?? -1) ||
          (a.trainee?.name ?? '').localeCompare(b.trainee?.name ?? '', 'pt-BR'),
      );
    const best = rows.reduce((max, r) => Math.max(max, r.examScore ?? -1), -1);

    return {
      class: turma,
      rows: rows.map((r) => ({
        ...r,
        suggested: best > 0 && r.examScore === best,
      })),
    };
  }

  /**
   * Alunos para emitir certificados na turma: inscrições confirmadas, com o
   * certificado já emitido (se houver), a nota da prova e a sugestão de
   * destaque (maior nota). Base do diálogo "Emitir certificados".
   */
  async certificateIssuance(classId: number, companyId: number) {
    const turma = await this.prisma.courseClass.findFirst({
      where: { id: classId, companyId },
      select: {
        id: true,
        name: true,
        allowExam: true,
        highlightTheme: true,
        highlightLabel: true,
        highlightPattern: true,
        highlightBorder: true,
        certificate: { select: { id: true, name: true } },
      },
    });
    if (!turma) throw new NotFoundException('Turma não encontrada');

    const [subscriptions, certificates, exams] = await Promise.all([
      this.prisma.courseClassSubscription.findMany({
        where: {
          classId,
          companyId,
          subscribeStatus: 'confirmed',
          inactiveAt: null,
        },
        select: {
          id: true,
          name: true,
          cpf: true,
          workedAt: true,
          traineeId: true,
          trainee: { select: { id: true, name: true, imageUrl: true } },
        },
      }),
      this.prisma.traineeCourseCertificate.findMany({
        where: { classId, companyId, inactiveAt: null },
        select: {
          id: true,
          key: true,
          traineeId: true,
          createdAt: true,
          highlightStudent: true,
          highlightTheme: true,
          highlightLabel: true,
          highlightPattern: true,
          highlightBorder: true,
        },
      }),
      this.prisma.courseClassExam.findMany({
        where: { classId, inactiveAt: null },
        select: { traineeId: true, examResponses: true, result: true },
      }),
    ]);

    const certByTrainee = new Map(certificates.map((c) => [c.traineeId, c]));
    const examByTrainee = new Map(
      exams.map((e) => [
        e.traineeId,
        { score: examScoreOf(e.examResponses), passed: e.result },
      ]),
    );
    const rows = subscriptions
      .map((s) => ({
        subscriptionId: s.id,
        traineeId: s.traineeId,
        name: s.trainee?.name || s.name,
        cpf: s.cpf,
        workedAt: s.workedAt,
        imageUrl: s.trainee?.imageUrl ?? null,
        certificate: (s.traineeId && certByTrainee.get(s.traineeId)) || null,
        examScore: s.traineeId
          ? (examByTrainee.get(s.traineeId)?.score ?? null)
          : null,
        examPassed: s.traineeId
          ? (examByTrainee.get(s.traineeId)?.passed ?? null)
          : null,
      }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR'));
    const best = rows.reduce((max, r) => Math.max(max, r.examScore ?? -1), -1);
    return {
      class: turma,
      rows: rows.map((r) => ({
        ...r,
        suggested: best > 0 && r.examScore === best,
      })),
    };
  }
}
