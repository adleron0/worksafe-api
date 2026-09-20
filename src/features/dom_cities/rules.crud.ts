import { EntityRules } from '@adleron/crud-core';

/** Cidades — tabela de domínio global, leitura pública, filtrável por estado. */
export const citiesEntity: EntityRules = {
  entity: 'cities',
  model: 'DOM_Cities',
  expose: ['list', 'getById'],
  publicOps: ['list', 'getById'],
  permissions: {},
  filterable: ['name', 'stateId', 'state.uf'],
  sortable: ['id', 'name'],
  includable: ['state'],
  softDelete: { field: 'inactiveAt' },
};
