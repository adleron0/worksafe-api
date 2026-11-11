import { EntityRules } from '@adleron/crud-core';

/**
 * Cargos (DOM_Roles) — tabela de domínio GLOBAL: não tem companyId, então o
 * núcleo não aplica escopo. Hoje o GET está com a permissão comentada no
 * controller; aqui é obrigatória.
 */
export const rolesEntity: EntityRules = {
  entity: 'roles',
  model: 'DOM_Roles',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  // Listagem aberta a qualquer autenticado (dropdown do cadastro de cliente),
  // como no controller antigo. As permissões de escrita (*_domRoles) não existem
  // na tabela Permission — ninguém escrevia antes, ninguém escreve agora.
  authenticatedOps: ['list', 'getById'],
  restorePermission: 'own',
  permissions: {
    create: 'create_domRoles',
    update: 'update_domRoles',
    archive: 'inactive_domRoles',
    restore: 'activate_domRoles',
  },
  filterable: ['name', 'createdAt'],
  sortable: ['id', 'name', 'createdAt'],
  softDelete: { field: 'inactiveAt' },
};
