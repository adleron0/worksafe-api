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
import { StudentAuth } from 'src/auth/decorators/student-auth.decorator';
// Import entity template
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { StudentService as Service } from './service';
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
  validateCreate,
  formaterPreUpdate,
  omitAttributes,
  hooksCreate,
  hooksUpdate,
  encryptFields,
} from './rules';

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'Trainee' as keyof PrismaClient,
  name: 'Student',
  route: 'student',
  permission: 'student',
};

@Controller(entity.route)
export class StudentController extends GenericController<
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
  async get(@Req() request: Request, @Query() query: any) {
    // Adiciona omitAttributes aos filtros se não estiver presente
    if (!query.omitAttributes) {
      query.omitAttributes = omitAttributes;
    }
    // Força o filtro pelo próprio traineeId para segurança
    query.id = request['traineeId'];
    return super.get(request, query, paramsIncludes, noCompany, encryptFields);
  }

  @StudentAuth()
  @Get('profile')
  async getProfile(@Req() request: Request) {
    const traineeId = request['traineeId'];
    // Retorna apenas o perfil do próprio aluno
    const query = {
      id: traineeId,
      omitAttributes: omitAttributes,
    };
    return super.get(request, query, paramsIncludes, noCompany, encryptFields);
  }

  @StudentAuth() // Usa autenticação de aluno
  // @CacheEvictAll('student:*', 'cache:*/student*') // descomente para limpar cache
  @Post()
  @UseInterceptors(FileInterceptor('image', getMulterOptions('student-image')))
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

  @StudentAuth() // Usa autenticação de aluno
  // @CacheEvictAll('student:*', 'cache:*/student*') // descomente para limpar cache
  @Put(':id')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('student-image')))
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

  @StudentAuth() // Usa autenticação de aluno
  // @CacheEvictAll('student:*', 'cache:*/student*') // descomente para limpar cache
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  @StudentAuth() // Usa autenticação de aluno
  // @CacheEvictAll('student:*', 'cache:*/student*') // descomente para limpar cache
  @Patch('inactive/:id')
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }
}
