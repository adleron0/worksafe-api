import { CrudError, EntityRules, composeHooks } from '@adleron/crud-core';
import { Request } from 'express';
import { normalizeDateOnly } from 'src/common/crud/hooks';
import { PrismaService } from 'src/prisma/prisma.service';
import { seatsOfClass } from '../reservation/seats';

/** Quota da turma e criação/vínculo do aluno ao confirmar — regras do rules.ts antigo, agora hooks. */
async function ensureQuota(prisma: PrismaService, companyId: number, classId: number, reservationId?: number | null) {
  const turma = await prisma.courseClass.findFirst({ where: { companyId, id: classId }, select: { name: true } });
  if (!turma) return;
  const seats = await seatsOfClass(prisma, classId);
  if (!seats || seats.max === null) return;
  // aluno de reserva com vaga sobrando na reserva não ocupa vaga nova
  if (reservationId) {
    const reservation = await prisma.courseClassReservation.findFirst({ where: { id: reservationId, classId, inactiveAt: null }, select: { seats: true } });
    const used = await prisma.courseClassSubscription.count({ where: { reservationId, subscribeStatus: 'confirmed', inactiveAt: null } });
    if (reservation && used < reservation.seats) return;
  }
  if (seats.free !== null && seats.free <= 0) {
    throw new CrudError('CONFLICT', `O limite de inscrições para a turma ${turma.name} foi atingido`, 'classId');
  }
}
/** Mesmo CPF duas vezes na mesma turma: o site já recusava, o sistema deixava passar. */
async function ensureSingleCpf(prisma: PrismaService, classId: number, cpf: unknown, exceptId?: number) {
  const digits = String(cpf ?? '').trim();
  if (!digits) return;
  const twin = await prisma.courseClassSubscription.findFirst({
    where: { classId, cpf: digits, inactiveAt: null, subscribeStatus: { not: 'declined' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (twin) throw new CrudError('CONFLICT', 'Este CPF já está inscrito nesta turma', 'cpf');
}
/** Reserva informada: tem de ser desta turma; a inscrição herda a empresa e a venda. */
async function applyReservation(prisma: PrismaService, data: Record<string, any>, classId: number) {
  const reservationId = Number(data.reservationId);
  if (!(reservationId > 0)) return data;
  const reservation = await prisma.courseClassReservation.findFirst({
    where: { id: reservationId, classId, inactiveAt: null },
    select: { id: true, customerId: true, contractId: true, customer: { select: { name: true } } },
  });
  if (!reservation) throw new CrudError('VALIDATION_FAILED', 'Reserva não encontrada nesta turma', 'reservationId');
  return {
    ...data, reservationId: reservation.id, customerId: reservation.customerId, contractId: reservation.contractId,
    origin: data.origin || (reservation.contractId ? 'contrato' : 'cortesia'),
    workedAt: data.workedAt || reservation.customer?.name || null,
  };
}
async function linkTrainee(prisma: PrismaService, data: Record<string, any>, current: Record<string, any> | undefined, actor: { userId: unknown; companyId: unknown }) {
  const cpf = data.cpf || current?.cpf;
  // O aluno é um só por CPF; a empresa fica na inscrição (customerId), não no
  // aluno — antes gravava "custumerId", campo que não existe.
  const trainee = await prisma.selectOrCreate('trainee', { cpf }, {
    name: data.name || current?.name, cpf, email: data.email || current?.email, phone: data.phone || current?.phone,
    occupation: data.occupation || current?.occupation,
  }, actor);
  // liga o aluno à empresa-base, como o site e a reserva fazem: sem isso ele não aparece em Alunos
  const companyId = Number(actor.companyId);
  if (companyId > 0) {
    await prisma.traineeCompany.upsert({ where: { traineeId_companyId: { traineeId: trainee.data.id, companyId } }, create: { traineeId: trainee.data.id, companyId }, update: {} });
  }
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
  filterable: ['name', 'cpf', 'email', 'classId', 'traineeId', 'subscribeStatus', 'confirmedAt', 'createdAt', 'class.name', 'trainee.name', 'customerId', 'contractId', 'reservationId', 'origin'],
  sortable: ['id', 'name', 'createdAt', 'confirmedAt'],
  includable: ['class', 'trainee', 'financialRecords', 'customer', 'reservation'],
  includes: { class: { select: { id: true, name: true, initialDate: true, finalDate: true } }, trainee: { select: { id: true, name: true, cpf: true } },
    customer: { select: { id: true, name: true, corporateName: true, cnpj: true } } },
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks<Request>(normalizeDateOnly('confirmedAt'), {
    preWrite: async ({ op, data, existing, scopeId, deps, context }) => {
      const prisma = deps.prisma as PrismaService;
      const actor = { userId: Number(context.user?.sub ?? 0), companyId: Number(scopeId) };
      let patched: Record<string, any> = { ...data };
      if (patched.traineeId === 'null') patched.traineeId = null;
      if (patched.customerId === 'null' || patched.customerId === '') patched.customerId = null;
      if (patched.customerId) {
        const customer = await prisma.customer.findFirst({ where: { id: Number(patched.customerId), companyId: Number(scopeId) }, select: { id: true } });
        if (!customer) throw new CrudError('VALIDATION_FAILED', 'Cliente não encontrado', 'customerId');
        patched.customerId = customer.id;
      }
      if (op === 'create') {
        const classId = Number(patched.classId);
        await ensureSingleCpf(prisma, classId, patched.cpf);
        patched = await applyReservation(prisma, patched, classId);
        await ensureQuota(prisma, Number(scopeId), classId, patched.reservationId);
        if (!patched.origin) patched.origin = 'sistema';
        if (patched.subscribeStatus === 'confirmed') patched = await linkTrainee(prisma, patched, undefined, actor);
      }
      if (op === 'update' && existing) {
        if (patched.cpf && patched.cpf !== existing.cpf) await ensureSingleCpf(prisma, Number(existing.classId), patched.cpf, Number(existing.id));
        // voltar a confirmar uma recusada ocupa vaga de novo
        if (patched.subscribeStatus === 'confirmed' && existing.subscribeStatus !== 'confirmed') {
          await ensureQuota(prisma, Number(scopeId), Number(existing.classId), existing.reservationId as number | null);
        }
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
