import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
// entity template imports
import { IEntity } from './interfaces/interface';

@Injectable()
export class UserService {
  constructor(protected prisma: PrismaService) {}

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
