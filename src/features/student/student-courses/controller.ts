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
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { StudentCoursesService as Service } from './service';
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
  model: 'CourseClassSubscription' as keyof PrismaClient,
  name: 'StudentCourses',
  route: 'student-courses',
  permission: 'student-courses',
};

@Controller(entity.route)
export class StudentCoursesController extends GenericController<
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
    if (!query.omitAttributes) {
      query.omitAttributes = omitAttributes;
    }
    query.traineeId = request['traineeId'];
    query.subscribeStatus = { not: 'declined' };
    return super.get(request, query, paramsIncludes, noCompany, encryptFields);
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

  @StudentAuth()
  @Post()
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('student-courses')),
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

  @StudentAuth()
  @Put(':id')
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('student-courses')),
  )
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const processedDto = formaterPreUpdate(UpdateDto);
    return super.update(id, request, processedDto, file, hooksUpdate);
  }

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
