import { EntityRules } from '@adleron/crud-core';

/** Estados — tabela de domínio global, leitura pública (formulários de aluno/cliente). */
export const statesEntity: EntityRules = {
  entity: 'states',
  model: 'DOM_States',
  expose: ['list', 'getById'],
  publicOps: ['list', 'getById'],
  permissions: {},
  filterable: ['name', 'uf'],
  sortable: ['id', 'name', 'uf'],
  softDelete: { field: 'inactiveAt' },
};
