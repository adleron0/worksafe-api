import { EntityRules, composeHooks } from '@adleron/crud-core';

import { fileUpload, syncActiveFlag } from 'src/common/crud/hooks';

export const instructorEntity: EntityRules = {
  entity: 'instructors',
  model: 'Instructor',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  restorePermission: 'own',
  permissions: {
    list: 'list_instrutores',
    getById: 'list_instrutores',
    create: 'create_instrutores',
    update: 'update_instrutores',
    archive: 'inactive_instrutores',
    restore: 'activate_instrutores',
  },
  filterable: ['name', 'email', 'cpf', 'formation', 'createdAt'],
  sortable: ['id', 'name', 'createdAt'],
  includable: ['classes'],
  neverWritable: ['active'],
  softDelete: { field: 'inactiveAt' },
  // `signature` chega pela rota custom PUT /:id/signature (signature.controller.ts).
  hooks: composeHooks(syncActiveFlag, fileUpload({ image: 'imageUrl', signature: 'signatureUrl' })),
};
