import { GenericController } from 'src/features/generic/generic.controller';
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Patch,
  Query,
  ValidationPipe,
  Req,
} from '@nestjs/common';
import { StudentEvaluationsService as Service } from './service';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { paramsIncludes } from './associations';
import { StudentAuth } from 'src/auth/decorators/student-auth.decorator';
import { CacheService } from 'src/common/cache/cache.service';

const entity = {
  model: 'courseClassExam' as keyof PrismaClient,
  name: 'StudentEvaluations',
  route: 'student-evaluations',
  permission: 'student-evaluations',
};

@Controller(entity.route)
export class StudentEvaluationsController extends GenericController<
  CreateDto,
  UpdateDto,
  IEntity,
  Service
> {
  constructor(
    private readonly Service: Service,
    private readonly cacheService: CacheService,
  ) {
    super(Service, entity);
  }

  @StudentAuth()
  @Get('my-evaluations')
  async getMyEvaluations(@Req() req: Request) {
    const traineeId = req['traineeId'];
    return this.Service.getMyEvaluations(traineeId);
  }

  @StudentAuth()
  @Get('lesson/:lessonId')
  async getLessonEvaluation(
    @Req() req: Request,
    @Param('lessonId') lessonId: string,
  ) {
    const traineeId = req['traineeId'];
    return this.Service.getLessonEvaluation(traineeId, Number(lessonId));
  }

  @StudentAuth()
  @Post('start/:lessonId')
  async startEvaluation(
    @Req() req: Request,
    @Param('lessonId') lessonId: string,
    @Body() body: any,
  ) {
    const traineeId = req['traineeId'];
    return this.Service.startEvaluation(
      traineeId,
      Number(lessonId),
      body.courseClassId,
    );
  }

  @StudentAuth()
  @Post('submit/:evaluationId')
  async submitEvaluation(
    @Req() req: Request,
    @Param('evaluationId') evaluationId: string,
    @Body() body: any,
  ) {
    const traineeId = req['traineeId'];
    return this.Service.submitEvaluation(traineeId, Number(evaluationId), body);
  }

  @StudentAuth()
  @Get('results/:evaluationId')
  async getEvaluationResults(
    @Req() req: Request,
    @Param('evaluationId') evaluationId: string,
  ) {
    const traineeId = req['traineeId'];
    return this.Service.getEvaluationResults(traineeId, Number(evaluationId));
  }

  @StudentAuth()
  @Get('class/:classId/summary')
  async getClassEvaluationSummary(
    @Req() req: Request,
    @Param('classId') classId: string,
  ) {
    const traineeId = req['traineeId'];
    return this.Service.getClassEvaluationSummary(traineeId, Number(classId));
  }
}
