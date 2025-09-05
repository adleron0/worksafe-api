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
import { OnlinecoursesService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';

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
  model: 'OnlineCourseModel' as keyof PrismaClient,
  name: 'Onlinecourses',
  route: 'online-courses',
  permission: 'treinamentos',
};

@Controller(entity.route)
export class OnlinecoursesController extends GenericController<
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
  // @Cache({ prefix: 'online-courses', ttl: 3600 }) // descomente para usar cache (1 hora)
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
  // @CacheEvictAll('online-courses:*', 'cache:*/online-courses*') // descomente para limpar cache
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async create(@Req() request: Request, @Body() CreateDto: CreateDto) {
    const search = validateCreate(request, CreateDto);
    return super.create(request, CreateDto, null, search, hooksCreate);
  }

  @UserPermission(`update_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('online-courses:*', 'cache:*/online-courses*') // descomente para limpar cache
  @Put(':id')
  @UseInterceptors(FileInterceptor('file'))
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
  ) {
    const processedDto = formaterPreUpdate(UpdateDto);
    return super.update(id, request, processedDto, null, hooksUpdate);
  }

  @UserPermission(`activate_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('online-courses:*', 'cache:*/online-courses*') // descomente para limpar cache
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  @UserPermission(`inactive_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('online-courses:*', 'cache:*/online-courses*') // descomente para limpar cache
  @Patch('inactive/:id')
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }
}
