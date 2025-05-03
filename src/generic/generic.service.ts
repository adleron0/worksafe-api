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
import { normalizeTerm } from 'src/utils/normalizeTerm';
import { ifNumberParseNumber } from 'src/utils/ifNumberParseNumber';

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

@Injectable()
export class GenericService<TCreateDto, TUpdateDto, TEntity> {
  constructor(
    protected prisma: PrismaService,
    private uploadService: UploadService,
  ) {}

  async create(
    dto: TCreateDto,
    logParams: any,
    entity: entity,
    file?: Express.MulterS3.File,
    searchVerify = {},
  ): Promise<TEntity> {
    try {
      // Sempre ajuste a busca do verify do create, ela é personalizada por entidade
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

      // Filtros adicionais
      for (const filter of Object.keys(filters)) {
        if (filters[filter]?.length > 0 && filters[filter].includes(',')) {
          const array = filters[filter]
            .split(',')
            .map((item) => ifNumberParseNumber(item));
          params.where[filter] = { in: array };
        } else if (filter.includes('not-')) {
          params.where[filter.split('-')[1]] = {
            not: ifNumberParseNumber(filters[filter]),
          };
        } else {
          params.where[filter] = ifNumberParseNumber(filters[filter]);
        }
      }

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
        if (key.startsWith('not-')) {
          delete params.where[key];
        }
      });

      // Filtros específicos
      if (!noCompany) {
        params.where.companyId = filters.companyId;
      }

      if (filters.searchName) {
        params.where.searchName = {
          contains: normalizeTerm(filters.searchName),
          mode: 'insensitive',
        };
      }
      if (filters.name) {
        params.where.name = {
          contains: filters.name,
          mode: 'insensitive',
        };
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
  ): Promise<TEntity> {
    try {
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
      return updated;
    } catch (error) {
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
      data['active'] = true;
      data['inactiveAt'] = null;
      data['updatedAt'] = new Date();

      if (type === 'inactive') {
        data['active'] = false;
        data['inactiveAt'] = new Date();
        data['updatedAt'] = new Date();
      }

      const user = await this.prisma.update(entity.model, data, logParams, {
        where: {
          id: id,
        },
      });

      return user;
    } catch (error) {
      throw new BadRequestException(error);
    }
  }
}
