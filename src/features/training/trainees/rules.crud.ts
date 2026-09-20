import { EntityRules } from '@adleron/crud-core';

/**
 * Alunos: não têm companyId direto — o vínculo é TraineeCompany. O escopo
 * vira um filtro de relação (`traineeCompany some companyId = empresa do ator`),
 * exatamente o que o GET antigo fazia à mão via `traineeCompany.companyId`.
 */
export const traineeEntity: EntityRules = {
  entity: 'trainee', model: 'Trainee',
  expose: ['list', 'getById'],
  permissions: { list: 'list_classes', getById: 'list_classes' },
  filterable: ['name', 'cpf', 'email', 'phone', 'customerId', 'createdAt', 'traineeCompany.companyId'],
  sortable: ['id', 'name', 'createdAt'],
  includable: ['traineeCompany', 'customer', 'city', 'state'],
  includes: { traineeCompany: { select: { companyId: true } } },
  maskedFields: ['password'],
  softDelete: { field: 'inactiveAt' },
  hooks: {
    preList: ({ scopeId }) => scopeId === undefined ? undefined : {
      kind: 'relation', path: ['traineeCompany'], quantifier: 'some',
      node: { kind: 'cmp', path: ['traineeCompany', 'companyId'], operator: 'eq', value: Number(scopeId) },
    },
  },
};
