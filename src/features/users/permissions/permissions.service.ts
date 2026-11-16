import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { extractUserPermissions } from 'src/auth/utils/check-permission.util';
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

  /**
   * Quem não é super só concede ou retira permissões que ele mesmo tem, e não
   * mexe em perfil ou usuário super. Sem isto, quem gerencia perfis se dava
   * qualquer permissão (bots, integrações, base de cálculo) com dois cliques.
   */
  async assertCanAssign(requester: any, permissionIds: number[]): Promise<void> {
    if (requester?.profile === 'super' || permissionIds.length === 0) return;
    const held = new Set(extractUserPermissions(requester));
    const perms = await this.prisma.permission.findMany({
      where: { id: { in: permissionIds } },
      select: { id: true, name: true, description: true },
    });
    if (perms.length !== new Set(permissionIds).size) {
      throw new BadRequestException('Permissão inexistente na lista');
    }
    const missing = perms.filter((perm) => !held.has(perm.name));
    if (missing.length) {
      throw new ForbiddenException(
        `Você só pode conceder ou retirar permissões que você mesmo tem. Fora do seu alcance: ${missing.map((perm) => perm.description).join(', ')}`,
      );
    }
  }

  async assertTargetNotSuper(requester: any, target: { profileId?: number; userId?: number }) {
    if (requester?.profile === 'super') return;
    const name = target.profileId
      ? (await this.prisma.profile.findUnique({ where: { id: target.profileId }, select: { name: true } }))?.name
      : (await this.prisma.user.findUnique({ where: { id: target.userId }, select: { profile: { select: { name: true } } } }))?.profile?.name;
    if (name === 'super') throw new ForbiddenException('Só o super altera as permissões do perfil super');
  }

  /** O que a tela de permissões precisa: nome, concedidas e (no usuário) as do perfil. */
  async getAssigned(target: { profileId?: number; userId?: number }) {
    const active = (rows: Array<{ permissionId: number }>) => rows.map((row) => row.permissionId);
    if (target.profileId) {
      const profile = await this.prisma.profile.findUnique({
        where: { id: target.profileId },
        select: { id: true, name: true, permissions: { where: { inactiveAt: null }, select: { permissionId: true } } },
      });
      return { id: profile.id, name: profile.name, granted: active(profile.permissions), inherited: [] as number[] };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: target.userId },
      select: {
        id: true, name: true,
        permissions: { where: { inactiveAt: null }, select: { permissionId: true } },
        profile: { select: { name: true, permissions: { where: { inactiveAt: null }, select: { permissionId: true } } } },
      },
    });
    return {
      id: user.id, name: user.name, profileName: user.profile?.name ?? null,
      granted: active(user.permissions), inherited: active(user.profile?.permissions ?? []),
    };
  }

  /**
   * Salva de uma vez o que a tela de permissões marcou e desmarcou: tudo numa
   * transação (ou vale tudo, ou nada) e o cache de acesso invalidado uma vez.
   */
  async saveBulk(
    target: { profileId?: number; userId?: number },
    changes: { grant?: unknown; revoke?: unknown },
    requester: any,
  ) {
    const ids = (value: unknown) =>
      [...new Set((Array.isArray(value) ? value : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const grant = ids(changes.grant);
    const revoke = ids(changes.revoke).filter((id) => !grant.includes(id));
    if (!grant.length && !revoke.length) return { granted: 0, revoked: 0 };

    await this.assertTargetNotSuper(requester, target);
    await this.assertCanAssign(requester, [...grant, ...revoke]);

    const logParams = { userId: requester?.sub, companyId: requester?.companyId };
    const model = target.profileId ? 'profilePermission' : 'userPermission';
    const owner = target.profileId ? { profileId: target.profileId } : { userId: target.userId };

    await this.prisma.$transaction(async (tx) => {
      for (const permissionId of grant) {
        await this.prisma.upsert(model as any, { ...owner, permissionId, inactiveAt: null }, { where: { ...owner, permissionId } }, logParams, tx);
      }
      for (const permissionId of revoke) {
        const row = await (tx as any)[model].findFirst({ where: { ...owner, permissionId, inactiveAt: null }, select: { id: true } });
        if (row) await this.prisma.erase(model as any, { where: { id: row.id } }, logParams, true, tx);
      }
    });

    if (target.profileId) await this.authCache.smartInvalidate({ profileId: target.profileId });
    else await this.authCache.invalidateUserCache(Number(target.userId));
    return { granted: grant.length, revoked: revoke.length };
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
