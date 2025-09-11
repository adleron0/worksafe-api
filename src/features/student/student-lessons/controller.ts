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
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { StudentLessonsService as Service } from './service';
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../../upload/upload.middleware';
import { GenericController } from 'src/features/generic/generic.controller';
import { CacheService } from 'src/common/cache/cache.service';
import { paramsIncludes } from './associations';
import {
  noCompany,
  validateCreate,
  formaterPreUpdate,
  omitAttributes,
  hooksCreate,
  hooksUpdate,
  encryptFields,
} from './rules';

const entity = {
  model: 'OnlineLesson' as keyof PrismaClient,
  name: 'StudentLessons',
  route: 'student-lessons',
  permission: 'student-lessons',
};

@Controller(entity.route)
export class StudentLessonsController extends GenericController<
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
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    // Por enquanto retorna lista vazia - implementação pode ser expandida
    // O aluno deve acessar as aulas através dos cursos inscritos
    return {
      total: 0,
      rows: [],
    };
  }

  @StudentAuth()
  @Get(':lessonId/content')
  async getLessonContent(
    @Param('lessonId') lessonId: number,
    @Req() request: Request,
  ) {
    const traineeId = request['traineeId'];
    return this.Service.getLessonContent(traineeId, Number(lessonId));
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

  @StudentAuth()
  @Post()
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('student-lessons')),
  )
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async create(
    @Req() request: Request,
    @Body() CreateDto: CreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const search = validateCreate(request, CreateDto);
    return super.create(request, CreateDto, file, search, hooksCreate);
  }

  // PUT desabilitado para esta feature

  @StudentAuth()
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  @StudentAuth()
  @Patch('inactive/:id')
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }
}
