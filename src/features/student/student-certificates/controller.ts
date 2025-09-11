import { GenericController } from 'src/features/generic/generic.controller';
import { Controller, Get, Post, Param, Query, Req } from '@nestjs/common';
import { StudentCertificatesService as Service } from './service';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { paramsIncludes } from './associations';
import { StudentAuth } from 'src/auth/decorators/student-auth.decorator';
import { CacheService } from 'src/common/cache/cache.service';
import { noCompany, omitAttributes, encryptFields } from './rules';

const entity = {
  model: 'traineeCourseCertificate' as keyof PrismaClient,
  name: 'StudentCertificates',
  route: 'student-certificates',
  permission: 'student-certificates',
};

@Controller(entity.route)
export class StudentCertificatesController extends GenericController<
  CreateDto,
  UpdateDto,
  IEntity,
  Service
> {
  constructor(
    private readonly Service: Service,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
  ) {
    super(Service, entity);
  }

  @StudentAuth()
  @Get()
  async get(
    @Req() request: Request,
    @Query() query: any,
  ): Promise<{ total: number; rows: IEntity[] }> {
    // Adiciona omitAttributes aos filtros se não estiver presente
    if (!query.omitAttributes) {
      query.omitAttributes = omitAttributes;
    }
    query.traineeId = request['traineeId'];
    return super.get(request, query, paramsIncludes, noCompany, encryptFields);
  }

  @StudentAuth()
  @Get('my-certificates')
  async getMyCertificates(@Req() req: Request) {
    const traineeId = req['traineeId'];
    return this.Service.getMyCertificates(traineeId);
  }

  @StudentAuth()
  @Get('course/:courseId')
  async getCourseCertificate(
    @Req() req: Request,
    @Param('courseId') courseId: string,
  ) {
    const traineeId = req['traineeId'];
    return this.Service.getCourseCertificate(traineeId, Number(courseId));
  }

  @StudentAuth()
  @Get('class/:classId')
  async getClassCertificate(
    @Req() req: Request,
    @Param('classId') classId: string,
  ) {
    const traineeId = req['traineeId'];
    return this.Service.getClassCertificate(traineeId, Number(classId));
  }

  @StudentAuth()
  @Post('generate/:classId')
  async generateCertificate(
    @Req() req: Request,
    @Param('classId') classId: string,
  ) {
    const traineeId = req['traineeId'];
    return this.Service.generateCertificate(traineeId, Number(classId));
  }

  @Get('verify/:certificateNumber')
  async verifyCertificate(
    @Param('certificateNumber') certificateNumber: string,
  ) {
    return this.Service.verifyCertificate(certificateNumber);
  }
}
