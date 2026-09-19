import { EntityRules, composeHooks } from '@adleron/crud-core';

import { imageUpload, syncActiveFlag } from 'src/common/crud/hooks';

/** Produtos do site — vitrine pública com cache; imagens via relação `images`. */
export const siteProductsEntity: EntityRules = {
  entity: 'site-products',
  model: 'Site_Products',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  publicOps: ['list', 'getById'],
  restorePermission: 'own',
  permissions: {
    list: 'list_loja_site',
    getById: 'list_loja_site',
    create: 'create_loja_site',
    update: 'update_loja_site',
    archive: 'inactive_loja_site',
    restore: 'activate_loja_site',
  },
  filterable: ['name', 'featured', 'price', 'createdAt'],
  sortable: ['id', 'name', 'price', 'createdAt'],
  includable: ['images'],
  includes: {
    images: { select: { id: true, imageUrl: true, name: true }, where: { active: true } },
  },
  neverWritable: ['active'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, imageUpload(), {
    // Preço vazio vira 0 (comportamento do controller antigo).
    preWrite: ({ op, data }) =>
      op === 'create'
        ? { ...data, price: data.price || 0, oldPrice: data.oldPrice || 0 }
        : undefined,
  }),
};
