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
export class CourseService extends GenericService<
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
  async list(search: any, entity: entity) {
    try {
      const params: any = {
        where: {
          companyId: Number(search.companyId),
          inactiveAt: null,
        },
      };

      const orderBy = [{ id: 'desc' }]; // Ordenação padrão
      const result = await this.prisma.select(entity.model, params, orderBy);

      return result;
    } catch (error) {
      throw new BadRequestException(error);
    }
  }
}
