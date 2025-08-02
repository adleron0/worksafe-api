import { Injectable } from '@nestjs/common';
import { GenericService } from 'src/features/generic/generic.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';
// entity template imports
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dtos/create.dto';
import { UpdateDto } from './dtos/update.dto';

@Injectable()
export class UserService extends GenericService<CreateDto, UpdateDto, IEntity> {
  constructor(
    protected prisma: PrismaService,
    private readonly authCache: AuthCacheService,
  ) {
    super(prisma, null);
  }

  async findOneUser(email: string, cnpj: string): Promise<IEntity | null> {
    // Por enquanto não vamos cachear o findOneUser usado no login
    // pois precisamos sempre validar a senha
    const user = await this.prisma.user.findFirst({
      where: {
        email: email,
        company: {
          cnpj: cnpj,
        },
      },
      include: {
        profile: {
          include: {
            permissions: {
              where: {
                inactiveAt: null,
              },
              include: {
                permission: true,
              },
            },
          },
        },
        permissions: {
          include: {
            permission: true,
          },
          where: {
            inactiveAt: null,
          },
        },
        company: {
          include: {
            products: {
              include: {
                product: true,
              },
            },
          },
        },
      },
    });

    return user as IEntity;
  }
}
