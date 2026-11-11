import { EntityRules } from '@adleron/crud-core';

export const blogTagEntity: EntityRules = {
  entity: 'tags', // prefixo 'blog' no módulo → /blog/tags
  model: 'Blog_Tag',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore', 'listPublic'],
  restorePermission: 'own',
  permissions: {
    list: 'list_blog', getById: 'list_blog', create: 'create_blog',
    update: 'update_blog', archive: 'inactive_blog', restore: 'activate_blog',
  },
  // O site (worksafe-site) escolhe a empresa pelo domínio: company.lp_domain.
  filterable: ['company.lp_domain', 'name', 'slug', 'createdAt'],
  sortable: ['id', 'name', 'createdAt'],
  includable: ['_count'],
  includes: { _count: { select: { posts: true } } },
  softDelete: { field: 'inactiveAt' },
};
