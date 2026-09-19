import { CrudError, EntityRules } from '@adleron/crud-core';
import { Request } from 'express';

import { AuthCacheService } from 'src/common/cache/auth-cache.service';

export const profileEntity: EntityRules = {
  entity: 'profiles',
  model: 'Profile',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  restorePermission: 'own',
  permissions: {
    list: 'list_profile', getById: 'list_profile', create: 'create_profile',
    update: 'update_profile', archive: 'inactive_profile', restore: 'activate_profile',
  },
  filterable: ['name', 'createdAt'],
  sortable: ['id', 'name', 'createdAt'],
  includable: ['permissions', '_count'],
  includes: {
    permissions: { include: { permission: true }, where: { inactiveAt: null } },
    _count: { select: { users: true } },
  },
  softDelete: { field: 'inactiveAt' },
  hooks: {
    // Quem não é super não vê nem cria o perfil "super".
    preList: ({ context }) =>
      (context as Request).user?.profile === 'super'
        ? undefined
        : { kind: 'cmp', path: ['name'], operator: 'ne', value: 'super' },
    preWrite: ({ op, data }) => {
      if (op === 'create' && String(data.name ?? '').toLowerCase() === 'super') {
        throw new CrudError('VALIDATION_FAILED', 'Não é possível criar um perfil com o nome de Super', 'name');
      }
      return undefined;
    },
    // Permissões de perfil vivem no cache de auth de cada usuário do perfil.
    postWrite: async ({ result, deps }) => {
      await (deps.authCache as AuthCacheService).smartInvalidate({ profileId: Number(result.id) });
    },
  },
};
