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
  filterable: ['name', 'featured', 'price', 'category', 'brand', 'createdAt'],
  sortable: ['id', 'name', 'price', 'createdAt'],
  includable: ['images'],
  includes: {
    images: { select: { id: true, imageUrl: true, name: true }, where: { active: true } },
  },
  neverWritable: ['active'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, imageUpload(), {
    // Preço vazio vira 0 (comportamento do controller antigo).
    // Categoria/marca: texto livre aparado; vazio vira null (some do filtro).
    preWrite: ({ op, data }) => {
      const tidy = (v: unknown) =>
        typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') || null : v;
      const next = { ...data };
      if ('category' in next) next.category = tidy(next.category);
      if ('brand' in next) next.brand = tidy(next.brand);
      return op === 'create'
        ? { ...next, price: next.price || 0, oldPrice: next.oldPrice || 0 }
        : next;
    },
  }),
};
