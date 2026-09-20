import { EntityRules, composeHooks } from '@adleron/crud-core';
import { imageUpload, parseJsonFields, syncActiveFlag } from 'src/common/crud/hooks';

/**
 * Turmas. A listagem é pública (site) — o admin usa a mesma rota autenticado,
 * agora escopado pela empresa (antes noCompany=true listava tudo para todos).
 * O include de `course` omite o gabarito (`exam`).
 */
export const classEntity: EntityRules = {
  entity: 'classes', model: 'CourseClass',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  publicOps: ['list', 'getById'], restorePermission: 'own',
  permissions: { create: 'create_classes', update: 'update_classes', archive: 'inactive_classes', restore: 'activate_classes', },
  filterable: ['name', 'courseId', 'customerId', 'certificateId', 'classCode', 'openClass', 'periodClass', 'initialDate', 'finalDate',
    'allowSubscriptions', 'allowCheckout', 'hasOnlineCourse', 'onlineCourseModelId', 'createdAt', 'course.name'],
  sortable: ['id', 'name', 'initialDate', 'finalDate', 'price', 'createdAt'],
  includable: ['instructors', 'course', 'certificate', 'customer', 'onlineCourseModel', '_count'],
  includes: {
    instructors: { include: { instructor: { select: { id: true, name: true, imageUrl: true, active: true, curriculum: true, highlight: true, formation: true, formationCode: true } } } },
    course: { omit: { exam: true }, include: { reviews: {
      select: { generalRating: true, opinionRating: true, authorizationExposeReview: true,
        trainee: { select: { name: true, occupation: true, customer: { select: { name: true } } } } },
      take: 5, orderBy: { generalRating: 'desc' }, where: { authorizationExposeReview: true, inactiveAt: null } } } },
    _count: { select: { subscriptions: { where: { subscribeStatus: 'confirmed' } } } },
  },
  neverWritable: ['active'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, imageUpload(), parseJsonFields('faq', 'whyUs'), {
    preWrite: ({ op, data }) => op === 'update'
      ? { ...data, ...('price' in data && !data.price ? { price: null } : {}), ...('discountPrice' in data && !data.discountPrice ? { discountPrice: null } : {}) }
      : undefined,
  }),
};
