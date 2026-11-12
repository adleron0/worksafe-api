import { CrudError, EntityRules, composeHooks } from '@adleron/crud-core';

import { syncActiveFlag } from 'src/common/crud/hooks';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Categorias e marcas da loja (Site → Categorias da Loja / Marcas). Mesmas
 * permissões dos produtos do site (`*_loja_site`): é quem cuida da loja.
 * O nome é único por empresa, sem diferenciar maiúsculas/acentos de espaço.
 */
const taxonomy = (entity: string, model: 'Site_ProductCategory' | 'Site_ProductBrand', label: string): EntityRules => ({
  entity,
  model,
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  restorePermission: 'own',
  permissions: {
    list: 'list_loja_site', getById: 'list_loja_site', create: 'create_loja_site',
    update: 'update_loja_site', archive: 'inactive_loja_site', restore: 'activate_loja_site',
  },
  filterable: ['name', 'createdAt'],
  sortable: ['id', 'name', 'order', 'createdAt'],
  includable: ['_count'],
  includes: { _count: { select: { products: true } } },
  neverWritable: ['active'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, {
    preWrite: async ({ data, scopeId, existing, deps }) => {
      if (typeof data.name !== 'string') return undefined;
      const name = data.name.trim().replace(/\s+/g, ' ');
      if (name.length < 2) throw new CrudError('VALIDATION_FAILED', `Nome da ${label} muito curto`, 'name');
      const prisma = deps.prisma as PrismaService;
      const delegate = (prisma as any)[model.charAt(0).toLowerCase() + model.slice(1)];
      const dup = await delegate.findFirst({
        where: {
          companyId: Number(scopeId),
          name: { equals: name, mode: 'insensitive' },
          ...(existing ? { NOT: { id: existing.id } } : {}),
        },
        select: { id: true },
      });
      if (dup) throw new CrudError('CONFLICT', `Já existe uma ${label} com esse nome`, 'name');
      return { ...data, name };
    },
  }),
});

export const siteProductCategoryEntity = taxonomy('site-product-categories', 'Site_ProductCategory', 'categoria');
export const siteProductBrandEntity = taxonomy('site-product-brands', 'Site_ProductBrand', 'marca');
