import { Public } from 'src/auth/decorators/public.decorator';
import { Controller, Get, Post, Param, Query, Req } from '@nestjs/common';
import { StudentCertificatesService as Service } from './service';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { StudentAuth } from 'src/auth/decorators/student-auth.decorator';
import { CacheService } from 'src/common/cache/cache.service';

const entity = {
  model: 'traineeCourseCertificate' as keyof PrismaClient,
  name: 'StudentCertificates',
  route: 'student-certificates',
  permission: 'student-certificates',
};

@Controller('student-certificates')
export class StudentCertificatesCustomController {
  constructor(
    private readonly Service: Service,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
  ) {
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

  @Public() // consulta pública de autenticidade
  @Get('verify/:certificateNumber')
  async verifyCertificate(
    @Param('certificateNumber') certificateNumber: string,
  ) {
    return this.Service.verifyCertificate(certificateNumber);
  }
}