import { CrudError, EntityRules } from '@adleron/crud-core';
import { Request } from 'express';
import { studentScope } from 'src/common/crud/student-scope';
import { PrismaService } from 'src/prisma/prisma.service';

/** Inscrições do aluno logado (escopo traineeId). POST = matrícula em turma online. */
export const studentCoursesEntity: EntityRules = {
  entity: 'student-courses', model: 'CourseClassSubscription',
  expose: ['list', 'getById', 'create', 'update'],
  authenticatedOps: ['list', 'getById', 'create', 'update'],
  permissions: {},
  scope: studentScope('traineeId') as never,
  filterable: ['classId', 'subscribeStatus', 'createdAt', 'class.name'], sortable: ['id', 'createdAt'],
  includable: ['class', 'trainee'],
  includes: {
    class: { include: { onlineCourseModel: { include: { course: { select: { id: true, name: true, description: true } },
      lessons: { include: { lesson: { select: { id: true, title: true, description: true } } }, orderBy: { order: 'asc' } } } }, company: true } },
    trainee: { select: { id: true, name: true, email: true, cpf: true } },
  },
  neverWritable: ['companyId', 'subscribeStatus', 'confirmedAt', 'name', 'cpf', 'email', 'classId'],
  softDelete: { field: 'inactiveAt' },
  hooks: {
    preList: () => ({ kind: 'cmp', path: ['subscribeStatus'], operator: 'ne', value: 'declined' }),
    preWrite: async ({ op, context, scopeId, deps }) => {
      if (op !== 'create') return undefined;
      const prisma = deps.prisma as PrismaService;
      const body = (context as Request).body as Record<string, unknown>;
      const classId = Number(body.courseClassId);
      const traineeId = Number(scopeId);
      if (!classId) throw new CrudError('VALIDATION_FAILED', 'courseClassId é obrigatório', 'courseClassId');

      const courseClass = await prisma.courseClass.findUnique({ where: { id: classId } });
      if (!courseClass) throw new CrudError('NOT_FOUND', 'Turma não encontrada');
      if (!courseClass.active) throw new CrudError('CONFLICT', 'Turma inativa');
      const now = new Date();
      if (courseClass.periodSubscriptionsType === 'LIMITED') {
        if (courseClass.periodSubscriptionsInitialDate && now < courseClass.periodSubscriptionsInitialDate)
          throw new CrudError('CONFLICT', 'Período de inscrição ainda não iniciado');
        if (courseClass.periodSubscriptionsFinalDate && now > courseClass.periodSubscriptionsFinalDate)
          throw new CrudError('CONFLICT', 'Período de inscrição encerrado');
      }
      if (courseClass.periodClass === 'LIMITED' && courseClass.finalDate && now > courseClass.finalDate)
        throw new CrudError('CONFLICT', 'Turma já encerrada');

      const enrolled = await prisma.courseClassSubscription.count({ where: { classId, subscribeStatus: { not: 'declined' } } });
      if (!courseClass.unlimitedSubscriptions && enrolled >= (courseClass.maxSubscriptions || 50))
        throw new CrudError('CONFLICT', 'Turma sem vagas disponíveis');

      const existing = await prisma.courseClassSubscription.findFirst({ where: { traineeId, classId } });
      if (existing) {
        throw new CrudError('CONFLICT', existing.subscribeStatus !== 'declined'
          ? 'Você já está inscrito nesta turma' : 'Você já possui uma inscrição cancelada nesta turma');
      }
      const trainee = await prisma.trainee.findUnique({ where: { id: traineeId } });
      if (!trainee) throw new CrudError('NOT_FOUND', 'Aluno não encontrado');

      // Dados vêm do cadastro do aluno, nunca do corpo.
      return {
        traineeId, classId, companyId: courseClass.companyId,
        name: trainee.name, cpf: trainee.cpf, email: trainee.email ?? '', phone: trainee.phone || '',
        subscribeStatus: 'confirmed', confirmedAt: new Date(),
      };
    },
  },
};
