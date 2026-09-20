import { EntityRules } from '@adleron/crud-core';

export const reviewEntity: EntityRules = {
  entity: 'reviews', model: 'CourseReview',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_classes', getById: 'list_classes', create: 'create_classes',
    update: 'update_classes', archive: 'inactive_classes', restore: 'activate_classes' },
  filterable: ['classId', 'courseId', 'traineeId', 'generalRating', 'authorizationExposeReview', 'createdAt', 'trainee.name'],
  sortable: ['id', 'generalRating', 'createdAt'],
  includable: ['trainee', 'course', 'class'],
  includes: { trainee: { select: { id: true, name: true, occupation: true } }, course: { select: { id: true, name: true } }, class: { select: { id: true, name: true } } },
  softDelete: { field: 'inactiveAt' },
};
