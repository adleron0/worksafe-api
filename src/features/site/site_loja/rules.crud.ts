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
    create: 'create_loja_site',
    update: 'update_loja_site',
    archive: 'inactive_loja_site',
    restore: 'activate_loja_site',
  },
  filterable: ['name', 'featured', 'price', 'categoryId', 'brandId', 'createdAt'],
  sortable: ['id', 'name', 'price', 'createdAt'],
  includable: ['images', 'category', 'brand'],
  includes: {
    images: { select: { id: true, imageUrl: true, name: true }, where: { active: true } },
    // inativas não aparecem: o produto fica "sem categoria/marca" na loja
    category: { select: { id: true, name: true, order: true, inactiveAt: true } },
    brand: { select: { id: true, name: true, order: true, inactiveAt: true } },
  },
  neverWritable: ['active'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, imageUpload(), {
    // Preço vazio vira 0 (comportamento do controller antigo).
    // Preço vazio vira 0 (comportamento do controller antigo). Categoria e
    // marca chegam como id; vazio (form) vira null = sem categoria/marca.
    preWrite: ({ op, data }) => {
      const next = { ...data };
      for (const key of ['categoryId', 'brandId'] as const) {
        if (key in next) next[key] = next[key] === '' || next[key] == null ? null : Number(next[key]);
      }
      return op === 'create'
        ? { ...next, price: next.price || 0, oldPrice: next.oldPrice || 0 }
        : next;
    },
  }),
};
