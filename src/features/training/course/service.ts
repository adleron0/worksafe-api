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
      let companyId = search.companyId;
      if (!companyId) {
        const whereCompany = {};
        if (search.lp_domain) whereCompany['lp_domain'] = search.lp_domain;
        if (search.system_domain)
          whereCompany['system_domain'] = search.system_domain;
        const company = await this.prisma.select(
          'company',
          {
            where: whereCompany,
            select: {
              id: true,
            },
          },
          [{ id: 'desc' }],
        );
        if (company.length > 0) {
          companyId = company[0].id;
        }
      }
      if (!companyId) {
        return [];
      }
      const params: any = {
        where: {
          companyId: Number(companyId),
          inactiveAt: null,
        },
      };

      const orderBy = [{ id: 'desc' }]; // Ordenação padrão
      const result = await this.prisma.select(entity.model, params, orderBy);

      return result;
    } catch (error) {
      console.log("🚀 ~ CourseService ~ list ~ error:", error)
      throw new BadRequestException(error);
    }
  }
}
