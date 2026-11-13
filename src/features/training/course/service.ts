import { PrismaClient } from '@prisma/client';
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

type entity = {
  model: keyof PrismaClient;
  name: string;
  route: string;
  permission: string;
};

@Injectable()
export class CourseService {
  constructor(protected prisma: PrismaService) {
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

      // Lista pública: o gabarito da prova não sai daqui.
      return result.map(({ exam: _exam, ...course }) => course);
    } catch (error) {
      console.log('🚀 ~ CourseService ~ list ~ error:', error);
      throw new BadRequestException(error);
    }
  }
}
