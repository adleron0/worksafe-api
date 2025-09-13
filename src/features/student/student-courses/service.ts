import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { sanitizeQuizContent } from 'src/helpers/quizHelper';

@Injectable()
export class StudentCoursesService extends GenericService<
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

  async getMyCourses(traineeId: number): Promise<any[]> {
    try {
      const enrollments = await this.prisma.select('courseClassSubscription', {
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
        select: {
          id: true,
          classId: true,
          subscribeStatus: true,
          class: {
            select: {
              id: true,
              initialDate: true,
              finalDate: true,
              maxSubscriptions: true,
              onlineCourseModel: {
                select: {
                  course: {
                    select: {
                      name: true,
                      description: true,
                      hoursDuration: true,
                    },
                  },
                  lessons: {
                    select: {
                      lesson: {
                        select: {
                          id: true,
                          studentLessonProgress: {
                            where: {
                              traineeId: traineeId,
                            },
                            select: {
                              id: true,
                              status: true,
                              startedAt: true,
                              completedAt: true,
                              currentStepOrder: true,
                              maxStepReached: true,
                              lastAccessAt: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              company: {
                select: {
                  comercial_name: true,
                },
              },
              subscriptions: {
                where: {
                  subscribeStatus: {
                    not: 'declined',
                  },
                },
                select: {
                  id: true,
                },
              },
            },
          },
        },
      });

      // Mapear os dados para o formato esperado
      const formattedEnrollments = enrollments.map((enrollment: any) => {
        const lessons = enrollment.class?.onlineCourseModel?.lessons || [];
        const totalLessons = lessons.length;

        let completedLessons = 0;
        let inProgressLessons = 0;
        let courseStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' =
          'NOT_STARTED';
        let earliestStartDate: Date | null = null;
        let latestCompletedDate: Date | null = null;
        let lastAccessDate: Date | null = null;
        let currentStepOrder = 1;
        let maxStepReached = 1;

        lessons.forEach((lessonItem: any) => {
          const progress = lessonItem.lesson?.studentLessonProgress?.[0];
          if (progress) {
            if (progress.status === 'COMPLETED') {
              completedLessons++;
              if (
                progress.completedAt &&
                (!latestCompletedDate ||
                  new Date(progress.completedAt) > latestCompletedDate)
              ) {
                latestCompletedDate = new Date(progress.completedAt);
              }
            } else if (progress.status === 'IN_PROGRESS') {
              inProgressLessons++;
              currentStepOrder = Math.max(
                currentStepOrder,
                progress.currentStepOrder || 1,
              );
              maxStepReached = Math.max(
                maxStepReached,
                progress.maxStepReached || 1,
              );
            }

            if (
              progress.startedAt &&
              (!earliestStartDate ||
                new Date(progress.startedAt) < earliestStartDate)
            ) {
              earliestStartDate = new Date(progress.startedAt);
            }

            if (
              progress.lastAccessAt &&
              (!lastAccessDate ||
                new Date(progress.lastAccessAt) > lastAccessDate)
            ) {
              lastAccessDate = new Date(progress.lastAccessAt);
            }
          }
        });

        // Determinar o status do curso
        if (completedLessons === totalLessons && totalLessons > 0) {
          courseStatus = 'COMPLETED';
        } else if (completedLessons > 0 || inProgressLessons > 0) {
          courseStatus = 'IN_PROGRESS';
        }

        const currentSubscriptions =
          enrollment.class?.subscriptions?.length || 0;

        return {
          id: enrollment.id,
          classId: enrollment.classId,
          subscribeStatus: enrollment.subscribeStatus,
          onlineStudentLessonProgress: {
            id: null, // ID consolidado não existe, pois é agregado de múltiplas lições
            status: courseStatus,
            startedAt: earliestStartDate
              ? earliestStartDate.toISOString()
              : null,
            completedAt: latestCompletedDate
              ? latestCompletedDate.toISOString()
              : null,
            currentStepOrder,
            maxStepReached,
            lastAccessAt: lastAccessDate ? lastAccessDate.toISOString() : null,
          },
          class: {
            id: enrollment.class.id,
            startDate: enrollment.class.initialDate,
            endDate: enrollment.class.finalDate,
            maxSubscriptions: enrollment.class.maxSubscriptions,
            currentSubscriptions,
            onlineCourseModel: {
              course: {
                name: enrollment.class.onlineCourseModel?.course?.name || '',
                description:
                  enrollment.class.onlineCourseModel?.course?.description || '',
                hoursDuration:
                  enrollment.class.onlineCourseModel?.course?.hoursDuration ||
                  0,
              },
              lessonsCount: totalLessons,
            },
            company: {
              name: enrollment.class.company?.comercial_name || '',
            },
          },
        };
      });

      return formattedEnrollments;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async getClassLessons(traineeId: number, classId: number): Promise<any> {
    try {
      const enrollment = await this.prisma.selectFirst(
        'courseClassSubscription',
        {
          where: {
            traineeId: traineeId,
            classId: classId,
            subscribeStatus: {
              not: 'declined',
            },
          },
        },
      );

      if (!enrollment) {
        throw new BadRequestException('Você não está inscrito nesta turma');
      }

      const courseClass = await this.prisma.selectOne('courseClass', {
        where: { id: classId },
        select: {
          id: true,
          hoursDuration: true,
          allowExam: true,
          classCode: true,
          exams: {
            select: {
              id: true,
              result: true,
              createdAt: true,
              examResponses: true,
            },
            where: {
              traineeId: traineeId,
              classId: classId,
              inactiveAt: null,
            },
          },
          certificates: {
            select: {
              key: true,
            },
            where: {
              traineeId: traineeId,
              classId: classId,
              inactiveAt: null,
            },
          },
          onlineCourseModel: {
            select: {
              id: true,
              course: {
                select: {
                  name: true,
                  description: true,
                },
              },
              lessons: {
                select: {
                  id: true,
                  order: true,
                  lesson: {
                    select: {
                      id: true,
                      title: true,
                      description: true,
                      steps: {
                        where: {
                          isActive: true, // Filtrar apenas steps ativos
                        },
                        select: {
                          id: true,
                          title: true,
                          order: true,
                          duration: true,
                          contentType: true,
                          stepProgress: {
                            where: {
                              traineeId: traineeId,
                            },
                            select: {
                              id: true,
                              progressPercent: true,
                              progressData: true,
                              firstAccessAt: true,
                              lastAccessAt: true,
                              completedAt: true,
                            },
                          },
                        },
                        orderBy: {
                          order: 'asc',
                        },
                      },
                      studentLessonProgress: {
                        where: {
                          traineeId: traineeId,
                        },
                        select: {
                          status: true,
                          currentStepOrder: true,
                          maxStepReached: true,
                        },
                      },
                    },
                  },
                },
                orderBy: {
                  order: 'asc',
                },
              },
            },
          },
        },
      });

      if (!courseClass) {
        throw new BadRequestException('Turma não encontrada');
      }

      // Sanitizar conteúdo de quiz antes de enviar
      if (courseClass.onlineCourseModel?.lessons) {
        courseClass.onlineCourseModel.lessons.forEach((lessonWrapper) => {
          if (lessonWrapper.lesson?.steps) {
            lessonWrapper.lesson.steps.forEach((step) => {
              if (step.contentType === 'QUIZ' && step.content) {
                // Limpar respostas corretas do conteúdo do quiz
                step.content = sanitizeQuizContent(step.content);
              }
            });
          }
        });
      }

      return courseClass;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }
}
