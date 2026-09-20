import { CrudError, EntityRules, composeHooks } from '@adleron/crud-core';
import { Request } from 'express';
import { normalizeDateOnly } from 'src/common/crud/hooks';
import { PrismaService } from 'src/prisma/prisma.service';

/** Quota da turma e criação/vínculo do aluno ao confirmar — regras do rules.ts antigo, agora hooks. */
async function ensureQuota(prisma: PrismaService, companyId: number, classId: number) {
  const limit = await prisma.courseClass.findFirst({ where: { companyId, id: classId },
    select: { unlimitedSubscriptions: true, maxSubscriptions: true, name: true } });
  if (limit && !limit.unlimitedSubscriptions) {
    const total = await prisma.courseClassSubscription.count({ where: { companyId, classId, subscribeStatus: 'confirmed' } });
    if (total >= Number(limit.maxSubscriptions)) {
      throw new CrudError('CONFLICT', `O limite de inscrições para a turma ${limit.name} foi atingido`, 'classId');
    }
  }
}
async function linkTrainee(prisma: PrismaService, data: Record<string, any>, current: Record<string, any> | undefined, actor: { userId: unknown; companyId: unknown }) {
  const cpf = data.cpf || current?.cpf;
  const trainee = await prisma.selectOrCreate('trainee', { cpf }, {
    name: data.name || current?.name, cpf, email: data.email || current?.email, phone: data.phone || current?.phone,
    custumerId: data.customerId || current?.customerId, occupation: data.occupation || current?.occupation,
  }, actor);
  return { ...data, traineeId: trainee.data.id, confirmedAt: data.confirmedAt || current?.confirmedAt || new Date() };
}
async function assertCanLeaveConfirmed(prisma: PrismaService, current: Record<string, any>) {
  if (current.subscribeStatus !== 'confirmed' || !current.traineeId) return;
  const where = { traineeId: current.traineeId, classId: current.classId, inactiveAt: null };
  if (await prisma.traineeCourseCertificate.findFirst({ where, select: { id: true } }))
    throw new CrudError('CONFLICT', 'Não é possível alterar o status desta inscrição pois o aluno já possui certificado emitido', 'subscribeStatus');
  if (await prisma.courseClassAttendanceList.findFirst({ where, select: { id: true } }))
    throw new CrudError('CONFLICT', 'Não é possível alterar o status desta inscrição pois o aluno já possui presença registrada', 'subscribeStatus');
  if (await prisma.courseClassExam.findFirst({ where, select: { id: true } }))
    throw new CrudError('CONFLICT', 'Não é possível alterar o status desta inscrição pois o aluno já realizou exame', 'subscribeStatus');
}

export const subscriptionEntity: EntityRules = {
  entity: 'subscription', model: 'CourseClassSubscription',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_classes', getById: 'list_classes', create: 'create_classes',
    update: 'update_classes', archive: 'inactive_classes', restore: 'activate_classes' },
  filterable: ['name', 'cpf', 'email', 'classId', 'traineeId', 'subscribeStatus', 'confirmedAt', 'createdAt', 'class.name', 'trainee.name'],
  sortable: ['id', 'name', 'createdAt', 'confirmedAt'],
  includable: ['class', 'trainee', 'financialRecords'],
  includes: { class: { select: { id: true, name: true, initialDate: true, finalDate: true } }, trainee: { select: { id: true, name: true, cpf: true } } },
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks<Request>(normalizeDateOnly('confirmedAt'), {
    preWrite: async ({ op, data, existing, scopeId, deps, context }) => {
      const prisma = deps.prisma as PrismaService;
      const actor = { userId: Number(context.user?.sub ?? 0), companyId: Number(scopeId) };
      let patched: Record<string, any> = { ...data };
      if (patched.traineeId === 'null') patched.traineeId = null;
      if (op === 'create') {
        await ensureQuota(prisma, Number(scopeId), Number(patched.classId));
        if (patched.subscribeStatus === 'confirmed') patched = await linkTrainee(prisma, patched, undefined, actor);
      }
      if (op === 'update' && existing) {
        if (patched.subscribeStatus && patched.subscribeStatus !== 'confirmed') await assertCanLeaveConfirmed(prisma, existing);
        if (patched.subscribeStatus === 'confirmed') patched = await linkTrainee(prisma, patched, existing, actor);
        // recusada → sai da listagem de ativos; qualquer outro status volta
        if (patched.subscribeStatus === 'declined') patched.inactiveAt = new Date();
        else if (patched.subscribeStatus) patched.inactiveAt = null;
      }
      return patched;
    },
  }),
};
