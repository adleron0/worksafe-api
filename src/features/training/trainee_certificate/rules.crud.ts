import { EntityRules, composeHooks } from '@adleron/crud-core';
import { imageUpload, parseJsonFields } from 'src/common/crud/hooks';

/**
 * Certificados emitidos. `/public` (vitrine) força consentimento + vivos —
 * antes era um controller inteiro; agora `listPublic` + hook. O admin vê o
 * que está no escopo da empresa (antes noCompany=true listava tudo).
 */
export const traineeCertificateEntity: EntityRules = {
  entity: 'trainee-certificate', model: 'TraineeCourseCertificate',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore', 'listPublic'], restorePermission: 'own',
  permissions: { list: 'list_classes', getById: 'list_classes', create: 'create_classes',
    update: 'update_classes', archive: 'inactive_classes', restore: 'activate_classes' },
  filterable: ['courseId', 'traineeId', 'classId', 'key', 'expirationDate', 'showOnWebsiteConsent', 'createdAt',
    'trainee.name', 'trainee.cpf', 'class.name', 'course.name'],
  sortable: ['id', 'createdAt', 'expirationDate'],
  includable: ['trainee', 'course', 'class', 'company'],
  includes: {
    trainee: { select: { id: true, name: true, imageUrl: true } },
    course: { select: { name: true, icon: true, color: true } },
    class: { select: { name: true, description: true, initialDate: true, finalDate: true } },
    company: { select: { cnpj: true, comercial_name: true, logoUrl: true, faviconUrl: true, websiteUrl: true } },
  },
  publicMaskedFields: ['fabricJsonFront', 'fabricJsonBack'],
  neverWritable: ['key'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(imageUpload('pdfUrl'), parseJsonFields('variableToReplace', 'fabricJsonFront', 'fabricJsonBack'), {
    // Vitrine: só quem autorizou exibição.
    preList: ({ context }) => (context as { user?: unknown }).user
      ? undefined
      : { kind: 'cmp', path: ['showOnWebsiteConsent'], operator: 'eq', value: true },
  }),
};
