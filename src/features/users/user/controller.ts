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
import { Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { CreateDto } from './dtos/create.dto';
import { UpdateDto } from './dtos/update.dto';
import { IEntity } from './interfaces/interface';
import { UserService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../../upload/upload.middleware';
// Import generic controller
import { GenericController } from 'src/features/generic/generic.controller';
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

// Create a decorator factory for User controller permissions
function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'user' as keyof PrismaClient,
  name: 'Usuário',
  route: 'user',
  permission: 'user',
};

@Controller(entity.route)
export class UserController extends GenericController<
  CreateDto,
  UpdateDto,
  IEntity,
  Service
> {
  constructor(private readonly Service: Service) {
    super(Service, entity);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`list_${entity.permission}`) // Permissão para rota genérica
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    if (!query.omitAttributes) {
      query.omitAttributes = omitAttributes;
    }

    return super.get(request, query, paramsIncludes, noCompany, encryptFields);
  }

  @Get('self')
  async getSelf(@Req() request: Request, @Query() query: any) {
    query.self = 'true';
    if (!query.omitAttributes) {
      query.omitAttributes = omitAttributes;
    }
    return super.get(request, query);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`create_${entity.permission}`) // Permissão para rota genérica
  @Post()
  @UseInterceptors(FileInterceptor('image', getMulterOptions('user-profile')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async create(
    @Req() request: Request,
    @Body() CreateDto: CreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const search = validateCreate(request, CreateDto);
    return super.create(request, CreateDto, file, search, hooksCreate);
  }

  @Put('self')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('user-profile')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async updateSelf(
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const id = Number(request.user.sub);
    const processedDto = formaterPreUpdate(UpdateDto);
    return super.update(id, request, processedDto, file);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(`update_${entity.permission}`) // Permissão para rota genérica
  @Put(':id')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('user-profile')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const processedDto = formaterPreUpdate(UpdateDto);
    return super.update(id, request, processedDto, file, hooksUpdate);
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
