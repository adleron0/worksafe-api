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
import { SellerAccountService } from 'src/payments/application/seller-account.service';
import { PrismaService } from 'src/prisma/prisma.service';

const SELLER_REQUIRED = ['email', 'cpf', 'phone', 'name'] as const;

/**
 * Ativação de seller: abre a subconta no gateway da empresa e grava
 * `sellerConfig`. O provisionamento (e a mesclagem por gateway/ambiente) é do
 * SellerAccountService — esta entidade não conhece fornecedor.
 */
const sellerActivation: EntityHooks<Request> = {
  preWrite: async ({ op, data, existing, scopeId, deps }) => {
    if (data.isSeller !== true && data.isSeller !== 'true') return undefined;
    if (op !== 'create' && op !== 'update' && op !== 'updateSelf') return undefined;

    const sellerAccounts = deps.sellerAccounts as SellerAccountService;
    const merged = { ...(existing ?? {}), ...data } as Record<string, any>;
    const companyId = Number(scopeId ?? merged.companyId);
    if (await sellerAccounts.hasAccountForCurrentEnvironment(companyId, existing?.sellerConfig)) {
      return { ...data, isSeller: true };
    }

    // Mesma regra de antes: sem os dados obrigatórios, falha antes do gateway.
    const missing = SELLER_REQUIRED.filter((field) => !merged[field]);
    if (missing.length) {
      throw new CrudError('VALIDATION_FAILED', `Dados insuficientes para seller: ${missing.join(', ')}`, missing[0]);
    }

    const { sellerConfig } = await sellerAccounts.provision(
      {
        id: Number(existing?.id ?? 0),
        name: merged.name, cpf: merged.cpf, email: merged.email, phone: merged.phone,
        birthDate: merged.birthDate, address: merged.address, addressNumber: merged.addressNumber,
        addressComplement: merged.addressComplement, neighborhood: merged.neighborhood,
        city: merged.city, state: merged.state, zipCode: merged.zipCode,
        companyId,
        sellerConfig: data.sellerConfig,
      },
      existing?.sellerConfig,
    );
    return {
      ...data,
      isSeller: true,
      sellerStatus: 'ACTIVE',
      ...(existing?.sellerActivatedAt ? {} : { sellerActivatedAt: new Date() }),
      sellerConfig,
    };
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
    sellerActivation,
    invalidateAuthCache,
  ),
};

export type UserPrisma = PrismaService;
