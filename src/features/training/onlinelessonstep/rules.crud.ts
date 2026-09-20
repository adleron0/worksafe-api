import { EntityRules, composeHooks } from '@adleron/crud-core';
import { parseJsonFields, syncFlag } from 'src/common/crud/hooks';

export const onlineLessonStepEntity: EntityRules = {
  entity: 'online-lesson-step', model: 'OnlineLessonStep',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_treinamentos', getById: 'list_treinamentos', create: 'create_treinamentos',
    update: 'update_treinamentos', archive: 'inactive_treinamentos', restore: 'activate_treinamentos' },
  filterable: ['title', 'lessonId', 'contentType', 'order', 'createdAt'], sortable: ['id', 'order', 'createdAt'], includable: ['lesson'], includes: {},
  neverWritable: ['isActive'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncFlag('isActive'), parseJsonFields('content')),
};
