import { GenericService } from 'src/features/generic/generic.service';
import { PrismaClient } from '@prisma/client';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';

type entity = {
  model: keyof PrismaClient;
  name: string;
  route: string;
  permission: string;
};

@Injectable()
export class SubscriptionService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(protected prisma: PrismaService) {
    super(prisma, null);
  }

  /**
   * Método específico customizado
   */
  async subscription(search: any, entity: entity, dto: CreateDto) {
    try {
      const verify = await this.prisma.selectFirst(entity.model, {
        where: {
          ...search,
        },
      });
      if (verify) {
        throw new BadRequestException(`${entity.name} já cadastrado`);
      }

      // Pesquisa a turma
      const limit = await this.prisma.selectFirst('courseClass', {
        where: {
          companyId: Number(search.companyId),
          id: Number(search.classId),
        },
        select: {
          maxSubscriptions: true,
          name: true,
        },
      });

      // Verifica se o limite de inscrições foi atingido
      const total = await this.prisma.select(entity.model, {
        where: {
          companyId: Number(search.companyId),
          classId: Number(search.classId),
          subscribeStatus: 'confirmed',
        },
      });
      if (total.length >= Number(limit?.maxSubscriptions)) {
        throw new BadRequestException(
          `O limite de inscrições para a turma ${limit?.name} foi atingido`,
        );
      }

      const logParams = {
        userId: 0,
        companyId: dto.companyId || null,
      };

      const created = await this.prisma.insert(
        entity.model,
        {
          ...dto,
        },
        logParams,
      );

      return created;
    } catch (error) {
      console.log("🚀 ~ SubscriptionService ~ subscription ~ error:", error)
      throw new BadRequestException(error);
    }
  }
}
