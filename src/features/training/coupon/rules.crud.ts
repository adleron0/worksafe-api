import { EntityRules, composeHooks } from '@adleron/crud-core';

import { syncActiveFlag } from 'src/common/crud/hooks';

const NULL_IF_EMPTY = ['usageLimit', 'minPurchaseValue', 'maxDiscountValue', 'commissionValue'];

export const couponEntity: EntityRules = {
  entity: 'coupon',
  model: 'Coupon',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  restorePermission: 'own',
  permissions: {
    list: 'list_cupoms',
    getById: 'list_cupoms',
    create: 'create_cupoms',
    update: 'update_cupoms',
    archive: 'inactive_cupoms',
    restore: 'activate_cupoms',
  },
  filterable: ['code', 'sellerId', 'classId', 'courseId', 'discountType', 'validUntil', 'createdAt'],
  sortable: ['id', 'code', 'createdAt', 'validUntil'],
  includable: ['seller', 'class', 'course', '_count'],
  includes: {
    seller: { select: { name: true } },
    class: { select: { name: true } },
    course: { select: { name: true } },
    _count: { select: { financialRecords: { where: { status: { in: ['waiting', 'received'] } } } } },
  },
  // usageCount é do servidor (contador); active só pelas rotas de arquivamento.
  neverWritable: ['active', 'usageCount'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, {
    // O form manda '' para numéricos não preenchidos; Decimal não aceita ''.
    preWrite: ({ data }) => {
      const patched = { ...data };
      for (const field of NULL_IF_EMPTY) {
        if (field in patched && !patched[field]) patched[field] = null;
      }
      if (patched.firstPurchaseOnly === undefined || patched.firstPurchaseOnly === '') {
        patched.firstPurchaseOnly = false;
      }
      return patched;
    },
  }),
};
