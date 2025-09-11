import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import {
  validateQuizResponses,
  prepareQuizProgressData,
  formatQuizResultForFrontend,
} from 'src/helpers/quizHelper';

@Injectable()
export class StudentProgressService extends GenericService<
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

  async getMyProgress(traineeId: number, params: any): Promise<any> {
    try {
      const progress = await this.prisma.select('onlineStudentStepProgress', {
        where: {
          traineeId: traineeId,
        },
        include: {
          step: {
            include: {
              lesson: {
                select: {
                  id: true,
                  title: true,
                  description: true,
                },
              },
            },
          },
        },
        orderBy: {
          updatedAt: 'desc',
        },
      });

      return progress;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async getProgressSummary(traineeId: number): Promise<any> {
    try {
      // Buscar apenas inscrições em classes com curso online
      const subscriptions = await this.prisma.select(
        'courseClassSubscription',
        {
          where: {
            traineeId: traineeId,
            subscribeStatus: {
              not: 'declined',
            },
            class: {
              onlineCourseModelId: {
                not: null,
              },
            },
          },
          include: {
            class: {
              include: {
                onlineCourseModel: {
                  include: {
                    lessons: true,
                  },
                },
                course: true,
              },
            },
          },
        },
      );

      // Buscar progresso de todas as aulas
      const allProgress = await this.prisma.select(
        'onlineStudentStepProgress',
        {
          where: {
            traineeId: traineeId,
          },
          include: {
            step: true,
            lesson: true,
          },
        },
      );

      // Buscar progresso das aulas
      const lessonProgress = await this.prisma.select(
        'onlineStudentLessonProgress',
        {
          where: {
            traineeId: traineeId,
          },
        },
      );

      // Calcular estatísticas
      const totalCourses = subscriptions.length;
      const completedSteps = allProgress.filter(
        (p) => p.completedAt !== null,
      ).length;
      const totalSteps = allProgress.length;
      const inProgressSteps = allProgress.filter(
        (p) => p.completedAt === null && p.progressPercent > 0,
      ).length;

      // Agrupar por curso
      const courseProgress = subscriptions.map((sub) => {
        const courseClass = sub.class;
        const lessons = courseClass.onlineCourseModel?.lessons || [];

        const courseLessonsProgress = lessons.map((lesson) => {
          const lProgress = lessonProgress.find(
            (lp) => lp.lessonId === lesson.id,
          );
          const stepsInLesson = allProgress.filter(
            (p) => p.lessonId === lesson.id,
          );
          const completedInLesson = stepsInLesson.filter(
            (p) => p.completedAt !== null,
          ).length;

          return {
            lessonId: lesson.id,
            lessonTitle: lesson.title,
            completed: lProgress?.completedAt !== null,
            progress:
              stepsInLesson.length > 0
                ? Math.round((completedInLesson / stepsInLesson.length) * 100)
                : 0,
            totalSteps: stepsInLesson.length,
            completedSteps: completedInLesson,
          };
        });

        const totalLessons = lessons.length;
        const completedLessons = courseLessonsProgress.filter(
          (l) => l.completed,
        ).length;
        const overallProgress =
          totalLessons > 0
            ? Math.round((completedLessons / totalLessons) * 100)
            : 0;

        return {
          courseId: courseClass.courseId,
          courseTitle: courseClass.course?.title,
          classId: courseClass.id,
          classTitle: courseClass.title,
          enrolledAt: sub.createdAt,
          status: sub.subscribeStatus,
          progress: overallProgress,
          totalLessons,
          completedLessons,
          lessons: courseLessonsProgress,
        };
      });

      return {
        summary: {
          totalCourses,
          totalSteps,
          completedSteps,
          inProgressSteps,
          overallProgress:
            totalSteps > 0
              ? Math.round((completedSteps / totalSteps) * 100)
              : 0,
        },
        courses: courseProgress,
        recentActivity: allProgress
          .sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          )
          .slice(0, 5)
          .map((p) => ({
            stepId: p.stepId,
            stepTitle: p.step?.title,
            lessonTitle: p.lesson?.title,
            progress: p.progressPercent,
            lastAccessAt: p.lastAccessAt,
            completedAt: p.completedAt,
          })),
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async getLessonProgress(traineeId: number, lessonId: number): Promise<any> {
    try {
      const progress = await this.prisma.select('onlineStudentStepProgress', {
        where: {
          traineeId: traineeId,
          lessonId: lessonId,
        },
        include: {
          step: true,
        },
        orderBy: {
          step: {
            order: 'asc',
          },
        },
      });

      const lesson = await this.prisma.selectOne('onlineLesson', {
        where: { id: lessonId },
        include: {
          steps: true,
        },
      });

      const totalSteps = lesson?.steps?.length || 0;
      const completedSteps = progress.filter(
        (p) => p.completedAt !== null,
      ).length;
      const overallProgress =
        totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

      return {
        lessonId,
        totalSteps,
        completedSteps,
        overallProgress,
        stepProgress: progress,
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async startStep(traineeId: number, stepId: number): Promise<any> {
    try {
      const step = await this.prisma.selectOne('onlineLessonStep', {
        where: { id: stepId },
        include: {
          lesson: true,
        },
      });

      if (!step) {
        throw new BadRequestException('Step não encontrado');
      }

      // Verificar/criar progresso da lesson automaticamente
      const lessonProgress = await this.prisma.selectFirst(
        'onlineStudentLessonProgress',
        {
          where: {
            traineeId: traineeId,
            lessonId: step.lessonId,
          },
        },
      );

      if (!lessonProgress) {
        // Criar progresso da lesson se não existir
        await this.prisma.insert('onlineStudentLessonProgress', {
          traineeId: traineeId,
          lessonId: step.lessonId,
          companyId: step.companyId,
          status: 'IN_PROGRESS',
          startedAt: new Date(),
          lastAccessAt: new Date(),
          currentStepOrder: step.order,
          maxStepReached: step.order,
        });
      } else {
        // Atualizar lastAccessAt e maxStepReached se necessário
        const updates: any = {
          lastAccessAt: new Date(),
        };

        if (lessonProgress.status === 'NOT_STARTED') {
          updates.status = 'IN_PROGRESS';
          updates.startedAt = new Date();
        }

        if (step.order > lessonProgress.maxStepReached) {
          updates.maxStepReached = step.order;
        }

        updates.currentStepOrder = step.order;

        await this.prisma.update(
          'onlineStudentLessonProgress',
          updates,
          null,
          null,
          lessonProgress.id,
        );
      }

      // Verificar progresso do step
      const existingProgress = await this.prisma.selectFirst(
        'onlineStudentStepProgress',
        {
          where: {
            traineeId: traineeId,
            stepId: stepId,
          },
        },
      );

      if (existingProgress) {
        // Atualizar lastAccessAt do step existente
        const updated = await this.prisma.update(
          'onlineStudentStepProgress',
          {
            lastAccessAt: new Date(),
          },
          null,
          null,
          existingProgress.id,
        );
        return updated;
      }

      // Criar novo progresso do step
      const progress = await this.prisma.insert('onlineStudentStepProgress', {
        traineeId: traineeId,
        stepId: stepId,
        lessonId: step.lessonId,
        companyId: step.companyId,
        progressPercent: 0,
        progressData: {},
        firstAccessAt: new Date(),
        lastAccessAt: new Date(),
      });

      return progress;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async completeStep(
    traineeId: number,
    stepId: number,
    body: any,
  ): Promise<any> {
    try {
      // Garantir que body existe
      const data = body || {};

      // Log para debug - remover em produção
      console.log(
        'CompleteStep - body recebido:',
        JSON.stringify(body, null, 2),
      );
      console.log(
        'CompleteStep - tipo do progressData:',
        typeof data.progressData,
      );

      // progressData já vem parseado do DTO
      const progressData = data.progressData || {};

      // Buscar o step com seu conteúdo para saber o tipo
      const step = await this.prisma.selectOne('onlineLessonStep', {
        where: { id: stepId },
      });

      if (!step) {
        throw new BadRequestException('Step não encontrado');
      }

      // Verificar se já existe progresso primeiro
      const existingProgress = await this.prisma.selectFirst(
        'onlineStudentStepProgress',
        {
          where: {
            traineeId: traineeId,
            stepId: stepId,
          },
        },
      );

      // Processar dados específicos por tipo de conteúdo
      let processedProgressData = { ...progressData };
      let progressPercent = 100; // Default para VIDEO e TEXT

      // Log para debug do QUIZ
      if (step.contentType === 'QUIZ') {
        console.log('QUIZ - progressData:', progressData);
        console.log('QUIZ - tem responses?', !!progressData.responses);
        console.log('QUIZ - responses:', progressData.responses);
      }

      // Se for QUIZ, calcular pontuação
      if (step.contentType === 'QUIZ' && progressData.responses) {
        const quizContent =
          typeof step.content === 'string'
            ? JSON.parse(step.content)
            : step.content;

        console.log('QUIZ - quizContent:', quizContent);

        // Usar o quizHelper para validar as respostas
        const quizResult = validateQuizResponses(
          progressData.responses,
          quizContent,
        );

        // Preparar dados para salvar no banco
        const previousAttempts = existingProgress?.progressData?.attempts || 0;
        processedProgressData = prepareQuizProgressData(
          progressData.responses,
          quizResult,
          progressData.timeSpent || 0,
          previousAttempts,
        );

        // Para quiz, o progresso é baseado na pontuação
        progressPercent = quizResult.percentage;

        // Adicionar o resultado formatado para retornar ao frontend
        processedProgressData.formattedResult =
          formatQuizResultForFrontend(quizResult);

        console.log(
          'QUIZ - processedProgressData após processamento:',
          JSON.stringify(processedProgressData, null, 2),
        );
      }

      // Para VIDEO, validar se assistiu o suficiente
      if (step.contentType === 'VIDEO' && progressData.watchedSeconds) {
        const videoContent =
          typeof step.content === 'string'
            ? JSON.parse(step.content)
            : step.content;

        const requiredPercent = 85; // Pode vir da configuração da lesson
        const watchedPercent =
          (progressData.watchedSeconds / progressData.totalDuration) * 100;

        if (watchedPercent < requiredPercent) {
          throw new BadRequestException(
            `Você precisa assistir pelo menos ${requiredPercent}% do vídeo para completar`,
          );
        }
      }

      if (!existingProgress) {
        console.log(
          'SALVANDO novo progresso - processedProgressData:',
          JSON.stringify(processedProgressData, null, 2),
        );

        const progress = await this.prisma.insert('onlineStudentStepProgress', {
          traineeId: traineeId,
          stepId: stepId,
          lessonId: step.lessonId,
          companyId: step.companyId,
          progressPercent: progressPercent,
          progressData: processedProgressData,
          firstAccessAt: new Date(),
          lastAccessAt: new Date(),
          completedAt: new Date(),
        });

        // Verificar se deve completar a lesson automaticamente
        await this.checkAndCompleteLessonIfNeeded(traineeId, step.lessonId);

        return progress;
      }

      // Para QUIZ, permitir múltiplas tentativas
      if (step.contentType === 'QUIZ' && processedProgressData.attempts) {
        // Manter histórico de tentativas anteriores se desejar
        // Não sobrescrever o processedProgressData que já foi processado acima
        if (existingProgress.progressData?.previousAttempts) {
          processedProgressData.previousAttempts =
            existingProgress.progressData.previousAttempts;
        }
      }

      console.log(
        'ATUALIZANDO progresso existente - processedProgressData:',
        JSON.stringify(processedProgressData, null, 2),
      );

      const updatedProgress = await this.prisma.update(
        'onlineStudentStepProgress',
        {
          progressPercent: progressPercent,
          progressData: processedProgressData,
          completedAt: new Date(),
          lastAccessAt: new Date(),
        },
        null,
        null,
        existingProgress.id,
      );

      // Verificar se deve completar a lesson automaticamente
      await this.checkAndCompleteLessonIfNeeded(traineeId, step.lessonId);

      return updatedProgress;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  // Método auxiliar para verificar e completar lesson
  private async checkAndCompleteLessonIfNeeded(
    traineeId: number,
    lessonId: number,
  ): Promise<void> {
    try {
      // Buscar todos os steps da lesson
      const steps = await this.prisma.select('onlineLessonStep', {
        where: { lessonId: lessonId },
      });

      // Buscar progresso de todos os steps
      const stepsProgress = await this.prisma.select(
        'onlineStudentStepProgress',
        {
          where: {
            traineeId: traineeId,
            lessonId: lessonId,
          },
        },
      );

      // Verificar se todos os steps foram completados
      const allCompleted = steps.every((step) =>
        stepsProgress.some(
          (progress) =>
            progress.stepId === step.id && progress.completedAt != null,
        ),
      );

      if (allCompleted) {
        // Atualizar status da lesson para COMPLETED
        const lessonProgress = await this.prisma.selectFirst(
          'onlineStudentLessonProgress',
          {
            where: {
              traineeId: traineeId,
              lessonId: lessonId,
            },
          },
        );

        if (lessonProgress && lessonProgress.status !== 'COMPLETED') {
          await this.prisma.update(
            'onlineStudentLessonProgress',
            {
              status: 'COMPLETED',
              completedAt: new Date(),
              lastAccessAt: new Date(),
            },
            null,
            null,
            lessonProgress.id,
          );
        }
      }
    } catch (error) {
      console.error('Erro ao verificar conclusão da lesson:', error);
    }
  }

  async updateStepProgress(
    traineeId: number,
    stepId: number,
    body: UpdateDto,
  ): Promise<any> {
    try {
      const existingProgress = await this.prisma.selectFirst(
        'onlineStudentStepProgress',
        {
          where: {
            traineeId: traineeId,
            stepId: stepId,
          },
        },
      );

      if (!existingProgress) {
        // Se não existe, criar automaticamente
        const step = await this.prisma.selectOne('onlineLessonStep', {
          where: { id: stepId },
        });

        if (!step) {
          throw new BadRequestException('Step não encontrado');
        }

        const newProgress = await this.prisma.insert(
          'onlineStudentStepProgress',
          {
            traineeId: traineeId,
            stepId: stepId,
            lessonId: step.lessonId,
            companyId: step.companyId,
            progressPercent: body.progressPercent || 0,
            progressData: body.progressData || {},
            firstAccessAt: new Date(),
            lastAccessAt: new Date(),
          },
        );

        return newProgress;
      }

      const updateData: any = {
        progressPercent:
          body.progressPercent || existingProgress.progressPercent,
        progressData: body.progressData || existingProgress.progressData,
        lastAccessAt: new Date(),
      };

      if (body.progressPercent === 100 && !existingProgress.completedAt) {
        updateData.completedAt = new Date();
      }

      const updatedProgress = await this.prisma.update(
        'onlineStudentStepProgress',
        updateData,
        null,
        null,
        existingProgress.id,
      );

      return updatedProgress;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }
}
