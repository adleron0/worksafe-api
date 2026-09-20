import { EntityRules, composeHooks } from '@adleron/crud-core';
import { parseJsonFields } from 'src/common/crud/hooks';

export const financialRecordEntity: EntityRules = {
  entity: 'financial-records', model: 'FinancialRecords',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_financeiro', getById: 'list_financeiro', create: 'create_financeiro',
    update: 'update_financeiro', archive: 'inactive_financeiro', restore: 'activate_financeiro' },
  filterable: ['accrualDate', 'gateway', 'status', 'paymentMethod', 'subscriptionId', 'traineeId', 'customerId', 'sellerId', 'couponId',
    'dueDate', 'paidAt', 'externalId', 'createdAt', 'trainee.name', 'customer.name', 'seller.name'],
  sortable: ['id', 'dueDate', 'paidAt', 'value', 'createdAt'],
  includable: ['subscription', 'trainee', 'customer', 'seller', 'coupon', 'splitTransactions'],
  includes: { trainee: { select: { id: true, name: true, cpf: true } }, customer: { select: { id: true, name: true } },
    seller: { select: { id: true, name: true } }, coupon: { select: { id: true, code: true } } },
  aggregatable: ['status', 'value', 'paymentMethod', 'gateway'],
  // A key é o acesso público ao registro (GET /key/:key): nunca na listagem.
  maskedFields: ['key'],
  neverWritable: ['key', 'externalId', 'requestData', 'responseData', 'errorData'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(parseJsonFields()),
};
