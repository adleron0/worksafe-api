import { EntityRules } from '@adleron/crud-core';

export const blogVisitorEntity: EntityRules = {
  entity: 'visitors',
  model: 'Blog_Visitor',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  restorePermission: 'own',
  permissions: {
    list: 'list_blog', getById: 'list_blog', create: 'create_blog',
    update: 'update_blog', archive: 'inactive_blog', restore: 'activate_blog',
  },
  filterable: ['name', 'email', 'blocked', 'userId', 'createdAt'],
  sortable: ['id', 'name', 'email', 'createdAt'],
  includable: ['user', '_count'],
  includes: {
    user: { select: { id: true, name: true, email: true, imageUrl: true } },
    _count: { select: { comments: true } },
  },
  softDelete: { field: 'inactiveAt' },
};
