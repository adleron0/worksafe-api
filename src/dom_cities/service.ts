import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
// entity template imports
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaClient } from '@prisma/client';
// utils specific imports
// import { normalizeTerm } from 'src/utils/normalizeTerm';

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
export class DomCitiesService {
  constructor(
    private prisma: PrismaService,
    private uploadService: UploadService,
  ) {}

  async create(
    dto: CreateDto,
    logParams: any,
    entity: entity,
    file?: Express.MulterS3.File,
  ): Promise<IEntity> {
    try {
      // Sempre ajuste a busca do verify do create, ela é personalizada por entidade
      const verifyUserCompany = await this.prisma.selectOne(entity.model, {
        where: {
          name: dto.name,
        },
      });
      if (verifyUserCompany) {
        throw new BadRequestException('Usuário já cadastrado nesta empresa');
      }

      // Se houver file, define a URL da imageUrl
      // if (file) {
      //   dto.imageUrl = file.location;
      // }

      const created = await this.prisma.insert(
        entity.model,
        {
          ...dto,
        },
        logParams,
      );

      return created;
    } catch (error) {
      throw new BadRequestException(error);
    }
  }

  async get(
    filters: any,
    entity: entity,
  ): Promise<{ total: number; rows: IEntity[] }> {
    try {
      const params: any = {};
      // Aplicando os includes
      const paramsIncludes = {};

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

      // Aplicando os filtros adicionais corretamente
      params.where = {
        // companyId: Number(filters.companyId),
      };

      if (filters.name) {
        params.where.name = {
          contains: filters.name,
          mode: 'insensitive',
        };
      }
      if (filters.userId) params.where.id = Number(filters.userId);
      if (filters.cpf) {
        params.where.cpf = { equals: filters.cpf, mode: 'insensitive' };
      }
      if (filters.active) params.where.active = filters.active === 'true';
      if (filters.stateId) params.where.stateId = Number(filters.stateId);

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

      const result = await this.prisma.selectPaging(
        entity.model,
        params,
        skip,
        limit,
        orderBy,
      );

      // Retornando a lista de usuários e a contagem total
      return result;
    } catch (error) {
      console.log(error);
      throw new BadRequestException(error);
    }
  }

  async update(
    id: number,
    dto: UpdateDto,
    logParams: logParams,
    entity: entity,
    file?: Express.MulterS3.File,
  ): Promise<IEntity> {
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
      // if (file) {
      //   if (verifyExist.imageUrl) {
      //     await this.uploadService.deleteImageFromS3(verifyExist.imageUrl);
      //   }
      //   dto.imageUrl = file.location;
      // }

      // Se `dto.imageUrl` é null e não há nova imagem, exclui a imagem existente
      // if (!dto.imageUrl && !file && verifyExist.imageUrl) {
      //   await this.uploadService.deleteImageFromS3(verifyExist.imageUrl);
      //   dto.imageUrl = null;
      // }

      const updated = await this.prisma.update(
        entity.model,
        {
          ...dto,
          // imageUrl: dto.imageUrl ?? null,
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
  ): Promise<IEntity> {
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
