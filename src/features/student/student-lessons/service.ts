import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { sanitizeQuizContent } from 'src/helpers/quizHelper';

@Injectable()
export class StudentLessonsService extends GenericService<
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

  async getLessonContent(
    traineeId: number,
    lessonId: number,
    modelId?: number,
  ): Promise<any> {
    try {
      console.log(
        '🚀 ~ StudentLessonsService ~ getLessonContent ~ modelId:',
        modelId,
      );
      const lesson = await this.prisma.selectOne('onlineLesson', {
        where: { id: lessonId },
        include: {
          steps: {
            where: { isActive: true }, // Filtrar apenas steps ativos
            orderBy: { order: 'asc' },
            include: {
              stepProgress: {
                where: { traineeId: traineeId },
              },
            },
          },
          modelLessons: {
            include: {
              model: {
                include: {
                  course: true,
                  classes: {
                    include: {
                      subscriptions: {
                        where: {
                          traineeId: traineeId,
                          subscribeStatus: {
                            not: 'declined',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          studentLessonProgress: {
            where: { traineeId: traineeId },
          },
        },
      });

      if (!lesson) {
        throw new BadRequestException('Aula não encontrada');
      }

      const hasAccess = lesson.modelLessons.some((modelLesson) =>
        modelLesson.model.classes.some(
          (courseClass) => courseClass.subscriptions.length > 0,
        ),
      );

      if (!hasAccess) {
        throw new BadRequestException('Você não tem acesso a esta aula');
      }

      // Parse progressConfig
      const progressConfig = (lesson.progressConfig as any) || {};

      // Log para debug
      console.log('progressConfig from DB:', progressConfig);
      console.log('Type of progressConfig:', typeof progressConfig);

      // Se progressConfig vier como string JSON, fazer parse
      let configObj = progressConfig;
      if (typeof progressConfig === 'string') {
        try {
          configObj = JSON.parse(progressConfig);
        } catch (e) {
          console.error('Error parsing progressConfig:', e);
          configObj = {};
        }
      }

      // Determinar o modo baseado nas configurações
      let mode: 'sequential' | 'grouped' | 'free' = 'free';
      if (configObj.requireSequential === true) {
        mode = 'sequential';
      } else if (configObj.unlockPattern === 'grouped') {
        mode = 'grouped';
      }

      console.log('Parsed config:', configObj);
      console.log('Mode determined:', mode);

      const unlockNext =
        configObj.unlockNext || (configObj.requireSequential ? 1 : 999);
      const requireMinProgress =
        configObj.requireMinProgress ||
        configObj.videoCompletePercent ||
        configObj.textCompletePercent ||
        0;
      const stepsPerGroup = configObj.stepsPerGroup || 3;
      const allowSkip = configObj.allowSkip === true;

      // Calcular progresso atual do aluno
      const completedSteps = lesson.steps.filter(
        (step) =>
          step.stepProgress?.[0] && step.stepProgress[0].completedAt != null,
      );

      const lastCompletedOrder =
        completedSteps.length > 0
          ? Math.max(...completedSteps.map((s) => s.order))
          : 0;
      const lessonProgress = lesson.studentLessonProgress?.[0]?.progress || 0;

      // Preparar overview de TODOS os steps (metadados apenas)
      const stepsOverview = lesson.steps.map((step) => {
        const stepProgress = step.stepProgress?.[0];
        const isCompleted = stepProgress && stepProgress.completedAt != null;
        const isInProgress = stepProgress && stepProgress.completedAt == null;

        // Determinar status baseado no modo
        let status: 'completed' | 'available' | 'locked' | 'in_progress' =
          'locked';

        if (isCompleted) {
          status = 'completed';
        } else if (isInProgress) {
          status = 'in_progress';
        } else {
          // Lógica de disponibilidade baseada no modo
          switch (mode) {
            case 'sequential':
              // Em modo sequencial, só libera o próximo step após completar o anterior
              const stepIndex = lesson.steps.findIndex((s) => s.id === step.id);
              const previousStep =
                stepIndex > 0 ? lesson.steps[stepIndex - 1] : null;

              if (stepIndex === 0) {
                // Primeiro step sempre disponível
                status = 'available';
              } else if (previousStep) {
                // Verificar se o step anterior foi completado
                const prevProgress = previousStep.stepProgress?.[0];
                if (prevProgress?.completedAt) {
                  status = 'available';
                }
              }
              break;

            case 'grouped':
              const unlockedGroups =
                Math.floor(
                  lessonProgress /
                    (100 / Math.ceil(lesson.steps.length / stepsPerGroup)),
                ) + 1;
              const stepGroup =
                Math.floor((step.order - 1) / stepsPerGroup) + 1;
              if (stepGroup <= unlockedGroups) {
                status = 'available';
              }
              break;

            case 'free':
              status = 'available';
              break;

            default:
              status = 'available';
          }
        }

        return {
          id: step.id,
          title: step.title,
          type: step.contentType,
          order: step.order,
          duration: step.duration,
          status: status,
          progress: stepProgress?.progressPercent || 0,
          firstAccessAt: stepProgress?.firstAccessAt,
          lastAccessAt: stepProgress?.lastAccessAt,
          completedAt: stepProgress?.completedAt,
        };
      });

      // Filtrar apenas o conteúdo dos steps disponíveis baseado nas configurações
      let availableStepsIds: number[] = [];

      if (mode === 'sequential' && !allowSkip) {
        // Modo sequencial sem skip: enviar apenas completed e o próximo não completado
        const orderedSteps = stepsOverview.sort((a, b) => a.order - b.order);

        // Encontrar o primeiro step não completado
        const firstIncomplete = orderedSteps.find(
          (s) => s.status !== 'completed',
        );

        if (firstIncomplete) {
          // Enviar todos os completados + apenas o primeiro incompleto
          availableStepsIds = orderedSteps
            .filter(
              (s) => s.status === 'completed' || s.id === firstIncomplete.id,
            )
            .map((s) => s.id);
        } else {
          // Todos completados
          availableStepsIds = orderedSteps.map((s) => s.id);
        }

        console.log('Sequential mode - Available step IDs:', availableStepsIds);
      } else if (mode === 'sequential' && allowSkip) {
        // Modo sequencial com skip: enviar completed, in_progress e todos available
        availableStepsIds = stepsOverview
          .filter((s) => s.status !== 'locked')
          .map((s) => s.id);
      } else {
        // Modo free ou grouped: enviar todos não bloqueados
        availableStepsIds = stepsOverview
          .filter((s) => s.status !== 'locked')
          .map((s) => s.id);
      }

      const stepsContent = lesson.steps
        .filter((step) => availableStepsIds.includes(step.id))
        .map((step) => {
          // Sanitizar conteúdo do quiz antes de enviar
          let content = step.content;
          if (step.contentType === 'QUIZ' && content) {
            content = sanitizeQuizContent(content);
          }

          return {
            id: step.id,
            content: content,
            contentType: step.contentType,
            // Remover dados sensíveis do progresso se houver
            stepProgress: step.stepProgress?.[0]
              ? {
                  progressPercent: step.stepProgress[0].progressPercent,
                  progressData: step.stepProgress[0].progressData,
                }
              : null,
          };
        });

      // Buscar próxima lesson se modelId foi fornecido
      let nextLessonId = null;

      if (modelId) {
        // Buscar a lesson atual no modelo especificado
        const currentModelLesson = await this.prisma.selectFirst(
          'onlineModelLesson',
          {
            where: {
              lessonId: lessonId,
              modelId: modelId,
              isActive: true,
            },
          },
        );

        if (currentModelLesson) {
          // Buscar a próxima lesson no mesmo modelo
          const nextModelLesson = await this.prisma.selectFirst(
            'onlineModelLesson',
            {
              where: {
                modelId: modelId,
                order: { gt: currentModelLesson.order },
                isActive: true,
              },
              orderBy: { order: 'asc' },
              include: {
                lesson: true,
              },
            },
          );
          console.log(
            '🚀 ~ StudentLessonsService ~ getLessonContent ~ nextModelLesson:',
            nextModelLesson,
          );

          // Verificar se a lesson está ativa
          if (nextModelLesson && nextModelLesson.lesson?.isActive) {
            nextLessonId = nextModelLesson.lessonId;
          }
        }
      }

      // Estrutura final híbrida
      return {
        lesson: {
          id: lesson.id,
          title: lesson.title,
          description: lesson.description,
          version: lesson.version,
          totalSteps: lesson.steps.length,
          progressConfig: {
            mode: mode,
            requireSequential: configObj.requireSequential === true,
            allowSkip: allowSkip,
            videoCompletePercent: configObj.videoCompletePercent || 85,
            textCompletePercent: configObj.textCompletePercent || 90,
            requireMinProgress: requireMinProgress,
            unlockNext: unlockNext,
            stepsPerGroup: mode === 'grouped' ? stepsPerGroup : undefined,
            isRequired: configObj.isRequired === true,
          },
        },
        lessonProgress: {
          progress: lessonProgress,
          startedAt: lesson.studentLessonProgress?.[0]?.startedAt,
          lastAccessAt: lesson.studentLessonProgress?.[0]?.lastAccessAt,
          completedAt: lesson.studentLessonProgress?.[0]?.completedAt,
          status: lesson.studentLessonProgress?.[0]?.status || 'NOT_STARTED',
          completed:
            lesson.studentLessonProgress?.[0]?.status === 'COMPLETED' || false,
          completedSteps: completedSteps.length,
          totalSteps: lesson.steps.length,
        },
        stepsOverview: stepsOverview,
        stepsContent: stepsContent,
        // Metadados úteis para o frontend
        metadata: {
          currentStepOrder: lastCompletedOrder + 1,
          nextAvailableStep: stepsOverview.find(
            (s) => s.status === 'available' && s.progress === 0,
          ),
          canComplete:
            stepsOverview.filter((s) => s.status === 'completed').length ===
            lesson.steps.length,
        },
        nextLesson: nextLessonId,
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async getLessonSteps(traineeId: number, lessonId: number): Promise<any> {
    try {
      await this.validateLessonAccess(traineeId, lessonId);

      const steps = await this.prisma.select('onlineLessonStep', {
        where: { lessonId: lessonId },
        include: {
          stepProgress: {
            where: { traineeId: traineeId },
          },
        },
      });

      // Sanitizar conteúdo de quiz antes de enviar
      const sanitizedSteps = steps.map((step: any) => {
        if (step.contentType === 'QUIZ' && step.content) {
          return {
            ...step,
            content: sanitizeQuizContent(step.content),
          };
        }
        return step;
      });

      return sanitizedSteps;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async startLesson(traineeId: number, lessonId: number): Promise<any> {
    try {
      await this.validateLessonAccess(traineeId, lessonId);

      const existingProgress = await this.prisma.selectFirst(
        'onlineStudentLessonProgress',
        {
          where: {
            traineeId: traineeId,
            lessonId: lessonId,
          },
        },
      );

      if (existingProgress) {
        // Atualizar lastAccessAt se já existe
        const updated = await this.prisma.update(
          'onlineStudentLessonProgress',
          {
            lastAccessAt: new Date(),
            status:
              existingProgress.status === 'NOT_STARTED'
                ? 'IN_PROGRESS'
                : existingProgress.status,
          },
          null,
          null,
          existingProgress.id,
        );
        return updated;
      }

      // Buscar o companyId através da inscrição do aluno
      const lesson = await this.prisma.selectOne('onlineLesson', {
        where: { id: lessonId },
        include: {
          modelLessons: {
            include: {
              model: {
                include: {
                  classes: {
                    include: {
                      subscriptions: {
                        where: {
                          traineeId: traineeId,
                          subscribeStatus: {
                            not: 'declined',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      // Pegar o companyId da primeira inscrição válida
      let companyId = 1; // valor padrão
      for (const modelLesson of lesson.modelLessons || []) {
        for (const courseClass of modelLesson.model?.classes || []) {
          if (courseClass.subscriptions?.length > 0) {
            companyId = courseClass.subscriptions[0].companyId || 1;
            break;
          }
        }
        if (companyId !== 1) break;
      }

      const progress = await this.prisma.insert('onlineStudentLessonProgress', {
        traineeId: traineeId,
        lessonId: lessonId,
        startedAt: new Date(),
        lastAccessAt: new Date(),
        status: 'IN_PROGRESS',
        currentStepOrder: 1,
        maxStepReached: 1,
        companyId: companyId,
      });

      // Log removido pois a tabela Log não existe no schema atual

      return progress;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async completeLesson(traineeId: number, lessonId: number): Promise<any> {
    try {
      await this.validateLessonAccess(traineeId, lessonId);

      const progress = await this.prisma.selectFirst(
        'onlineStudentLessonProgress',
        {
          where: {
            traineeId: traineeId,
            lessonId: lessonId,
          },
        },
      );

      if (!progress) {
        throw new BadRequestException('Você precisa iniciar a aula primeiro');
      }

      if (progress.status === 'COMPLETED') {
        return progress;
      }

      const updatedProgress = await this.prisma.update(
        'onlineStudentLessonProgress',
        {
          status: 'COMPLETED',
          completedAt: new Date(),
          lastAccessAt: new Date(),
        },
        null,
        null,
        progress.id,
      );

      // Log removido pois a tabela Log não existe no schema atual

      await this.updateCourseProgress(traineeId, lessonId);

      return updatedProgress;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  private async validateLessonAccess(
    traineeId: number,
    lessonId: number,
  ): Promise<boolean> {
    const lesson = await this.prisma.selectOne('onlineLesson', {
      where: { id: lessonId },
      include: {
        modelLessons: {
          include: {
            model: {
              include: {
                classes: {
                  include: {
                    subscriptions: {
                      where: {
                        traineeId: traineeId,
                        subscribeStatus: {
                          not: 'declined',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!lesson) {
      throw new BadRequestException('Aula não encontrada');
    }

    const hasAccess = lesson.modelLessons?.some((modelLesson) =>
      modelLesson.model?.classes?.some(
        (courseClass) => courseClass.subscriptions?.length > 0,
      ),
    );

    if (!hasAccess) {
      throw new BadRequestException('Você não tem acesso a esta aula');
    }

    return true;
  }

  private async updateCourseProgress(
    traineeId: number,
    lessonId: number,
  ): Promise<void> {
    // Implementação simplificada - pode ser expandida conforme necessário
    // Aqui poderia calcular e atualizar o progresso geral do curso
  }
}
