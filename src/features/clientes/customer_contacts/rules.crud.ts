import { EntityRules } from '@adleron/crud-core';

export const customerContactsEntity: EntityRules = {
  entity: 'customer-contacts',
  model: 'Customer_Contacts',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  restorePermission: 'own',
  permissions: {
    list: 'list_clientes', getById: 'list_clientes', create: 'create_clientes',
    update: 'update_clientes', archive: 'inactive_clientes', restore: 'activate_clientes',
  },
  filterable: ['name', 'email', 'phone', 'customerId', 'roleId', 'createdAt', 'customer.name', 'role.name'],
  sortable: ['id', 'name', 'createdAt'],
  includable: ['customer', 'role'],
  includes: { customer: { select: { id: true, name: true } }, role: { select: { id: true, name: true } } },
  softDelete: { field: 'inactiveAt' },
};
