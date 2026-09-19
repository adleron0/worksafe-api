import { EntityRules } from '@adleron/crud-core';

import { imageUpload } from 'src/common/crud/hooks';

/**
 * Galeria de imagens: hoje as rotas rodam sem permissão nenhuma (só
 * autenticadas) — mantido via authenticatedOps, agora explícito. Sem
 * arquivamento no schema: a exclusão é a rota custom DELETE.
 */
export const imageEntity: EntityRules = {
  entity: 'images',
  model: 'Image',
  expose: ['list', 'getById', 'create'],
  authenticatedOps: ['list', 'getById', 'create'],
  permissions: {},
  filterable: ['name', 'type', 'mimeType', 'createdAt'],
  sortable: ['id', 'name', 'createdAt'],
  neverWritable: ['width', 'height', 'fileSize', 'mimeType'],
  hooks: imageUpload(),
};
