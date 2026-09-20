import { EntityRules, composeHooks } from '@adleron/crud-core';

import { imageUpload, syncActiveFlag } from 'src/common/crud/hooks';

/**
 * Serviços do site — listagem pública (vitrine), escrita com permissão.
 * Cache de 48h na listagem e evicção nas escritas ficam no módulo, como
 * decorators por op.
 */
export const siteServicesEntity: EntityRules = {
  entity: 'site-services',
  model: 'Site_Services',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  publicOps: ['list', 'getById'],
  restorePermission: 'own',
  permissions: {
    create: 'create_servicos_site',
    update: 'update_servicos_site',
    archive: 'inactive_servicos_site',
    restore: 'activate_servicos_site',
  },
  filterable: ['name', 'createdAt'],
  sortable: ['id', 'name', 'createdAt'],
  neverWritable: ['active'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, imageUpload()),
};
