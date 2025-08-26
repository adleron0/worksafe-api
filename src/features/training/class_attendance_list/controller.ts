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
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { ClassAttendanceListService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../../upload/upload.middleware';
// Import generic controller
import { GenericController } from 'src/features/generic/generic.controller';
import { Public } from 'src/auth/decorators/public.decorator';
// Import cache
import { Cache, CacheEvictAll } from 'src/common/cache';
import { CacheService } from 'src/common/cache/cache.service';
// Import de configuraões
import { paramsIncludes } from './associations';
import {
  noCompany,
  getSearchParams,
  formaterPreUpdate,
  omitAttributes,
  hooksCreate,
  hooksUpdate,
  getUpsertWhereCondition,
  hooksUpsert,
  encryptFields,
} from './rules';

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'CourseClassAttendanceList' as keyof PrismaClient,
  name: 'ClassAttendanceList',
  route: 'attendance-list',
  permission: 'classes',
};

@Controller(entity.route)
export class ClassAttendanceListController extends GenericController<
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

  @UserPermission(`list_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @Cache({ prefix: 'attendance-list', ttl: 3600 }) // descomente para usar cache (1 hora)
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    // Adiciona omitAttributes aos filtros se não estiver presente
    if (!query.omitAttributes) {
      query.omitAttributes = omitAttributes;
    }
    return super.get(request, query, paramsIncludes, noCompany, encryptFields);
  }

  @UserPermission(`create_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('attendance-list:*', 'cache:*/attendance-list*') // descomente para limpar cache
  @Post()
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('class_attendance_list-image')),
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
    const search = getSearchParams(request, CreateDto);
    return super.create(request, CreateDto, file, search, hooksCreate);
  }

  @UserPermission(`update_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('attendance-list:*', 'cache:*/attendance-list*') // descomente para limpar cache
  @Put(':id')
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('class_attendance_list-image')),
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

  @UserPermission(`activate_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('attendance-list:*', 'cache:*/attendance-list*') // descomente para limpar cache
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  @UserPermission(`inactive_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('attendance-list:*', 'cache:*/attendance-list*') // descomente para limpar cache
  @Patch('inactive/:id')
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }

  @UserPermission(`create_${entity.permission}`) // mesma permissao do create
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('attendance-list:*', 'cache:*/attendance-list*') // descomente para limpar cache
  @Post('upsert')
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('class_attendance_list-image')),
  )
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async upsert(
    @Req() request: Request,
    @Body() upsertDto: CreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const whereCondition = getUpsertWhereCondition(request, upsertDto);

    return super.upsert(request, upsertDto, file, whereCondition, hooksUpsert);
  }
}
