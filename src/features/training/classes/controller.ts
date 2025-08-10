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
import { ClassesService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../../upload/upload.middleware';
// Import generic controller
import { GenericController } from 'src/features/generic/generic.controller';
import { Public } from 'src/auth/decorators/public.decorator';
import { Cache, CacheEvictAll } from 'src/common/cache';
import { CacheService } from 'src/common/services/cache.service';

// Create a decorator factory for User controller permissions
function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'courseClass' as keyof PrismaClient,
  name: 'Classes',
  route: 'classes',
  permission: 'classes',
};

@Controller(entity.route)
export class ClassesController extends GenericController<
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

  // Rota intermediária para validação de permissão
  // @UserPermission(`list_${entity.permission}`) // Permissão para rota genérica
  @Public()
  @Cache({ prefix: 'training-classes', ttl: 172800 }) // 48 horas
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    const noCompany = true; // quando a rota não exige buscar companyId pelo token
    // filtros e atributos de associações
    const paramsIncludes = {
      instructors: {
        include: {
          instructor: {
            select: {
              id: true,
              name: true,
              imageUrl: true,
              active: true,
              curriculum: true,
              highlight: true,
              formation: true,
              formationCode: true,
            },
          },
        },
      },
      _count: {
        select: {
          subscriptions: {
            where: {
              subscribeStatus: 'confirmed',
            },
          },
        },
      },
    };
    return super.get(request, query, paramsIncludes, noCompany);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`create_${entity.permission}`) // Permissão para rota genérica
  @CacheEvictAll('training-classes:*', 'cache:*/classes*')
  @Post()
  @UseInterceptors(FileInterceptor('image', getMulterOptions('classes-image')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async create(
    @Req() request: Request,
    @Body() CreateDto: CreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const search = {
      courseId: CreateDto.courseId,
      initialDate: CreateDto.initialDate,
    }; // Customize search parameters if needed
    return super.create(request, CreateDto, file, search);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`update_${entity.permission}`) // Permissão para rota genérica
  @CacheEvictAll('training-classes:*', 'cache:*/classes*')
  @Put(':id')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('classes-image')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    if (!UpdateDto.price) UpdateDto.price = null;
    if (!UpdateDto.oldPrice) UpdateDto.oldPrice = null;
    if (!UpdateDto.openClass) UpdateDto.openClass = false;
    if (!UpdateDto.allowExam) UpdateDto.allowExam = false;
    if (!UpdateDto.allowReview) UpdateDto.allowReview = false;
    return super.update(id, request, UpdateDto, file);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`activate_${entity.permission}`) // Permissão para rota genérica
  @CacheEvictAll('training-classes:*', 'cache:*/classes*')
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`inactive_${entity.permission}`) // Permissão para rota genérica
  @CacheEvictAll('training-classes:*', 'cache:*/classes*')
  @Patch('inactive/:id')
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }
}
