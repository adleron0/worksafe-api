import { CrudError, EntityHooks, EntityRules, composeHooks } from '@adleron/crud-core';
import { Request } from 'express';

import { AuthCacheService } from 'src/common/cache/auth-cache.service';
import {
  hashPassword,
  imageUpload,
  normalizeDateOnly,
  parseJsonFields,
  syncActiveFlag,
} from 'src/common/crud/hooks';
import { SellerWalletService } from 'src/features/commercial/wallet.service';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Vendedor é só uma marcação no usuário, sem subconta em gateway. Marcar por aqui
 * (ou pela tela de Vendedores) cria a carteira de comissões; nada mais é exigido.
 */
const sellerWallet: EntityHooks<Request> = {
  postWrite: async ({ result, deps }) => {
    if (result?.isSeller !== true) return;
    await (deps.wallet as SellerWalletService).createWallet(Number(result.companyId), Number(result.id));
  },
};

/** Permissões/sessão vivem em cache: qualquer escrita no usuário invalida. */
const invalidateAuthCache: EntityHooks<Request> = {
  postWrite: async ({ result, deps }) => {
    await (deps.authCache as AuthCacheService).invalidateUserCache(Number(result.id));
  },
};

/**
 * Quem não é super não promove ninguém a super (nem a si mesmo) e não altera,
 * inativa ou reativa um usuário super. Antes, quem tinha `update_user` trocava
 * o perfil de qualquer um para super pelo PUT /user/:id.
 */
const protectSuper: EntityHooks<Request> = {
  preWrite: async ({ data, existing, context, repository }) => {
    if ((context as Request).user?.profile === 'super') return undefined;
    const profileName = async (id: unknown) => {
      if (id === undefined || id === null || id === '') return undefined;
      const row = await repository.findOne('profile', { kind: 'cmp', path: ['id'], operator: 'eq', value: Number(id) });
      return row?.name as string | undefined;
    };
    if (existing && (await profileName(existing.profileId)) === 'super') {
      throw new CrudError('FORBIDDEN', 'Só o super altera um usuário super');
    }
    if ('profileId' in data && (await profileName(data.profileId)) === 'super') {
      throw new CrudError('FORBIDDEN', 'Só o super pode dar o perfil super a alguém');
    }
    return undefined;
  },
};

/**
 * Quem entra pelo Google (da casa ou convidado) não troca o próprio e-mail nem
 * cria senha pelo "meu perfil": senão voltaria a entrar por senha, fora do
 * Google e do prazo do convite (achado da revisão do login Google).
 */
const protectGoogleIdentity: EntityHooks<Request> = {
  preWrite: async ({ op, data, existing }) => {
    if (op !== 'updateSelf' || !existing) return undefined;
    if (!existing.googleSub && !existing.externalUntil) return undefined;
    if ('email' in data || 'password' in data) {
      throw new CrudError('FORBIDDEN', 'Quem entra com o Google não troca e-mail nem senha por aqui.');
    }
    return undefined;
  },
};

export const userEntity: EntityRules = {
  entity: 'user',
  model: 'User',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore', 'getSelf', 'updateSelf'],
  restorePermission: 'own',
  permissions: {
    list: 'list_user', getById: 'list_user', create: 'create_user',
    update: 'update_user', archive: 'inactive_user', restore: 'activate_user',
  },
  filterable: ['name', 'email', 'cpf', 'phone', 'profileId', 'isSeller', 'sellerStatus', 'createdAt', 'profile.name'],
  sortable: ['id', 'name', 'email', 'createdAt'],
  includable: ['profile', 'permissions', 'company'],
  includes: {
    profile: { select: { name: true } },
    permissions: { include: { permission: true }, where: { inactiveAt: null } },
  },
  // Senha e config de gateway nunca saem na resposta (era omitAttributes).
  maskedFields: ['password', 'sellerConfig', 'googleSub'],
  // comissão própria do vendedor só pela rota da carteira (permissão da diretoria)
  // googleSub/externalUntil só pelo login Google e pelos convites
  neverWritable: ['active', 'searchName', 'sellerActivatedAt', 'commissionRate', 'commissionBase', 'googleSub', 'externalUntil'],
  // Achado nº 1: PUT /user/self não muda papel, empresa nem status de seller.
  selfRestricted: ['profileId', 'sellerStatus', 'sellerConfig', 'isSeller'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks<Request>(
    protectSuper,
    protectGoogleIdentity,
    syncActiveFlag,
    imageUpload(),
    parseJsonFields('bankAccount', 'sellerConfig'),
    normalizeDateOnly('birthDate'),
    hashPassword,
    sellerWallet,
    invalidateAuthCache,
  ),
};

export type UserPrisma = PrismaService;
