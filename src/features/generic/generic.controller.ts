// src/common/controllers/generic.controller.ts
import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Param,
  Body,
  Req,
  Query,
  applyDecorators,
  HttpCode,
  UploadedFile,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { PrismaService } from 'src/prisma/prisma.service';

type entity = {
  model: keyof PrismaClient;
  name: string;
  route: string;
  permission: string;
};

type logParams = {
  userId: string;
  companyId: string;
};

export interface ICrudService<T> {
  get(
    filters: any,
    entity: entity,
    paramsIncludes?: any,
    noCompany?: boolean,
    encryptFields?: string[] | boolean,
  ): Promise<{ total: number; rows: any[] }>;
  create(
    data: any,
    logParams: logParams,
    entity: entity,
    file?: Express.MulterS3.File | { [key: string]: Express.MulterS3.File[] },
    searchVerify?: any,
    hooks?: {
      hookPreCreate?: (params: {
        dto: any;
        entity: entity;
        prisma: PrismaService;
        logParams: any;
      }) => Promise<void> | void;
      hookPosCreate?: (
        params: {
          dto: any;
          entity: entity;
          prisma: PrismaService;
          logParams: any;
        },
        created: T,
      ) => Promise<void> | void;
    },
  ): Promise<T>;
  update(
    id: number,
    data: any,
    logParams: logParams,
    entity: entity,
    file?: Express.MulterS3.File | { [key: string]: Express.MulterS3.File[] },
    hooks?: {
      hookPreUpdate?: (params: {
        id: number;
        dto: any;
        entity: entity;
        prisma: PrismaService;
        logParams: logParams;
      }) => Promise<void> | void;
      hookPosUpdate?: (
        params: {
          id: number;
          dto: any;
          entity: entity;
          prisma: PrismaService;
          logParams: logParams;
        },
        updated: T,
      ) => Promise<void> | void;
    },
  ): Promise<T>;
  changeStatus(
    id: number,
    type: string,
    logParams: logParams,
    entity: entity,
  ): Promise<T>;
  upsert(
    data: any,
    whereCondition: any,
    logParams: logParams,
    entity: entity,
    file?: Express.MulterS3.File | { [key: string]: Express.MulterS3.File[] },
    hooks?: {
      hookPreUpsert?: (params: {
        id: number;
        dto: any;
        entity: entity;
        prisma: PrismaService;
        logParams: logParams;
      }) => Promise<void> | void;
      hookPosUpsert?: (
        params: {
          id: number;
          dto: any;
          entity: entity;
          prisma: PrismaService;
          logParams: logParams;
        },
        upserted: T,
      ) => Promise<void> | void;
    },
  ): Promise<T>;
}

// Helper function to create permission decorators
export function GenericPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

@Controller()
export class GenericController<
  TCreateDto,
  TUpdateDto,
  TEntity,
  TService extends ICrudService<TEntity>,
> {
  constructor(
    protected service: TService,
    protected entity: entity,
  ) {}

  @Get()
  async get(
    @Req() request: Request,
    @Query() query: any,
    paramsIncludes = {},
    noCompany = false,
    encryptFields: string[] | boolean = false,
  ): Promise<{ total: number; rows: TEntity[] }> {
    let userId = null;
    let companyId = null;
    if (request.user) {
      userId = request?.user?.sub;
      companyId = request?.user?.companyId;
    }
    const { startedAt, endedAt, show, self } = query;

    // Parsea o parâmetro `show` para um array
    const parseArrayParam = (param: string) => {
      if (!param) return [];
      return param
        .replace(/\[|\]/g, '')
        .split(',')
        .filter((item) => item !== '');
    };
    const includesToShow = parseArrayParam(show);

    // Monta o array de ordenação validando os campos iniciados com `order-`
    const orderBy = [];
    for (const key in query) {
      if (key.startsWith('order-')) {
        const field = key.replace('order-', '');
        const direction = query[key].toLowerCase();
        if (['asc', 'desc'].includes(direction)) {
          orderBy.push({ [field]: direction });
        }
      }
    }

    // Preparar filtros para a consulta
    const filters: any = { companyId, includesToShow, orderBy, ...query };
    filters.createdAt = [];
    if (startedAt) filters.createdAt.push(new Date(startedAt));
    if (endedAt) filters.createdAt.push(new Date(endedAt));

    // Filtro para pesquisa de perfil
    if (self === 'true') {
      filters.id = userId;
    }

    return this.service.get(
      filters,
      this.entity,
      paramsIncludes,
      noCompany,
      encryptFields,
    );
  }

  @Post()
  async create(
    @Req() request: Request,
    @Body() CreateDto: TCreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
    searchVerify?: any,
    entityHooks?: any,
  ): Promise<TEntity> {
    const { sub: userId, companyId } = request.user;
    const logParams = {
      userId,
      companyId,
    };
    CreateDto['companyId'] = Number(companyId);
    const search = searchVerify || {};
    const hooks = entityHooks || {};
    return this.service.create(
      CreateDto,
      logParams,
      this.entity,
      file,
      search,
      hooks,
    );
  }

  @Put(':id')
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: TUpdateDto,
    @UploadedFile()
    file?: Express.MulterS3.File | { [key: string]: Express.MulterS3.File[] },
    entityHooks?: any,
  ): Promise<TEntity> {
    const hooks = entityHooks || {};
    const { sub: userId, companyId } = request.user;
    const logParams = {
      userId,
      companyId,
    };
    const numberId = Number(id);
    return this.service.update(
      numberId,
      UpdateDto,
      logParams,
      this.entity,
      file,
      hooks,
    );
  }

  @Patch('active/:id')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Usuário ativado com sucesso' })
  async activate(
    @Param('id') id: number,
    @Req() request: Request,
  ): Promise<TEntity> {
    const { sub: userId, companyId } = request.user;
    const logParams = {
      userId,
      companyId,
    };
    const numberId = Number(id);
    return this.service.changeStatus(
      numberId,
      'active',
      logParams,
      this.entity,
    );
  }

  @Patch('inactive/:id')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Usuário inativado com sucesso' })
  async inactivate(
    @Param('id') id: number,
    @Req() request: Request,
  ): Promise<TEntity> {
    const { sub: userId, companyId } = request.user;
    const logParams = {
      userId,
      companyId,
    };
    const numberId = Number(id);
    return this.service.changeStatus(
      numberId,
      'inactive',
      logParams,
      this.entity,
    );
  }

  @Post('upsert')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Registro criado ou atualizado com sucesso' })
  async upsert(
    @Req() request: Request,
    @Body() upsertDto: TCreateDto | TUpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
    whereCondition?: any,
    entityHooks?: any,
  ): Promise<TEntity> {
    const { sub: userId, companyId } = request.user;
    const logParams = {
      userId,
      companyId,
    };

    // Se não foi passado whereCondition, usa a chave única ou campo específico do DTO
    // Pode ser customizado em cada controller específico
    const where = whereCondition || {};

    // Adiciona companyId se não estiver presente no DTO
    if (!upsertDto['companyId']) {
      upsertDto['companyId'] = Number(companyId);
    }

    const hooks = entityHooks || {};

    return this.service.upsert(
      upsertDto,
      where,
      logParams,
      this.entity,
      file,
      hooks,
    );
  }
}
