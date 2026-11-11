import { EntityRules, composeHooks } from '@adleron/crud-core';
import { imageUpload, parseJsonFields, syncActiveFlag } from 'src/common/crud/hooks';
import { ClassGatewayValidator } from 'src/payments/application/class-gateway-validator.service';

const pick = (data: Record<string, any>, existing: Record<string, any> | undefined, field: string) =>
  field in data ? data[field] : existing?.[field];

/**
 * Valida a configuração de pagamento contra o provedor da turma no ESTADO
 * FINAL (existing + data): um update parcial pode trocar só o provedor e
 * deixar métodos incompatíveis já salvos. Erro aparece para quem monta a
 * turma, não para o comprador na hora de pagar.
 */
const gatewayCompatibility = {
  preWrite: async ({ op, data, existing, scopeId, deps }: any) => {
    if (op !== 'create' && op !== 'update') return undefined;
    await (deps.classGatewayValidator as ClassGatewayValidator).validate({
      companyGatewayId: pick(data, existing, 'companyGatewayId'),
      companyId: Number(scopeId),
      allowCheckout: pick(data, existing, 'allowCheckout'),
      paymentMethods: pick(data, existing, 'paymentMethods'),
      dividedIn: pick(data, existing, 'dividedIn'),
    });
    return undefined;
  },
};

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
  // O site (worksafe-site) escolhe a empresa pelo domínio: company.lp_domain.
  filterable: ['id', 'company.lp_domain', 'name', 'courseId', 'customerId', 'certificateId', 'classCode', 'openClass', 'periodClass', 'initialDate', 'finalDate',
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
  }, gatewayCompatibility),
};
