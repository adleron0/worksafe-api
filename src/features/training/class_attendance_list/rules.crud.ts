import { EntityRules } from '@adleron/crud-core';

export const attendanceEntity: EntityRules = {
  entity: 'attendance-list', model: 'CourseClassAttendanceList',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_classes', getById: 'list_classes', create: 'create_classes',
    update: 'update_classes', archive: 'inactive_classes', restore: 'activate_classes' },
  filterable: ['classId', 'traineeId', 'day', 'IsPresent', 'createdAt'], sortable: ['id', 'day', 'createdAt'],
  includable: ['trainee', 'class'], softDelete: { field: 'inactiveAt' },
};
