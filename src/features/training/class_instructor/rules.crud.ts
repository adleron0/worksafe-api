import { EntityRules } from '@adleron/crud-core';
import { syncActiveFlag } from 'src/common/crud/hooks';

export const classInstructorEntity: EntityRules = {
  entity: 'class-instructors', model: 'CourseClassInstructor',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_classes', getById: 'list_classes', create: 'create_classes',
    update: 'update_classes', archive: 'inactive_classes', restore: 'activate_classes' },
  filterable: ['classId', 'instructorId', 'createdAt'], sortable: ['id', 'createdAt'],
  includable: ['instructor', 'class'], neverWritable: ['active'], softDelete: { field: 'inactiveAt' },
  hooks: syncActiveFlag,
};
