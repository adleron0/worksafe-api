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
import { ifNumberParseNumber } from 'src/utils/ifNumberParseNumber';

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
    entity: entity,
    options?: any,
    paramsIncludes?: any,
    noCompany?: boolean,
  ): Promise<{ total: number; rows: any[] }>;
  create(
    data: any,
    logParams: logParams,
    entity: entity,
    file?: Express.MulterS3.File,
    searchVerify?: any,
  ): Promise<T>;
  update(
    id: number,
    data: any,
    logParams: logParams,
    entity: entity,
    file?: Express.MulterS3.File,
  ): Promise<T>;
  changeStatus(
    id: number,
    type: string,
    logParams: logParams,
    entity: entity,
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
  ): Promise<{ total: number; rows: TEntity[] }> {
    let userId = null;
    let companyId = null;
    if (request.user) {
      userId = request.user.sub;
      companyId = request.user.companyId;
    }
    const { startedAt, endedAt, show, self } = query;

    // Parsea o parâmetro `show` para um array
    const parseArrayParam = (param: string) => {
      if (!param) return [];
      return param
        .replace(/[\[\]]/g, '')
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

    return this.service.get(filters, this.entity, paramsIncludes, noCompany);
  }

  @Post()
  async create(
    @Req() request: Request,
    @Body() dto: TCreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
    searchVerify?: any,
  ): Promise<TEntity> {
    const { sub: userId, companyId } = request.user;
    const logParams = {
      userId,
      companyId,
    };
    dto['companyId'] = Number(companyId);
    Object.keys(dto).forEach((key) => {
      if (
        key === 'password' ||
        key === 'cpf' ||
        key === 'cnpj' ||
        key === 'phone'
      )
        return;
      dto[key] = ifNumberParseNumber(dto[key]);
    });
    const search = searchVerify || {};
    return this.service.create(dto, logParams, this.entity, file, search);
  }

  @Put(':id')
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() dto: TUpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ): Promise<TEntity> {
    const { sub: userId, companyId } = request.user;
    const logParams = {
      userId,
      companyId,
    };
    Object.keys(dto).forEach((key) => {
      if (
        key === 'password' ||
        key === 'cpf' ||
        key === 'cnpj' ||
        key === 'phone'
      )
        return;
      dto[key] = ifNumberParseNumber(dto[key]);
    });
    const numberId = Number(id);
    return this.service.update(numberId, dto, logParams, this.entity, file);
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
}
