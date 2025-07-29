import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
// utils specific imports
import { hash } from 'bcrypt';
import { ifNumberParseNumber } from 'src/utils/ifNumberParseNumber';
import { ifBooleanParseBoolean } from 'src/utils/isBooleanParseBoolean';

type logParams = {
  userId: string;
  companyId: string;
};

type entity = {
  model: keyof PrismaClient;
  name: string;
  route: string;
  permission: string;
};

// Função utilitária para processar filtros
function parseFilterObject(filterObj: any) {
  const condition: any = {};
  for (const key in filterObj) {
    if (key.includes('in-')) {
      const array = filterObj[key]
        .split(',')
        .map((item: any) => ifNumberParseNumber(item));
      condition[key.split('-')[1]] = { in: array };
    } else if (key.includes('notin-')) {
      const array = filterObj[key]
        .split(',')
        .map((item: any) => ifNumberParseNumber(item));
      condition[key.split('-')[1]] = { notIn: array };
    } else if (key.includes('like-')) {
      condition[key.split('-')[1]] = {
        contains: filterObj[key],
        mode: 'insensitive',
      };
    } else if (key.includes('not-')) {
      condition[key.split('-')[1]] = {
        not: ifNumberParseNumber(filterObj[key]),
      };
    } else if (key.includes('gt-')) {
      condition[key.split('-')[1]] = {
        gt: ifNumberParseNumber(filterObj[key]),
      };
    } else if (key.includes('lt-')) {
      condition[key.split('-')[1]] = {
        lt: ifNumberParseNumber(filterObj[key]),
      };
    } else if (key.includes('gte-')) {
      condition[key.split('-')[1]] = {
        gte: ifNumberParseNumber(filterObj[key]),
      };
    } else if (key.includes('lte-')) {
      condition[key.split('-')[1]] = {
        lte: ifNumberParseNumber(filterObj[key]),
      };
    } else if (key.includes('notlike-')) {
      condition[key.split('-')[1]] = {
        not: {
          contains: filterObj[key],
          mode: 'insensitive',
        },
      };
    } else {
      condition[key] = ifNumberParseNumber(filterObj[key]);
      condition[key] = ifBooleanParseBoolean(condition[key]);
    }
  }
  return condition;
}

