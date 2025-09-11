import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';

@Injectable()
export class StudentEvaluationsService extends GenericService<
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

  async getMyEvaluations(traineeId: number): Promise<any[]> {
    try {
      const evaluations = await this.prisma.select('courseClassExam', {
        where: {
          traineeId: traineeId,
        },
        include: {
          lesson: {
            select: {
              id: true,
              title: true,
              description: true,
            },
          },
          courseClass: {
            select: {
              id: true,
              name: true,
              onlineCourseModel: {
                select: {
                  course: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      return evaluations;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async getLessonEvaluation(traineeId: number, lessonId: number): Promise<any> {
    try {
      const evaluations = await this.prisma.select('courseClassExam', {
        where: {
          traineeId: traineeId,
          lessonId: lessonId,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      // Buscar as quest�es da avalia��o da li��o
      const lesson = await this.prisma.selectOne('onlineLesson', {
        where: { id: lessonId },
        select: {
          id: true,
          title: true,
          evaluationQuestions: true,
        },
      });

      return {
        lesson,
        evaluations,
        canRetake:
          evaluations.length === 0 ||
          (evaluations.every((e) => !e.passed) && evaluations.length < 3), // M�ximo 3 tentativas
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async startEvaluation(
    traineeId: number,
    lessonId: number,
    courseClassId: number,
  ): Promise<any> {
    try {
      // Verificar se o aluno tem acesso � li��o
      const enrollment = await this.prisma.selectFirst(
        'courseClassSubscription',
        {
          where: {
            traineeId: traineeId,
            classId: courseClassId,
            subscribeStatus: 'approved',
          },
        },
      );

      if (!enrollment) {
        throw new BadRequestException('Voc� n�o est� inscrito nesta turma');
      }

      // Verificar tentativas anteriores
      const previousAttempts = await this.prisma.select('courseClassExam', {
        where: {
          traineeId: traineeId,
          lessonId: lessonId,
          courseClassId: courseClassId,
        },
      });

      if (previousAttempts.some((e) => e.passed)) {
        throw new BadRequestException('Voc� j� passou nesta avalia��o');
      }

      if (previousAttempts.length >= 3) {
        throw new BadRequestException(
          'Voc� excedeu o n�mero m�ximo de tentativas',
        );
      }

      // Buscar quest�es da avalia��o
      const lesson = await this.prisma.selectOne('onlineLesson', {
        where: { id: lessonId },
        select: {
          id: true,
          title: true,
          evaluationQuestions: true,
        },
      });

      if (!lesson || !lesson.evaluationQuestions) {
        throw new BadRequestException('Esta li��o n�o possui avalia��o');
      }

      // Criar nova avalia��o
      const evaluation = await this.prisma.insert('courseClassExam', {
        traineeId: traineeId,
        lessonId: lessonId,
        courseClassId: courseClassId,
        evaluationType: 'quiz',
        questions: lesson.evaluationQuestions,
        attempts: previousAttempts.length + 1,
        startedAt: new Date(),
        maxScore: this.calculateMaxScore(lesson.evaluationQuestions),
      });

      return evaluation;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async submitEvaluation(
    traineeId: number,
    evaluationId: number,
    body: any,
  ): Promise<any> {
    try {
      const evaluation = await this.prisma.selectOne('courseClassExam', {
        where: {
          id: evaluationId,
          traineeId: traineeId,
        },
      });

      if (!evaluation) {
        throw new BadRequestException('Avalia��o n�o encontrada');
      }

      if (evaluation.completedAt) {
        throw new BadRequestException('Esta avalia��o j� foi conclu�da');
      }

      // Calcular pontua��o
      const score = this.calculateScore(evaluation.questions, body.answers);
      const maxScore = evaluation.maxScore || 100;
      const percentage = (score / maxScore) * 100;
      const passed = percentage >= 70; // 70% para passar

      // Calcular tempo gasto
      const timeSpent = Math.floor(
        (Date.now() - new Date(evaluation.startedAt).getTime()) / 1000,
      );

      // Atualizar avalia��o
      const updatedEvaluation = await this.prisma.update(
        'courseClassExam',
        {
          answers: body.answers,
          score: score,
          passed: passed,
          completedAt: new Date(),
          timeSpent: timeSpent,
          feedback: this.generateFeedback(percentage),
        },
        null,
        null,
        evaluationId,
      );

      // Se passou, atualizar progresso da li��o
      if (passed) {
        await this.updateLessonProgress(traineeId, evaluation.lessonId);
      }

      return {
        ...updatedEvaluation,
        percentage,
        message: passed
          ? 'Parab�ns! Voc� passou na avalia��o.'
          : 'Voc� n�o atingiu a pontua��o m�nima. Tente novamente.',
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async getEvaluationResults(
    traineeId: number,
    evaluationId: number,
  ): Promise<any> {
    try {
      const evaluation = await this.prisma.selectOne('courseClassExam', {
        where: {
          id: evaluationId,
          traineeId: traineeId,
        },
        include: {
          lesson: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      });

      if (!evaluation) {
        throw new BadRequestException('Avalia��o n�o encontrada');
      }

      const percentage = evaluation.maxScore
        ? (evaluation.score / evaluation.maxScore) * 100
        : 0;

      return {
        ...evaluation,
        percentage,
        correctAnswers: this.getCorrectAnswers(
          evaluation.questions,
          evaluation.answers,
        ),
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async getClassEvaluationSummary(
    traineeId: number,
    classId: number,
  ): Promise<any> {
    try {
      const evaluations = await this.prisma.select('courseClassExam', {
        where: {
          traineeId: traineeId,
          courseClassId: classId,
        },
        include: {
          lesson: {
            select: {
              id: true,
              title: true,
            },
          },
        },
        orderBy: {
          lessonId: 'asc',
        },
      });

      const summary = evaluations.reduce((acc, evaluation) => {
        const lessonId = evaluation.lessonId;
        if (!acc[lessonId]) {
          acc[lessonId] = {
            lessonId,
            lessonTitle: evaluation.lesson.title,
            attempts: [],
            bestScore: 0,
            passed: false,
          };
        }

        acc[lessonId].attempts.push({
          id: evaluation.id,
          score: evaluation.score,
          maxScore: evaluation.maxScore,
          passed: evaluation.passed,
          completedAt: evaluation.completedAt,
        });

        if (evaluation.score > acc[lessonId].bestScore) {
          acc[lessonId].bestScore = evaluation.score;
        }

        if (evaluation.passed) {
          acc[lessonId].passed = true;
        }

        return acc;
      }, {});

      return Object.values(summary);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  private calculateMaxScore(questions: any): number {
    if (!questions || !Array.isArray(questions)) return 100;
    return questions.reduce((total, q) => total + (q.points || 10), 0);
  }

  private calculateScore(questions: any, answers: any): number {
    if (!questions || !answers) return 0;

    let score = 0;
    for (const question of questions) {
      const answer = answers[question.id];
      if (answer === question.correctAnswer) {
        score += question.points || 10;
      }
    }

    return score;
  }

  private generateFeedback(percentage: number): string {
    if (percentage >= 90)
      return 'Excelente! Voc� demonstrou dom�nio completo do conte�do.';
    if (percentage >= 70) return 'Bom trabalho! Voc� passou na avalia��o.';
    if (percentage >= 50)
      return 'Voc� precisa revisar alguns conceitos. Tente novamente.';
    return 'Recomendamos que voc� revise o conte�do da li��o antes de tentar novamente.';
  }

  private getCorrectAnswers(questions: any, answers: any): any {
    if (!questions || !answers) return {};

    const result = {};
    for (const question of questions) {
      result[question.id] = {
        userAnswer: answers[question.id],
        correctAnswer: question.correctAnswer,
        isCorrect: answers[question.id] === question.correctAnswer,
      };
    }

    return result;
  }

  private async updateLessonProgress(
    traineeId: number,
    lessonId: number,
  ): Promise<void> {
    try {
      const progress = await this.prisma.selectFirst(
        'onlineStudentLessonProgress',
        {
          where: {
            traineeId: traineeId,
            lessonId: lessonId,
          },
        },
      );

      if (progress && !progress.completed) {
        await this.prisma.update(
          'onlineStudentLessonProgress',
          {
            completed: true,
            completedAt: new Date(),
            progress: 100,
          },
          null,
          null,
          progress.id,
        );
      }
    } catch (error) {
      // Silent fail - n�o queremos que falhas na atualiza��o do progresso impe�am a submiss�o
    }
  }
}
