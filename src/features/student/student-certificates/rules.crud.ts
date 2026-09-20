import { EntityRules } from '@adleron/crud-core';
import { studentScope } from 'src/common/crud/student-scope';

/** Certificados do aluno logado — só os vivos. */
export const studentCertificatesEntity: EntityRules = {
  entity: 'student-certificates', model: 'TraineeCourseCertificate',
  expose: ['list', 'getById'], authenticatedOps: ['list', 'getById'], permissions: {},
  scope: studentScope('traineeId') as never,
  filterable: ['courseId', 'classId', 'expirationDate', 'createdAt'], sortable: ['id', 'createdAt'],
  includable: ['course', 'class', 'company', 'trainee'],
  includes: {
    course: { select: { id: true, name: true, icon: true, color: true } },
    class: { select: { id: true, name: true, initialDate: true, finalDate: true } },
    company: { select: { comercial_name: true, logoUrl: true } },
    trainee: { select: { id: true, name: true } },
  },
  softDelete: { field: 'inactiveAt' },
  hooks: { preList: () => ({ kind: 'cmp', path: ['inactiveAt'], operator: 'isNull', value: null }) },
};
