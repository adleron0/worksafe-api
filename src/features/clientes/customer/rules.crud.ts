import { CrudError, EntityRules } from '@adleron/crud-core';

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

  hooks: {
    /**
     * `active` (boolean) e `inactiveAt` (data) coexistem no schema. O
     * `changeStatus` do generic mantinha os dois em sincronia; aqui isso vira
     * regra explícita da entidade, e não comportamento escondido no núcleo.
     */
    preWrite: ({ op, data }) => {
      if (op === 'archive') return { ...data, active: false };
      if (op === 'restore') return { ...data, active: true };
      return undefined;
    },
  },
};

/**
 * Duplicidade de CNPJ por empresa tem constraint no banco
 * (`@@unique([cnpj, companyId])`), então o P2002 já vira 409 pelo adapter.
 * Este helper só existe para a mensagem de domínio, quando for preciso.
 */
export function duplicateCustomerError(): CrudError {
  return new CrudError('CONFLICT', 'Cliente já cadastrado para esta empresa', 'cnpj');
}
