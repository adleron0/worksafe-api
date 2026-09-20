import { EntityRules } from '@adleron/crud-core';

/** Splits de comissão. Sem inactiveAt no schema → sem archive/restore. */
export const splitEntity: EntityRules = {
  entity: 'splits-transactions', model: 'SplitTransaction',
  expose: ['list', 'getById', 'create', 'update'],
  permissions: { list: 'list_financeiro', getById: 'list_financeiro', create: 'create_financeiro', update: 'update_financeiro' },
  filterable: ['financialRecordId', 'sellerId', 'status', 'hasDivergence', 'processedAt', 'settledAt', 'createdAt', 'seller.name'],
  sortable: ['id', 'createdAt', 'settledAt', 'splitValue'],
  includable: ['financialRecord', 'seller'],
  includes: { seller: { select: { id: true, name: true } }, financialRecord: { select: { id: true, value: true, status: true, paymentMethod: true } } },
  aggregatable: ['status', 'splitValue', 'netValue'],
  neverWritable: ['asaasSplitId', 'asaasTransferId', 'gatewayResponse'],
  statusUpdatable: true,
  hooks: { preWrite: ({ op, data }) => op === 'update' && data.hasDivergence === undefined ? { ...data, hasDivergence: false } : undefined },
};
