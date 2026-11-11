import { EntityRules, composeHooks } from '@adleron/crud-core';
import { imageUpload, parseJsonFields } from 'src/common/crud/hooks';

/**
 * Certificados emitidos. `/public` (vitrine) força consentimento + vivos —
 * antes era um controller inteiro; agora `listPublic` + hook. O admin vê o
 * que está no escopo da empresa (antes noCompany=true listava tudo).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  neverWritable: ['key'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(imageUpload('pdfUrl'), parseJsonFields('variableToReplace', 'fabricJsonFront', 'fabricJsonBack'), {
    // Sem login há dois usos:
    // - verificação por código (link/QR do certificado, /certificados/<key>):
    //   quem tem o UUID exato vê o certificado, autorizado ou não — é a prova
    //   de autenticidade que o aluno entrega a quem quiser;
    // - vitrine (lista do site): só quem autorizou exibição.
    // O desenho (fabricJson*) vai na resposta: sem ele a página não renderiza.
    preList: ({ context }) => {
      const req = context as { user?: unknown; query?: Record<string, unknown> };
      if (req.user) return undefined;
      if (typeof req.query?.key === 'string' && UUID.test(req.query.key)) return undefined;
      return { kind: 'cmp', path: ['showOnWebsiteConsent'], operator: 'eq', value: true };
    },
  }),
};
