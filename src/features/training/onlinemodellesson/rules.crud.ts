import { EntityRules, composeHooks } from '@adleron/crud-core';
import { syncFlag } from 'src/common/crud/hooks';

export const onlineModelLessonEntity: EntityRules = {
  entity: 'online-course-lesson', model: 'OnlineModelLesson',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_treinamentos', getById: 'list_treinamentos', create: 'create_treinamentos',
    update: 'update_treinamentos', archive: 'inactive_treinamentos', restore: 'activate_treinamentos' },
  filterable: ['modelId', 'lessonId', 'order', 'isActive', 'createdAt'], sortable: ['id', 'order', 'createdAt'],
  includable: ['model', 'lesson'], includes: { lesson: true, model: { select: { id: true, name: true } } },
  softDelete: { field: 'inactiveAt' },
  // isActive é gravável aqui (o upsert antigo o usava para ligar/desligar a lição no modelo).
  hooks: composeHooks(syncFlag('isActive'), {
    preWrite: ({ op, data }) => {
      if (op !== 'update' && op !== 'create') return undefined;
      if (data.isActive === false || data.isActive === 'false') return { ...data, isActive: false, inactiveAt: new Date() };
      if (data.isActive === true || data.isActive === 'true') return { ...data, isActive: true, inactiveAt: null };
      return undefined;
    },
  }),
};
