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
import { DomStatesService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../upload/upload.middleware';
// Import generic controller
import { GenericController } from 'src/features/generic/generic.controller';
import { Cache } from 'src/common/cache';
import { CacheService } from 'src/common/services/cache.service';
import { Public } from 'src/auth/decorators/public.decorator';

// Create a decorator factory for User controller permissions
function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'dOM_States' as keyof PrismaClient,
  name: 'States',
  route: 'states',
  permission: 'domStates',
};

@Controller(entity.route)
export class DomStatesController extends GenericController<
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

  // Rota intermediária para validação de permissão
  // @UserPermission(`list_${entity.permission}`) // Permissão para rota genérica
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    return super.get(request, query, {}, true);
  }

  // Teste de cache
  @Public()
  @Cache({
    key: 'states-test',
    ttl: 60,
  })
  @Get('test-cache')
  async testCache() {
    console.log('Executando método testCache - buscando dados...');
    return {
      message: 'Dados do cache',
      timestamp: new Date().toISOString(),
      data: ['Estado 1', 'Estado 2', 'Estado 3'],
    };
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`create_${entity.permission}`) // Permissão para rota genérica
  @Post()
  @UseInterceptors(FileInterceptor('image', getMulterOptions('custumer-logo')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async create(
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    return super.create(request, UpdateDto, file);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`update_${entity.permission}`) // Permissão para rota genérica
  @Put(':id')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('custumer-logo')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    return super.update(id, request, UpdateDto, file);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`activate_${entity.permission}`) // Permissão para rota genérica
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`inactive_${entity.permission}`) // Permissão para rota genérica
  @Patch('inactive/:id')
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }
}
