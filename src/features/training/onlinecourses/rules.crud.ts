import { EntityRules, composeHooks } from '@adleron/crud-core';
import { syncFlag } from 'src/common/crud/hooks';

export const onlineCourseModelEntity: EntityRules = {
  entity: 'online-courses', model: 'OnlineCourseModel',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_treinamentos', getById: 'list_treinamentos', create: 'create_treinamentos',
    update: 'update_treinamentos', archive: 'inactive_treinamentos', restore: 'activate_treinamentos' },
  filterable: ['name', 'courseId', 'createdAt'], sortable: ['id', 'name', 'createdAt'], includable: ['course', 'lessons', '_count'], includes: { lessons: { include: { lesson: true }, orderBy: { order: 'asc' } } },
  neverWritable: ['isActive'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncFlag('isActive'), {}),
};
