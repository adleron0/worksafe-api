import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateUserPermissionDto } from './dto/create-user-permission.dto';
import { CreateProfilePermissionDto } from './dto/create-profile-permission.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';
import { InvalidateAuthCache } from 'src/common/cache/auth-cache.decorator';

@Injectable()
export class PermissionsService {
  constructor(
    private prisma: PrismaService,
    private readonly authCache: AuthCacheService,
  ) {}

  /**
   * O alvo (usuário ou perfil) precisa pertencer à empresa do requisitante.
   * Sem isto, quem tinha activate_profile concedia permissão a usuário de
   * qualquer empresa. 404 e não 403: não revela que o id existe.
   */
  async assertUserInCompany(userId: number, companyId: number): Promise<void> {
    const user = await this.prisma.selectFirst('user', {
      where: { id: userId, companyId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');
  }

  async assertProfileInCompany(profileId: number, companyId: number): Promise<void> {
    const profile = await this.prisma.selectFirst('profile', {
      where: { id: profileId, companyId },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException('Perfil não encontrado');
  }

  @InvalidateAuthCache('user', (args) => args[0].userId)
  async activeUserPermission(payload: CreateUserPermissionDto, logParams: any) {
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
      console.log(
        '🚀 ~ PermissionsService ~ activeUserPermission ~ error:',
        error,
      );
      throw new BadRequestException(error);
    }
  }

  @InvalidateAuthCache('profile', (args) => args[0].profileId)
  async activeProfilePermission(
    payload: CreateProfilePermissionDto,
    logParams: any,
  ) {
    try {
      await this.prisma.upsert(
        'profilePermission',
        {
          profileId: payload.profileId,
          permissionId: payload.permissionId,
          inactiveAt: null,
        },
        {
          where: {
            profileId: payload.profileId,
            permissionId: payload.permissionId,
          },
        },
        logParams,
      );
    } catch (error) {
      console.log('🚀 ~ PermissionsService ~ error:', error);
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

  @InvalidateAuthCache('user', (args) => args[0].userId)
  async inactiveUserPermission(
    payload: CreateUserPermissionDto,
    logParams: any,
  ) {
    console.log('🚀 ~ PermissionsService ~ payload:', payload);
    try {
      const result = await this.prisma.erase(
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
      console.log('🚀 ~ PermissionsService ~ result:', result);
    } catch (error) {
      console.log('🚀 ~ PermissionsService ~ error:', error);
      throw new BadRequestException(error);
    }
  }

  @InvalidateAuthCache('profile', (args) => args[0].profileId)
  async inactiveProfilePermission(
    payload: CreateProfilePermissionDto,
    logParams: any,
  ) {
    try {
      await this.prisma.erase(
        'profilePermission',
        {
          where: {
            profileId_permissionId: {
              profileId: payload.profileId,
              permissionId: payload.permissionId,
            },
          },
        },
        logParams,
      );
    } catch (error) {
      console.log('🚀 ~ PermissionsService ~ error:', error);
      throw new BadRequestException(error);
    }
  }
}
