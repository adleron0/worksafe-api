import { EntityRules, composeHooks } from '@adleron/crud-core';
import { parseJsonFields, syncActiveFlag } from 'src/common/crud/hooks';

export const certificateTemplateEntity: EntityRules = {
  entity: 'certificate', model: 'CouseCertificate',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_certificados', getById: 'list_certificados', create: 'create_certificados',
    update: 'update_certificados', archive: 'inactive_certificados', restore: 'activate_certificados' },
  filterable: ['name', 'courseId', 'createdAt'], sortable: ['id', 'name', 'createdAt'],
  includable: ['course'], includes: { course: { select: { id: true, name: true } } },
  neverWritable: ['active'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, parseJsonFields('fabricJsonFront', 'fabricJsonBack')),
};
