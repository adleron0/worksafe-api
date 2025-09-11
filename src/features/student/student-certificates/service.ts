import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';

@Injectable()
export class StudentCertificatesService extends GenericService<
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

  async getMyCertificates(traineeId: number): Promise<any[]> {
    try {
      const certificates = await this.prisma.select(
        'traineeCourseCertificate',
        {
          where: {
            traineeId: traineeId,
          },
          include: {
            course: {
              select: {
                id: true,
                name: true,
                description: true,
              },
            },
            courseClass: {
              select: {
                id: true,
                name: true,
                startDate: true,
                endDate: true,
                company: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
          orderBy: {
            issuedAt: 'desc',
          },
        },
      );

      return certificates;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async getCourseCertificate(
    traineeId: number,
    courseId: number,
  ): Promise<any> {
    try {
      const certificate = await this.prisma.selectFirst(
        'traineeCourseCertificate',
        {
          where: {
            traineeId: traineeId,
            courseId: courseId,
          },
          include: {
            course: true,
            courseClass: {
              include: {
                company: true,
              },
            },
          },
        },
      );

      if (!certificate) {
        throw new BadRequestException('Certificado n�o encontrado');
      }

      return certificate;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async getClassCertificate(traineeId: number, classId: number): Promise<any> {
    try {
      const certificate = await this.prisma.selectFirst(
        'traineeCourseCertificate',
        {
          where: {
            traineeId: traineeId,
            courseClassId: classId,
          },
          include: {
            course: true,
            courseClass: {
              include: {
                company: true,
              },
            },
          },
        },
      );

      if (!certificate) {
        throw new BadRequestException(
          'Certificado n�o encontrado para esta turma',
        );
      }

      return certificate;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async generateCertificate(traineeId: number, classId: number): Promise<any> {
    try {
      // Verificar se o aluno est� inscrito na turma
      const enrollment = await this.prisma.selectFirst(
        'courseClassSubscription',
        {
          where: {
            traineeId: traineeId,
            classId: classId,
            subscribeStatus: 'approved',
          },
          include: {
            class: {
              include: {
                onlineCourseModel: {
                  include: {
                    course: true,
                    lessons: {
                      include: {
                        lesson: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      );

      if (!enrollment) {
        throw new BadRequestException('Voc� n�o est� inscrito nesta turma');
      }

      // Verificar se j� existe certificado
      const existingCertificate = await this.prisma.selectFirst(
        'traineeCourseCertificate',
        {
          where: {
            traineeId: traineeId,
            courseClassId: classId,
          },
        },
      );

      if (existingCertificate) {
        return existingCertificate;
      }

      // Verificar progresso do curso
      const courseModel = enrollment.class.onlineCourseModel;
      const totalLessons = courseModel?.lessons?.length || 0;

      if (totalLessons > 0) {
        const lessonIds = courseModel.lessons.map((ml) => ml.lesson.id);

        const completedLessons = await this.prisma.select(
          'onlineStudentLessonProgress',
          {
            where: {
              traineeId: traineeId,
              lessonId: { in: lessonIds },
              completed: true,
            },
          },
        );

        const completionRate = (completedLessons.length / totalLessons) * 100;

        if (completionRate < 100) {
          throw new BadRequestException(
            `Voc� precisa completar todas as aulas do curso. Progresso atual: ${completionRate.toFixed(0)}%`,
          );
        }
      }

      // Gerar n�mero do certificado
      const certificateNumber = this.generateCertificateNumber(
        traineeId,
        classId,
      );

      // Criar certificado
      const certificate = await this.prisma.insert('traineeCourseCertificate', {
        traineeId: traineeId,
        courseId: courseModel?.course?.id,
        courseClassId: classId,
        certificateNumber: certificateNumber,
        issuedAt: new Date(),
        validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 ano
        status: 'issued',
        grade: 100, // Pode ser calculado baseado em avalia��es
      });

      return certificate;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async verifyCertificate(certificateNumber: string): Promise<any> {
    try {
      const certificate = await this.prisma.selectFirst(
        'traineeCourseCertificate',
        {
          where: {
            certificateNumber: certificateNumber,
          },
          include: {
            trainee: {
              select: {
                name: true,
                cpf: true,
              },
            },
            course: {
              select: {
                name: true,
                description: true,
              },
            },
            courseClass: {
              select: {
                name: true,
                startDate: true,
                endDate: true,
                company: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      );

      if (!certificate) {
        throw new BadRequestException('Certificado n�o encontrado');
      }

      // Verificar validade
      const isValid = certificate.validUntil
        ? new Date() < new Date(certificate.validUntil)
        : true;

      return {
        ...certificate,
        isValid,
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  private generateCertificateNumber(
    traineeId: number,
    classId: number,
  ): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const traineeCode = traineeId.toString(36).toUpperCase();
    const classCode = classId.toString(36).toUpperCase();
    return `CERT-${traineeCode}-${classCode}-${timestamp}`;
  }
}
