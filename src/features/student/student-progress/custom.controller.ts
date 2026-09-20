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
  UsePipes,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StudentProgressService as Service } from './service';
import { CompleteDto } from './dto/complete.dto';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { StudentAuth } from 'src/auth/decorators/student-auth.decorator';
import { CacheService } from 'src/common/cache/cache.service';

const entity = {
  model: 'onlineStudentStepProgress' as keyof PrismaClient,
  name: 'StudentProgress',
  route: 'student-progress',
  permission: 'student-progress',
};

@Controller('student-progress')
export class StudentProgressCustomController {
  constructor(
    private readonly Service: Service,
    private readonly cacheService: CacheService,
  ) {
  }

  @StudentAuth()
  @Get('my-progress')
  async getMyProgress(@Req() req: Request, @Query() params: any) {
    const traineeId = req['traineeId'];
    return this.Service.getMyProgress(traineeId, params);
  }

  @StudentAuth()
  @Get('summary')
  async getProgressSummary(@Req() req: Request) {
    const traineeId = req['traineeId'];
    return this.Service.getProgressSummary(traineeId);
  }

  @StudentAuth()
  @Get('lesson/:lessonId')
  async getLessonProgress(
    @Req() req: Request,
    @Param('lessonId') lessonId: string,
  ) {
    const traineeId = req['traineeId'];
    return this.Service.getLessonProgress(traineeId, Number(lessonId));
  }

  @StudentAuth()
  @Post('step/:stepId/complete')
  @UseInterceptors(FileInterceptor('file')) // Adiciona suporte para FormData
  @UsePipes(
    new ValidationPipe({
      whitelist: false,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  )
  async completeStep(
    @Req() req: Request,
    @Param('stepId') stepId: string,
    @Body() body: CompleteDto,
  ) {
    const traineeId = req['traineeId'];
    console.log('Controller - req.body:', req.body);
    console.log('Controller - body após DTO:', body);

    // Se vier como FormData, os campos estarão em req.body
    const data = body.contentType ? body : req.body;

    return this.Service.completeStep(traineeId, Number(stepId), data);
  }

  @StudentAuth()
  @Post('step/:stepId/start')
  async startStep(@Req() req: Request, @Param('stepId') stepId: string) {
    const traineeId = req['traineeId'];
    return this.Service.startStep(traineeId, Number(stepId));
  }

  @StudentAuth()
  @Patch('step/:stepId/update')
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async updateStepProgress(
    @Req() req: Request,
    @Param('stepId') stepId: string,
    @Body() body: any,
  ) {
    const traineeId = req['traineeId'];
    return this.Service.updateStepProgress(traineeId, Number(stepId), body);
  }
}