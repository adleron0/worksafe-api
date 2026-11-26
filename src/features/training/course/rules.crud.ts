import { ENTITY_SELECT, entityHook } from 'src/features/company-entity/entity.field';
import { EntityRules, composeHooks } from '@adleron/crud-core';
import { imageUpload, parseJsonFields, slugField, syncActiveFlag } from 'src/common/crud/hooks';

export const courseEntity: EntityRules = {
  entity: 'courses', model: 'Course',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_treinamentos', getById: 'list_treinamentos', create: 'create_treinamentos',
    update: 'update_treinamentos', archive: 'inactive_treinamentos', restore: 'activate_treinamentos' },
  filterable: ['name', 'weekly', 'createdAt', 'entityId'], sortable: ['id', 'name', 'createdAt'],
  includable: ['certificates', 'classes', '_count', 'entity'],
  includes: { entity: ENTITY_SELECT },
  neverWritable: ['active'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, imageUpload(), parseJsonFields('faq', 'exam'), slugField(), entityHook, {
    // o curso mudou de CNPJ: as turmas que seguiam o curso vão junto (as que tinham outro CNPJ escolhido ficam)
    postWrite: async ({ op, result, existing, deps }: any) => {
      if (op !== 'update' || !existing || !result?.entityId || existing.entityId === result.entityId) return;
      await deps.prisma.courseClass.updateMany({ where: { courseId: Number(result.id), entityId: existing.entityId ?? null }, data: { entityId: result.entityId } });
    },
  }),
};
