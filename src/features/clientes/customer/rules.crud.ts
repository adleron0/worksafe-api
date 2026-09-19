import { CrudError, EntityRules, composeHooks } from '@adleron/crud-core';

import { imageUpload, syncActiveFlag } from 'src/common/crud/hooks';

/**
 * Cliente — declaração completa da entidade. Substitui controller + service +
 * DTOs de whitelist: a allowlist de gravação é derivada do schema, e as rotas
 * saem do `expose`.
 */
export const customerEntity: EntityRules = {
  entity: 'customer',
  model: 'Customer',

  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  // O WorkSafe tem permissões separadas para ativar e inativar.
  restorePermission: 'own',
  permissions: {
    list: 'list_clientes',
    getById: 'list_clientes',
    create: 'create_clientes',
    update: 'update_clientes',
    archive: 'inactive_clientes',
    restore: 'activate_clientes',
  },

  filterable: [
    'name',
    'corporateName',
    'cnpj',
    'email',
    'phone',
    'rankId',
    'stateId',
    'cityId',
    'createdAt',
  ],
  sortable: ['id', 'name', 'corporateName', 'createdAt'],
  includable: ['rank', 'state', 'city', 'contacts'],
  aggregatable: ['rankId', 'stateId', 'cityId'],

  // `active` e `searchName` são do servidor: `active` só muda pelas rotas de
  // arquivamento (o UpdateDto antigo o aceitava no corpo) e `searchName` é
  // derivado. O formulário do front não envia nenhum dos dois.
  neverWritable: ['active', 'searchName'],
  softDelete: { field: 'inactiveAt' },

  // `active`+`inactiveAt` em sincronia e upload da imagem (FileInterceptor no módulo).
  hooks: composeHooks(syncActiveFlag, imageUpload()),
};

/**
 * Duplicidade de CNPJ por empresa tem constraint no banco
 * (`@@unique([cnpj, companyId])`), então o P2002 já vira 409 pelo adapter.
 * Este helper só existe para a mensagem de domínio, quando for preciso.
 */
export function duplicateCustomerError(): CrudError {
  return new CrudError('CONFLICT', 'Cliente já cadastrado para esta empresa', 'cnpj');
}
