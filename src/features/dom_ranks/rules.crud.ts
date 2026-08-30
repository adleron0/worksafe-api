import { EntityRules } from '@adleron/crud-core';

/**
 * Ranks — tabela de domínio por empresa.
 *
 * Muda um comportamento de propósito: hoje o `GET /ranks` está com a permissão
 * comentada no controller e usa `noCompany = true`, então qualquer usuário
 * autenticado lista os ranks de TODAS as empresas. Aqui a permissão é
 * obrigatória (a app não sobe sem ela) e o escopo é automático.
 */
export const ranksEntity: EntityRules = {
  entity: 'ranks',
  model: 'DOM_Ranks',

  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  restorePermission: 'own',
  permissions: {
    list: 'list_domRank',
    getById: 'list_domRank',
    create: 'create_domRank',
    update: 'update_domRank',
    archive: 'inactive_domRank',
    restore: 'activate_domRank',
  },

  filterable: ['name', 'createdAt'],
  sortable: ['id', 'name', 'createdAt'],
  softDelete: { field: 'inactiveAt' },
};
