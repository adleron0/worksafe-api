import { EntityRules, composeHooks } from '@adleron/crud-core';
import { parseJsonFields } from 'src/common/crud/hooks';

export const examEntity: EntityRules = {
  entity: 'exames', model: 'CourseClassExam',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_classes', getById: 'list_classes', create: 'create_classes',
    update: 'update_classes', archive: 'inactive_classes', restore: 'activate_classes' },
  filterable: ['traineeId', 'classId', 'courseId', 'result', 'createdAt', 'trainee.name'],
  sortable: ['id', 'createdAt'], includable: ['trainee', 'class', 'course'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(parseJsonFields('examResponses')),
};
