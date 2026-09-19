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
import { AsaasService } from 'src/common/gateways/asaas/asaas.service';
import { PrismaService } from 'src/prisma/prisma.service';

const SELLER_REQUIRED = ['email', 'cpf', 'phone', 'name'] as const;

/**
 * Ativação de seller: cria a subconta no Asaas e grava `sellerConfig`. Era
 * `new AsaasService(...)` dentro do rules.ts; agora vem por `deps.asaas`.
 * Mesma regra de antes: sem dados obrigatórios, falha antes de chamar o gateway.
 */
const sellerActivation: EntityHooks<Request> = {
  preWrite: async ({ op, data, existing, scopeId, deps }) => {
    if (data.isSeller !== true && data.isSeller !== 'true') return undefined;
    if (op !== 'create' && op !== 'update' && op !== 'updateSelf') return undefined;

    const asaas = deps.asaas as AsaasService;
    const merged = { ...(existing ?? {}), ...data } as Record<string, unknown>;
    const environment = process.env.BASE_SETUP === 'development' ? 'sandbox' : 'production';
    const hasWallet = (merged.sellerConfig as any)?.gateways?.asaas?.[environment]?.walletId;
    if (existing?.isSeller && hasWallet) return { ...data, isSeller: true };

    const missing = SELLER_REQUIRED.filter((field) => !merged[field]);
    if (missing.length) {
      throw new CrudError('VALIDATION_FAILED', `Dados insuficientes para seller: ${missing.join(', ')}`, missing[0]);
    }

    const result = await asaas.getOrCreateSubAccount({
      id: Number(existing?.id ?? 0),
      name: String(merged.name), cpf: String(merged.cpf), email: String(merged.email), phone: String(merged.phone),
      birthDate: merged.birthDate as string | undefined,
      address: merged.address as string, addressNumber: merged.addressNumber as string,
      addressComplement: merged.addressComplement as string, neighborhood: merged.neighborhood as string,
      city: merged.city as string, state: merged.state as string, zipCode: merged.zipCode as string,
      companyId: Number(scopeId ?? merged.companyId ?? 1),
      sellerConfig: merged.sellerConfig,
    });

    const current = (existing?.sellerConfig as Record<string, any>) ?? {};
    const incoming = (data.sellerConfig as Record<string, any>) ?? {};
    return {
      ...data,
      isSeller: true,
      sellerStatus: 'ACTIVE',
      ...(existing?.sellerActivatedAt ? {} : { sellerActivatedAt: new Date() }),
      sellerConfig: {
        ...current, ...incoming,
        gateways: {
          ...current.gateways, ...incoming.gateways,
          asaas: { ...current.gateways?.asaas, ...incoming.gateways?.asaas, [result.environment]: result.config },
        },
        [existing ? 'updatedAt' : 'createdAt']: new Date().toISOString(),
      },
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
