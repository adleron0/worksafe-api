import { EntityRules, composeHooks } from '@adleron/crud-core';
import { imageUpload, parseJsonFields, slugField, syncActiveFlag } from 'src/common/crud/hooks';

export const courseEntity: EntityRules = {
  entity: 'courses', model: 'Course',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_treinamentos', getById: 'list_treinamentos', create: 'create_treinamentos',
    update: 'update_treinamentos', archive: 'inactive_treinamentos', restore: 'activate_treinamentos' },
  filterable: ['name', 'weekly', 'createdAt'], sortable: ['id', 'name', 'createdAt'],
  includable: ['certificates', 'classes', '_count'],
  neverWritable: ['active'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, imageUpload(), parseJsonFields('faq', 'exam'), slugField()),
};