@Injectable()
export class GenericService<TCreateDto, TUpdateDto, TEntity> {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
  ) {}

  async create(
    dto: TCreateDto,
    logParams: any,
    entity: entity,
    file?: Express.MulterS3.File,
    searchVerify = {},
    hooks?: {
      hookPreCreate?: (params: {
        dto: TCreateDto;
        entity: entity;
        prisma: PrismaService;
        logParams: any;
      }) => Promise<void> | void;
      hookPosCreate?: (
        params: {
          dto: TCreateDto;
          entity: entity;
          prisma: PrismaService;
          logParams: any;
        },
        created: TEntity,
      ) => Promise<void> | void;
    },
  ): Promise<TEntity> {
    try {
      if (hooks?.hookPreCreate) {
        await hooks.hookPreCreate({
          dto,
          entity,
          prisma: this.prisma,
          logParams,
        });
      }
      // Sempre ajuste a busca do verify do rules, ela é personalizada por entidade
      const verify = await this.prisma.selectFirst(entity.model, {
        where: {
          ...searchVerify,
        },
      });
      if (verify) {
        throw new BadRequestException(`${entity.name} já cadastrado`);
      }

      // Se houver file, define a URL da imageUrl
      if (file) {
        dto['imageUrl'] = file.location;
      }

      // Se `dto.password` existir, criptografa-a
      if (dto['password']) {
        const saltRounds = 10;
        const passwordHashed = await hash(dto['password'], saltRounds);
        dto['password'] = passwordHashed;
      }

      const created = await this.prisma.insert(
        entity.model,
        {
          ...dto,
        },
        logParams,
      );

      if (hooks?.hookPosCreate) {
        await hooks.hookPosCreate(
          { dto, entity, prisma: this.prisma, logParams },
          created,
        );
      }
      return created;
    } catch (error) {
      console.log('🚀 ~ GenericService<TCreateDto, ~ error:', error);
      throw new BadRequestException(error);
    }
  }

  async get(
    filters: any,
    entity: entity,
    paramsIncludes = {},
    noCompany = false,
  ): Promise<{ total: number; rows: TEntity[] }> {
    try {
      const params: any = {};

      params.include = {};
      if (filters.includesToShow.length) {
        for (const association of filters.includesToShow) {
          if (paramsIncludes.hasOwnProperty(association)) {
            params.include[association] = paramsIncludes[association];
          } else {
            params.include[association] = true;
          }
        }
      }

      // Excluindo atributos
      params.omit = {};

      if (filters.omitAttributes) {
        for (const attribute of filters.omitAttributes) {
          params.omit[attribute] = true;
        }
      }

      // Aplicando os filtros adicionais corretamente
      params.where = {};

      // Suporte ao filtro OR
      if (filters.or && Array.isArray(filters.or)) {
        params.where.OR = filters.or.map((orFilter: any) =>
          parseFilterObject(orFilter),
        );
        // Remove o filtro 'or' do objeto principal para não duplicar condições
        delete filters.or;
      }

      // Filtros adicionais
      Object.assign(params.where, parseFilterObject(filters));

      // Deleta Específicos
      delete params.where.includesToShow;
      delete params.where.page;
      delete params.where.limit;
      delete params.where.active;
      delete params.where.orderBy;
      delete params.where.all;
      delete params.where.companyId;
      delete params.where.self;
      delete params.where.show;
      delete params.where.startedAt;
      delete params.where.endedAt;
      delete params.where.createdAt;
      delete params.where.omitAttributes;
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('order-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('in-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('notin-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('not-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('gte-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('lte-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('gt-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('lt-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('like-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('notlike-')) {
          delete params.where[key];
        }
      });

      // Filtros específicos
      if (!noCompany) {
        params.where.companyId = filters.companyId;
      }

      if (filters.active === 'true') {
        // quero só os ativos → inactiveAt IS NULL
        params.where.inactiveAt = null;
      } else if (filters.active === 'false') {
        // quero só os inativos → inactiveAt IS NOT NULL
        params.where.inactiveAt = { not: null };
      }
      if (filters?.createdAt?.length === 1) {
        params.where.createdAt = new Date(filters.createdAt[0]);
      } else if (filters?.createdAt?.length === 2) {
        params.where.createdAt = {
          gte: new Date(filters.createdAt[0]),
          lte: new Date(filters.createdAt[1]),
        };
      }
        console.log("🚀 ~ GenericService ~ get ~ params:", params)

      // Definindo valores padrão para página e limite
      const page = filters.page ? Number(filters.page) + 1 : 1;
      const limit = filters.limit ? Number(filters.limit) : 10;

      // Calculando o número de itens a serem pulados (skip) com base na página atual
      const skip = (page - 1) * limit;

      // Ordenação
      let orderBy = [{ id: 'desc' }]; // Ordenação padrão
      if (filters.orderBy.length) orderBy = filters.orderBy; // Ordenação customizada da busca

      let result;
      if (filters.all) {
        result = await this.prisma.select(entity.model, params, orderBy);
      } else {
        result = await this.prisma.selectPaging(
          entity.model,
          params,
          skip,
          limit,
          orderBy,
        );
      }

      // Retornando a lista de usuários e a contagem total
      return result;
    } catch (error) {
      console.log('🚀 ~ GenericService<TCreateDto, ~ error:', error);
      throw new BadRequestException(error);
    }
  }

  async update(
    id: number,
    dto: TUpdateDto,
    logParams: logParams,
    entity: entity,
    file?: Express.MulterS3.File,
    hooks?: {
      hookPreUpdate?: (params: {
        id: number;
        dto: TUpdateDto;
        entity: entity;
        prisma: PrismaService;
        logParams: logParams;
      }) => Promise<void> | void;
      hookPosUpdate?: (
        params: {
          id: number;
          dto: TUpdateDto;
          entity: entity;
          prisma: PrismaService;
          logParams: logParams;
        },
        updated: TEntity,
      ) => Promise<void> | void;
    },
  ): Promise<TEntity> {
    try {
      if (hooks?.hookPreUpdate) {
        await hooks.hookPreUpdate({
          id,
          dto,
          entity,
          prisma: this.prisma,
          logParams,
        });
      }
      const verifyExist = await this.prisma.selectOne(entity.model, {
        where: {
          id: id,
        },
      });

      if (!verifyExist) {
        throw new NotFoundException(`${entity.name} não encontrado`);
      }

      // Se uma nova imagem foi enviada, exclui a imagem antiga e define a nova URL
      if (file) {
        if (verifyExist.imageUrl) {
          await this.uploadService.deleteImageFromS3(verifyExist.imageUrl);
        }
        dto['imageUrl'] = file.location;
      }

      // Se `dto.imageUrl` é null e não há nova imagem, exclui a imagem existente
      if (!dto['imageUrl'] && !file && verifyExist.imageUrl) {
        await this.uploadService.deleteImageFromS3(verifyExist.imageUrl);
        dto['imageUrl'] = null;
      }

      // Se houver uma nova senha, criptografa-a
      if (dto['password']) {
        const saltRounds = 10;
        const passwordHashed = await hash(dto['password'], saltRounds);
        dto['password'] = passwordHashed;
      }

      const updated = await this.prisma.update(
        entity.model,
        {
          ...dto,
        },
        logParams,
        {},
        id,
      );
      if (hooks?.hookPosUpdate) {
        await hooks.hookPosUpdate(
          { id, dto, entity, prisma: this.prisma, logParams },
          updated,
        );
      }
      return updated;
    } catch (error) {
      console.log('🚀 ~ GenericService<TCreateDto, ~ error:', error);
      throw new BadRequestException(error);
    }
  }

  async changeStatus(
    id: number,
    type: string,
    logParams: logParams,
    entity: entity,
  ): Promise<TEntity> {
    const verifyExist = await this.prisma.selectOne(entity.model, {
      where: {
        id: id,
      },
    });
    if (!verifyExist) {
      throw new NotFoundException(`${entity.name} não encontrado`);
    }

    try {
      const data = {};
      data['updatedAt'] = new Date();

      if (verifyExist.hasOwnProperty('active')) data['active'] = true;
      if (verifyExist.hasOwnProperty('inactiveAt')) data['inactiveAt'] = null;
      if (verifyExist.hasOwnProperty('deletedAt')) data['deletedAt'] = null;
      if (verifyExist.hasOwnProperty('status')) data['status'] = true;

      if (type === 'inactive') {
        if (verifyExist.hasOwnProperty('active')) data['active'] = false;
        if (verifyExist.hasOwnProperty('inactiveAt'))
          data['inactiveAt'] = new Date();
        if (verifyExist.hasOwnProperty('deletedAt'))
          data['deletedAt'] = new Date();
        if (verifyExist.hasOwnProperty('status')) data['status'] = false;
      }

      const user = await this.prisma.update(entity.model, data, logParams, {
        where: {
          id: id,
        },
      });

      return user;
    } catch (error) {
      console.log('🚀 ~ GenericService<TCreateDto, ~ error:', error);
      throw new BadRequestException(error);
    }
  }
}
