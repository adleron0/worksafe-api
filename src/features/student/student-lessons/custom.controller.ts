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
  BadRequestException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { StudentAuth } from 'src/auth/decorators/student-auth.decorator';
import { StudentLessonsService as Service } from './service';
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../../upload/upload.middleware';
import { CacheService } from 'src/common/cache/cache.service';

const entity = {
  model: 'OnlineLesson' as keyof PrismaClient,
  name: 'StudentLessons',
  route: 'student-lessons',
  permission: 'student-lessons',
};

@Controller('student-lessons')
export class StudentLessonsCustomController {
  constructor(
    private readonly Service: Service,
    private readonly cacheService: CacheService,
  ) {
  }

  @StudentAuth()
  @Get(':lessonId/content')
  async getLessonContent(
    @Param('lessonId') lessonId: number,
    @Query('modelId') modelId: string,
    @Req() request: Request,
  ) {
    console.log(
      '🚀 ~ StudentLessonsController ~ getLessonContent ~ modelId:',
      modelId,
    );
    const traineeId = request['traineeId'];
    return this.Service.getLessonContent(
      traineeId,
      Number(lessonId),
      modelId ? Number(modelId) : undefined,
    );
  }

  @StudentAuth()
  @Get(':lessonId/steps')
  async getLessonSteps(
    @Param('lessonId') lessonId: number,
    @Req() request: Request,
  ) {
    const traineeId = request['traineeId'];
    return this.Service.getLessonSteps(traineeId, Number(lessonId));
  }

  @StudentAuth()
  @Post(':lessonId/start')
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async startLesson(
    @Param('lessonId') lessonId: number,
    @Req() request: Request,
  ) {
    const traineeId = request['traineeId'];
    return this.Service.startLesson(traineeId, Number(lessonId));
  }

  @StudentAuth()
  @Post(':lessonId/complete')
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async completeLesson(
    @Param('lessonId') lessonId: number,
    @Req() request: Request,
  ) {
    const traineeId = request['traineeId'];
    return this.Service.completeLesson(traineeId, Number(lessonId));
  }
}