import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';

@Injectable()
export class CompanyService extends GenericService<
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
   * Valida os primeiros passos da empresa no sistema
   */
  async validateFirstSteps(companyId: number): Promise<{
    hasCourse: boolean;
    hasInstructor: boolean;
    hasInstructorSignature: boolean;
    hasCertificate: boolean;
    hasAsaasToken: boolean;
    hasClass: boolean;
  }> {
    try {
      // 1. Verificar se tem ao menos 1 curso cadastrado
      const courseCount = await this.prisma.course.count({
        where: {
          companyId,
          inactiveAt: null,
        },
      });

      // 2. Verificar se tem instrutores cadastrados
      const instructors = await this.prisma.instructor.findMany({
        where: {
          companyId,
          inactiveAt: null,
        },
        select: {
          signatureUrl: true,
        },
      });

      // 3. Verificar se tem ao menos 1 assinatura de instrutor
      const hasInstructorSignature = instructors.some(
        (instructor) =>
          instructor.signatureUrl !== null && instructor.signatureUrl !== '',
      );

      // 4. Verificar se tem certificado cadastrado
      const certificateCount = await this.prisma.couseCertificate.count({
        where: {
          companyId,
          inactiveAt: null,
        },
      });

      // 5. Verificar se tem conta no Asaas cadastrada
      const asaasGateway = await this.prisma.companyGateWays.count({
        where: {
          companyId,
          gateway: 'asaas',
          active: true,
          inactiveAt: null,
        },
      });

      // 6. Verificar se tem turma criada
      const classCount = await this.prisma.courseClass.count({
        where: {
          companyId,
          inactiveAt: null,
        },
      });

      return {
        hasCourse: courseCount > 0,
        hasInstructor: instructors.length > 0,
        hasInstructorSignature,
        hasCertificate: certificateCount > 0,
        hasAsaasToken: asaasGateway > 0,
        hasClass: classCount > 0,
      };
    } catch (error) {
      throw new BadRequestException(
        `Erro ao validar primeiros passos: ${error.message}`,
      );
    }
  }
}
