import { BadRequestException, Injectable } from '@nestjs/common';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class PermissionsService {
  constructor(private prisma: PrismaService) {}

  async activeUserPermission(payload: CreatePermissionDto, logParams: any) {
    try {
      await this.prisma.upsert(
        'userPermission',
        {
          userId: payload.userId,
          permissionId: payload.permissionId,
          inactiveAt: null,
        },
        {
          where: {
            userId_permissionId: {
              userId: payload.userId,
              permissionId: payload.permissionId,
            },
          },
        },
        logParams,
      );
    } catch (error) {
      throw new BadRequestException(error);
    }
  }

  async getAllPermissions(companyId) {
    const allPermissions = await this.prisma.select('permission', {});
    const getAllCompanyProducts = await this.prisma.select('companyProduct', {
      where: {
        companyId: companyId,
      },
      include: {
        product: true,
      },
    });

    const filterPermissions = allPermissions.filter((permission) => {
      // Verifica se há um produto com o mesmo `groupPermission` que `permission.group`
      const hasProductGroupPermission = getAllCompanyProducts.some(
        (companyProduct) =>
          companyProduct.product.groupPermission === permission.group,
      );

      // Se a permissão está vinculada a um produto, verifica se o produto está ativo
      if (hasProductGroupPermission) {
        const isActiveProduct = getAllCompanyProducts.some(
          (companyProduct) =>
            companyProduct.product.groupPermission === permission.group &&
            companyProduct.inactiveAt === null,
        );
        return isActiveProduct; // Retorna a permissão apenas se o produto estiver ativo
      }

      // Caso contrário, retorna a permissão (não vinculada a um produto)
      return true;
    });

    return filterPermissions;
  }

  async inactiveUserPermission(payload: CreatePermissionDto, logParams: any) {
    try {
      await this.prisma.erase(
        'userPermission',
        {
          where: {
            userId_permissionId: {
              userId: payload.userId,
              permissionId: payload.permissionId,
            },
          },
        },
        logParams,
      );
    } catch (error) {
      throw new BadRequestException(error);
    }
  }
}
