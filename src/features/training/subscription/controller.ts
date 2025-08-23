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
  BadRequestException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { SubscriptionService as Service } from './service';
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
} from './rules';

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'CourseClassSubscription' as keyof PrismaClient,
  name: 'Subscription',
  route: 'subscription',
  permission: 'classes',
};

@Controller(entity.route)
export class SubscriptionController extends GenericController<
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
  // @Cache({ prefix: 'subscription', ttl: 3600 }) // descomente para usar cache (1 hora)
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    // Adiciona omitAttributes aos filtros se não estiver presente
    if (!query.omitAttributes) {
      query.omitAttributes = omitAttributes;
    }
    return super.get(request, query, paramsIncludes, noCompany);
  }

  @UserPermission(`create_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Post()
  @CacheEvictAll(
    'subscription:*',
    'cache:*/subscription*',
    'training-classes:*',
    'cache:*/classes*',
  ) // limpa cache de subscription e classes
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('subscription-image')),
  )
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
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
  @Put(':id')
  @CacheEvictAll(
    'subscription:*',
    'cache:*/subscription*',
    'training-classes:*',
    'cache:*/classes*',
  ) // limpa cache de subscription e classes
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('subscription-image')),
  )
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() body: any,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    let inactiveAt: Date | null = null;
    if (body.subscribeStatus === 'declined') {
      inactiveAt = new Date();
    } else {
      inactiveAt = null;
    }
    // Converter tipos de dados do FormData
    const UpdateDto: UpdateDto = {
      ...body,
      companyId: body.companyId ? Number(body.companyId) : undefined,
      classId: body.classId ? Number(body.classId) : undefined,
      traineeId:
        body.traineeId && body.traineeId !== 'null'
          ? Number(body.traineeId)
          : null,
      inactiveAt: inactiveAt,
    };

    // Remover campos que não devem ser atualizados
    delete UpdateDto['id'];
    delete UpdateDto['createdAt'];
    delete UpdateDto['updatedAt'];

    const processedDto = formaterPreUpdate(UpdateDto);
    return super.update(id, request, processedDto, file, hooksUpdate);
  }

  @UserPermission(`activate_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Patch('active/:id')
  @CacheEvictAll(
    'subscription:*',
    'cache:*/subscription*',
    'training-classes:*',
    'cache:*/classes*',
  ) // limpa cache de subscription e classes
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  @UserPermission(`inactive_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Patch('inactive/:id')
  @CacheEvictAll(
    'subscription:*',
    'cache:*/subscription*',
    'training-classes:*',
    'cache:*/classes*',
  ) // limpa cache de subscription e classes
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }

  // ROTA ABERTA PARA INSCRIÇÃO (com checkout integrado quando allowCheckout = true)
  @Public()
  @Post('subscribe')
  @CacheEvictAll(
    'subscription:*',
    'cache:*/subscription*',
    'training-classes:*',
    'cache:*/classes*',
  ) // limpa cache de subscription e classes
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('subscription-image')),
  )
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async subscription(
    @Req() request: Request,
    @Body() CreateDto: CreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    CreateDto.subscribeStatus = 'pending'; // Define o status de inscrição como pendente para auto-inscrição
    const search = getSearchParams(request, CreateDto);
    return this.Service.subscription(search, entity, CreateDto);
  }

}
