import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  Query,
  applyDecorators,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { StudentAuth } from 'src/auth/decorators/student-auth.decorator';
import { StudentCoursesService as Service } from './service';
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../../upload/upload.middleware';
import { CacheService } from 'src/common/cache/cache.service';

const entity = {
  model: 'CourseClassSubscription' as keyof PrismaClient,
  name: 'StudentCourses',
  route: 'student-courses',
  permission: 'student-courses',
};

@Controller('student-courses')
export class StudentCoursesCustomController {
  constructor(
    private readonly Service: Service,
    private readonly cacheService: CacheService,
  ) {
  }

  @StudentAuth()
  @Get('my-courses')
  async getMyCourses(@Req() request: Request) {
    const traineeId = request['traineeId'];
    return this.Service.getMyCourses(traineeId);
  }

  @StudentAuth()
  @Get(':classId/lessons')
  async getClassLessons(
    @Param('classId') classId: number,
    @Req() request: Request,
  ) {
    const traineeId = request['traineeId'];
    return this.Service.getClassLessons(traineeId, Number(classId));
  }
}