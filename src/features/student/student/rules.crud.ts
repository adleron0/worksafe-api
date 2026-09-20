import { EntityRules, composeHooks } from '@adleron/crud-core';
import { hashPassword, imageUpload, normalizeDateOnly } from 'src/common/crud/hooks';
import { studentScope } from 'src/common/crud/student-scope';

/**
 * O próprio aluno (Trainee), escopado pela PK = traineeId do token: GET lista
 * só ele, PUT /:id só o dele. Antes o PUT aceitava qualquer id (com password
 * no DTO — takeover de conta de qualquer aluno).
 */
export const studentEntity: EntityRules = {
  entity: 'student', model: 'Trainee',
  expose: ['list', 'getById', 'update'],
  authenticatedOps: ['list', 'getById', 'update'],
  permissions: {},
  scope: studentScope('id') as never,
  filterable: ['name', 'cpf', 'email'], sortable: ['id', 'name'],
  includable: ['city', 'state', 'customer'],
  maskedFields: ['password'],
  neverWritable: ['customerId', 'active', 'cpf'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(imageUpload(), normalizeDateOnly('birthDate'), hashPassword),
};
