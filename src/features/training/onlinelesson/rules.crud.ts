import { EntityRules, composeHooks } from '@adleron/crud-core';
import { parseJsonFields, syncFlag } from 'src/common/crud/hooks';

export const onlineLessonEntity: EntityRules = {
  entity: 'online-lesson', model: 'OnlineLesson',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_treinamentos', getById: 'list_treinamentos', create: 'create_treinamentos',
    update: 'update_treinamentos', archive: 'inactive_treinamentos', restore: 'activate_treinamentos' },
  filterable: ['title', 'courseId', 'version', 'createdAt'], sortable: ['id', 'title', 'createdAt'], includable: ['steps', 'modelLessons', 'course'], includes: { steps: true, modelLessons: { include: { model: { include: { course: true } } } }, course: { select: { id: true, name: true } } },
  neverWritable: ['isActive'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncFlag('isActive'), parseJsonFields('progressConfig')),
};
