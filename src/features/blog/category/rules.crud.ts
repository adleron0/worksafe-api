import { EntityRules } from '@adleron/crud-core';

import { syncActiveFlag } from 'src/common/crud/hooks';

export const blogCategoryEntity: EntityRules = {
  entity: 'categories', // prefixo 'blog' no módulo → /blog/categories
  model: 'Blog_Category',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore', 'listPublic'],
  restorePermission: 'own',
  permissions: {
    list: 'list_blog', getById: 'list_blog', create: 'create_blog',
    update: 'update_blog', archive: 'inactive_blog', restore: 'activate_blog',
  },
  // O site (worksafe-site) escolhe a empresa pelo domínio: company.lp_domain.
  filterable: ['company.lp_domain', 'name', 'slug', 'order', 'createdAt'],
  sortable: ['id', 'name', 'order', 'createdAt'],
  includable: ['_count'],
  includes: { _count: { select: { posts: true } } },
  neverWritable: ['active'],
  softDelete: { field: 'inactiveAt' },
  hooks: syncActiveFlag,
};
