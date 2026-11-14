import { EntityHooks, EntityRules, composeHooks } from '@adleron/crud-core';
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
  maskedFields: ['password', 'sellerConfig'],
  neverWritable: ['active', 'searchName', 'sellerActivatedAt'],
  // Achado nº 1: PUT /user/self não muda papel, empresa nem status de seller.
  selfRestricted: ['profileId', 'sellerStatus', 'sellerConfig', 'isSeller'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks<Request>(
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
