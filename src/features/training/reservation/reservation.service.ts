import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CacheService } from 'src/common/cache/cache.service';
import { isValidCPF } from 'src/validators/is-cpf.constraint';
import { examScoreOf } from '../classes/service';
import { ClassSeats, lockClassSeats, seatsOfClass, seatsOfClasses } from './seats';

/**
 * Vagas de turma aberta compradas por uma empresa.
 *
 * A reserva segura N vagas de uma turma aberta para um cliente (ligada a uma
 * venda, ou cortesia). Os alunos da empresa entram como inscrições já
 * confirmadas, com a empresa e a venda gravadas, SEM checkout e sem nenhuma
 * cobrança: quem cobra é a venda (parcelas do contrato). O certificado desses
 * alunos sai com a empresa contratante.
 */
type Tx = Prisma.TransactionClient;
type Body = Record<string, any>;
export interface ReservationActor { userId: number; companyId: number; permissions: string[] }

export const READ_PERMISSIONS = ['list_classes', 'list_comercial'];
export const WRITE_PERMISSIONS = ['update_classes', 'update_comercial'];
/** Aumentar o limite de vagas da turma é decisão de quem gerencia turmas. */
export const RAISE_LIMIT_PERMISSION = 'update_classes';

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
const blank = (value: unknown) => value === undefined || value === null || value === '';
const truthy = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';
const today = () => new Date().toISOString().slice(0, 10);

interface ClassSlot { courseId: number | null; description: string; quantity: number; students: number | null; classIds?: number[] }

export function requireAny(actor: ReservationActor, permissions: string[]) {
  if (!permissions.some((p) => actor.permissions.includes(p))) throw new ForbiddenException('Acesso negado: Permissões insuficientes');
}

const CLASS_SELECT = {
  id: true, name: true, courseId: true, customerId: true, initialDate: true, finalDate: true, inactiveAt: true,
  maxSubscriptions: true, unlimitedSubscriptions: true, classCode: true, city: true, state: true,
  course: { select: { id: true, name: true } },
} as const;
const CUSTOMER_SELECT = { id: true, name: true, corporateName: true, cnpj: true } as const;
const STUDENT_SELECT = { id: true, name: true, cpf: true, email: true, phone: true, occupation: true, traineeId: true, subscribeStatus: true, createdAt: true } as const;

@Injectable()
export class ReservationService {
  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService) {}

  // ------------------------------------------------------------------ leitura

  async list(actor: ReservationActor, query: Record<string, string>) {
    const where: Prisma.CourseClassReservationWhereInput = { companyId: actor.companyId };
    if (!truthy(query.includeCancelled)) where.inactiveAt = null;
    if (Number(query.id) > 0) where.id = Number(query.id);
    if (Number(query.classId) > 0) where.classId = Number(query.classId);
    if (Number(query.contractId) > 0) where.contractId = Number(query.contractId);
    if (Number(query.customerId) > 0) where.customerId = Number(query.customerId);
    const rows = await this.prisma.courseClassReservation.findMany({
      where, orderBy: [{ inactiveAt: 'desc' }, { id: 'asc' }],
      include: {
        class: { select: CLASS_SELECT }, customer: { select: CUSTOMER_SELECT },
        subscriptions: { where: { inactiveAt: null, subscribeStatus: 'confirmed' }, select: STUDENT_SELECT, orderBy: { name: 'asc' } },
      },
    });
    const [seats, contracts] = await Promise.all([
      seatsOfClasses(this.prisma, rows.map((r) => r.classId)),
      this.contractsOf(rows.map((r) => r.contractId)),
    ]);
    return rows.map((r) => this.present(r, seats.get(r.classId) ?? null, r.contractId ? contracts.get(r.contractId) ?? null : null));
  }

  async get(actor: ReservationActor, id: number) {
    const [row] = await this.list(actor, { includeCancelled: 'true', id: String(id) });
    if (!row) throw new NotFoundException('Reserva não encontrada');
    return row;
  }

  async availability(actor: ReservationActor, classId: number) {
    const klass = await this.prisma.courseClass.findFirst({ where: { id: classId, companyId: actor.companyId }, select: CLASS_SELECT });
    if (!klass) throw new NotFoundException('Turma não encontrada');
    return { class: klass, seats: await seatsOfClass(this.prisma, classId) };
  }

  /** Turmas abertas (sem cliente) do curso, ainda por acontecer, com as vagas livres. */
  async openClasses(actor: ReservationActor, query: Record<string, string>) {
    const courseId = Number(query.courseId);
    const classes = await this.prisma.courseClass.findMany({
      where: {
        companyId: actor.companyId, inactiveAt: null, customerId: null,
        ...(courseId > 0 ? { courseId } : {}),
        OR: [{ finalDate: null }, { finalDate: { gte: new Date(`${today()}T00:00:00.000Z`) } }],
      },
      orderBy: [{ initialDate: 'asc' }, { id: 'asc' }], take: 60, select: CLASS_SELECT,
    });
    const seats = await seatsOfClasses(this.prisma, classes.map((c) => c.id));
    return classes.map((c) => ({ ...c, seats: seats.get(c.id) ?? null }));
  }

  /** Itens de treinamento de uma venda com as reservas de cada um e quanto falta reservar. */
  async contractOptions(actor: ReservationActor, contractId: number) {
    const contract = await this.prisma.commercial_Contract.findFirst({
      where: { id: contractId, companyId: actor.companyId },
      select: { id: true, number: true, status: true, customerId: true, classes: true, customer: { select: CUSTOMER_SELECT } },
    });
    if (!contract) throw new NotFoundException('Venda não encontrada');
    const reservations = await this.list(actor, { contractId: String(contractId) });
    const slots = ((contract.classes as unknown as ClassSlot[]) ?? []).map((slot, index) => {
      const mine = reservations.filter((r) => r.contractSlotIndex === index);
      const sold = this.soldSeats(slot);
      const reserved = mine.reduce((n, r) => n + r.seats, 0);
      return {
        index, courseId: slot.courseId, description: slot.description, quantity: Number(slot.quantity), students: slot.students,
        sold, reserved, missing: Math.max(0, sold - reserved), closedClassIds: slot.classIds ?? [], reservations: mine,
      };
    });
    return {
      contract: { id: contract.id, number: contract.number, status: contract.status, customer: contract.customer },
      slots,
      // reservas da venda que não estão num item (ex.: item removido)
      others: reservations.filter((r) => r.contractSlotIndex === null || !slots.some((s) => s.index === r.contractSlotIndex)),
    };
  }

  /** Relatório para a empresa: alunos, presença por dia, prova e certificado. */
  async report(actor: ReservationActor, id: number) {
    const reservation = await this.byId(actor, id, true);
    const students = await this.prisma.courseClassSubscription.findMany({
      where: { reservationId: id, inactiveAt: null, subscribeStatus: 'confirmed' }, select: STUDENT_SELECT, orderBy: { name: 'asc' },
    });
    const traineeIds = students.map((s) => s.traineeId).filter((v): v is number => Boolean(v));
    const [attendance, exams, certificates] = await Promise.all([
      this.prisma.courseClassAttendanceList.findMany({ where: { classId: reservation.classId, traineeId: { in: traineeIds }, inactiveAt: null }, select: { traineeId: true, day: true, IsPresent: true } }),
      this.prisma.courseClassExam.findMany({ where: { classId: reservation.classId, traineeId: { in: traineeIds }, inactiveAt: null }, orderBy: { id: 'desc' }, select: { traineeId: true, result: true, examResponses: true } }),
      this.prisma.traineeCourseCertificate.findMany({ where: { classId: reservation.classId, traineeId: { in: traineeIds }, inactiveAt: null }, select: { traineeId: true, key: true, expirationDate: true } }),
    ]);
    const days = [...new Set(attendance.map((a) => a.day))].sort((a, b) => a - b);
    const full = await this.get(actor, id);
    return {
      reservation: full,
      days,
      students: students.map((s) => {
        const exam = exams.find((e) => e.traineeId === s.traineeId);
        const cert = certificates.find((c) => c.traineeId === s.traineeId);
        return {
          subscriptionId: s.id, name: s.name, cpf: s.cpf, traineeId: s.traineeId,
          attendance: days.map((day) => attendance.find((a) => a.traineeId === s.traineeId && a.day === day)?.IsPresent ?? null),
          exam: exam ? { passed: exam.result, score: examScoreOf(exam.examResponses) } : null,
          certificate: cert ? { key: cert.key, expirationDate: cert.expirationDate } : null,
        };
      }),
    };
  }

  // ------------------------------------------------------------------ escrita

  async create(actor: ReservationActor, body: Body) {
    const classId = Number(body.classId);
    const seats = this.seatsOf(body.seats);
    const raiseLimit = truthy(body.raiseLimit);
    if (raiseLimit) requireAny(actor, [RAISE_LIMIT_PERMISSION]);
    const klass = await this.prisma.courseClass.findFirst({ where: { id: classId, companyId: actor.companyId }, select: CLASS_SELECT });
    if (!klass) throw new NotFoundException('Turma não encontrada');
    if (klass.inactiveAt) throw new ConflictException('Turma cancelada: escolha outra');
    if (klass.customerId) throw new BadRequestException('Esta é uma turma fechada de um cliente: vagas avulsas só em turma aberta');

    let customerId = Number(body.customerId) || 0;
    let contractId: number | null = null;
    let slotIndex: number | null = null;
    if (!blank(body.contractId)) {
      const contract = await this.contractOf(actor, Number(body.contractId));
      contractId = contract.id;
      customerId = contract.customerId;
      if (!blank(body.contractSlotIndex)) {
        slotIndex = Number(body.contractSlotIndex);
        const slot = ((contract.classes as unknown as ClassSlot[]) ?? [])[slotIndex];
        if (!slot) throw new BadRequestException('Item de treinamento não encontrado na venda');
        if (slot.courseId && slot.courseId !== klass.courseId) throw new BadRequestException('A turma é de outro curso que o item da venda');
        await this.ensureSlotRoom(contract.id, slotIndex, slot, seats);
      }
    }
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, companyId: actor.companyId }, select: { id: true } });
    if (!customer) throw new BadRequestException('Escolha o cliente');

    const created = await this.prisma.$transaction(async (tx) => {
      await lockClassSeats(tx, classId);
      await this.ensureClassRoom(tx, classId, seats, raiseLimit);
      return tx.courseClassReservation.create({ data: {
        companyId: actor.companyId, classId, customerId, contractId, contractSlotIndex: slotIndex, seats,
        unitValue: this.moneyOf(body.unitValue), notes: clean(body.notes, 300) || null, userId: actor.userId || null,
      } });
    });
    await this.evict();
    return this.get(actor, created.id);
  }

  /** Muda vagas, valor ou observação. Menos vagas que alunos já inscritos não pode. */
  async update(actor: ReservationActor, id: number, body: Body) {
    const row = await this.byId(actor, id);
    const data: Prisma.CourseClassReservationUncheckedUpdateInput = {};
    if (body.notes !== undefined) data.notes = clean(body.notes, 300) || null;
    if (body.unitValue !== undefined) data.unitValue = this.moneyOf(body.unitValue);
    const raiseLimit = truthy(body.raiseLimit);
    if (raiseLimit) requireAny(actor, [RAISE_LIMIT_PERMISSION]);
    await this.prisma.$transaction(async (tx) => {
      if (body.seats !== undefined) {
        const seats = this.seatsOf(body.seats);
        const used = await tx.courseClassSubscription.count({ where: { reservationId: id, inactiveAt: null, subscribeStatus: 'confirmed' } });
        if (seats < used) throw new ConflictException(`A reserva já tem ${used} aluno(s): tire alunos antes de diminuir as vagas`);
        if (seats > row.seats) {
          if (row.contractId !== null && row.contractSlotIndex !== null) {
            const contract = await this.contractOf(actor, row.contractId);
            const slot = ((contract.classes as unknown as ClassSlot[]) ?? [])[row.contractSlotIndex];
            if (slot) await this.ensureSlotRoom(row.contractId, row.contractSlotIndex, slot, seats - row.seats);
          }
          await lockClassSeats(tx, row.classId);
          // as vagas que ela já ocupa voltam para a conta
          await this.ensureClassRoom(tx, row.classId, seats - Math.max(row.seats, used), raiseLimit);
        }
        data.seats = seats;
      }
      await tx.courseClassReservation.update({ where: { id }, data });
    });
    await this.evict();
    return this.get(actor, id);
  }

  /** Cancela a reserva (vagas voltam para o site). Só sem alunos: tire ou transfira antes. */
  async cancel(actor: ReservationActor, id: number, body: Body) {
    await this.byId(actor, id);
    const used = await this.prisma.courseClassSubscription.count({ where: { reservationId: id, inactiveAt: null, subscribeStatus: 'confirmed' } });
    if (used) throw new ConflictException(`A reserva tem ${used} aluno(s): tire os alunos ou transfira a reserva antes de cancelar`);
    await this.prisma.courseClassReservation.update({ where: { id }, data: { inactiveAt: new Date(), cancelReason: clean(body.reason, 300) || null } });
    await this.evict();
    return this.get(actor, id);
  }

  /**
   * Inscreve os alunos da empresa: inscrição já confirmada, sem checkout e sem
   * cobrança, com a empresa e a venda gravadas. Linha com problema não derruba
   * as outras: cada uma volta com o que aconteceu.
   */
  async addStudents(actor: ReservationActor, id: number, body: Body) {
    const reservation = await this.byId(actor, id);
    const input: Body[] = Array.isArray(body.students) ? body.students : [];
    if (!input.length) throw new BadRequestException('Informe ao menos um aluno (nome e CPF)');
    if (input.length > 200) throw new BadRequestException('No máximo 200 alunos por vez');
    const customer = await this.prisma.customer.findUnique({ where: { id: reservation.customerId }, select: { name: true } });

    const results = await this.prisma.$transaction(async (tx) => {
      await lockClassSeats(tx, reservation.classId);
      let used = await tx.courseClassSubscription.count({ where: { reservationId: id, inactiveAt: null, subscribeStatus: 'confirmed' } });
      const out: Array<{ name: string; cpf: string; status: 'inscrito' | 'convertido' | 'ja_estava' | 'erro'; message?: string; subscriptionId?: number }> = [];
      const seen = new Set<string>();
      for (const raw of input) {
        const name = clean(raw?.name, 100);
        const cpf = digits(raw?.cpf);
        const row = { name, cpf };
        if (!name) { out.push({ ...row, status: 'erro', message: 'Informe o nome' }); continue; }
        if (!isValidCPF(cpf)) { out.push({ ...row, status: 'erro', message: 'CPF inválido' }); continue; }
        if (seen.has(cpf)) { out.push({ ...row, status: 'erro', message: 'CPF repetido na lista' }); continue; }
        seen.add(cpf);

        const existing = await tx.courseClassSubscription.findFirst({
          where: { classId: reservation.classId, cpf, inactiveAt: null, subscribeStatus: { not: 'declined' } },
          include: { financialRecords: { select: { id: true, status: true } } },
        });
        if (existing?.reservationId === id) { out.push({ ...row, status: 'ja_estava', subscriptionId: existing.id }); continue; }
        if (existing?.subscribeStatus === 'confirmed') {
          out.push({ ...row, status: 'erro', message: existing.reservationId ? 'Já está inscrito por outra empresa nesta turma' : 'Já está inscrito pelo site nesta turma (vaga paga ou confirmada): resolva a vaga dele antes' });
          continue;
        }
        if (existing && existing.financialRecords.some((f) => !['cancelled', 'declined', 'chargeback'].includes(String(f.status)))) {
          out.push({ ...row, status: 'erro', message: 'Tem inscrição do site com cobrança em aberto: cancele a cobrança em Contas a Receber e tente de novo' });
          continue;
        }
        if (used >= reservation.seats) { out.push({ ...row, status: 'erro', message: `A reserva tem ${reservation.seats} vaga(s), todas com nome: aumente a reserva` }); continue; }

        const traineeId = await this.traineeOf(tx, actor.companyId, { name, cpf, email: clean(raw?.email, 100) || null, phone: clean(raw?.phone, 20) || null, occupation: clean(raw?.occupation, 255) || null });
        const data = {
          name, cpf, email: clean(raw?.email, 255) || existing?.email || '', phone: clean(raw?.phone, 255) || existing?.phone || '',
          occupation: clean(raw?.occupation, 255) || existing?.occupation || null,
          workedAt: customer?.name ?? null, customerId: reservation.customerId, contractId: reservation.contractId, reservationId: id,
          origin: reservation.contractId ? 'contrato' : 'cortesia', subscribeStatus: 'confirmed' as const, confirmedAt: new Date(), traineeId,
        };
        if (existing) {
          await tx.courseClassSubscription.update({ where: { id: existing.id }, data });
          out.push({ ...row, status: 'convertido', subscriptionId: existing.id, message: 'Inscrição do site (sem pagamento) passou para a empresa' });
        } else {
          const created = await tx.courseClassSubscription.create({ data: { ...data, classId: reservation.classId, companyId: actor.companyId } });
          out.push({ ...row, status: 'inscrito', subscriptionId: created.id });
        }
        used += 1;
      }
      return out;
    });
    await this.evict();
    return { results, reservation: await this.get(actor, id) };
  }

  /** Troca o aluno (a empresa mandou outra pessoa). Só antes de presença, prova ou certificado. */
  async swapStudent(actor: ReservationActor, id: number, subscriptionId: number, body: Body) {
    const reservation = await this.byId(actor, id);
    const sub = await this.studentOf(id, subscriptionId);
    await this.assertUntouched(sub, reservation.classId);
    const name = clean(body.name, 100);
    const cpf = digits(body.cpf);
    if (!name) throw new BadRequestException('Informe o nome');
    if (!isValidCPF(cpf)) throw new BadRequestException('CPF inválido');
    await this.prisma.$transaction(async (tx) => {
      const twin = await tx.courseClassSubscription.findFirst({ where: { classId: reservation.classId, cpf, inactiveAt: null, subscribeStatus: { not: 'declined' }, id: { not: sub.id } }, select: { id: true } });
      if (twin) throw new ConflictException('Este CPF já está inscrito nesta turma');
      const traineeId = await this.traineeOf(tx, actor.companyId, { name, cpf, email: clean(body.email, 100) || null, phone: clean(body.phone, 20) || null, occupation: clean(body.occupation, 255) || null });
      await tx.courseClassSubscription.update({ where: { id: sub.id }, data: {
        name, cpf, traineeId, email: clean(body.email, 255) || '', phone: clean(body.phone, 255) || '', occupation: clean(body.occupation, 255) || null,
      } });
    });
    await this.evict();
    return this.get(actor, id);
  }

  /** Tira o aluno da reserva (a vaga continua da empresa). Só antes de presença, prova ou certificado. */
  async removeStudent(actor: ReservationActor, id: number, subscriptionId: number) {
    const reservation = await this.byId(actor, id);
    const sub = await this.studentOf(id, subscriptionId);
    await this.assertUntouched(sub, reservation.classId);
    await this.prisma.courseClassSubscription.update({ where: { id: sub.id }, data: { subscribeStatus: 'declined', declinedReason: 'Retirado da reserva da empresa', inactiveAt: new Date() } });
    await this.evict();
    return this.get(actor, id);
  }

  /**
   * Leva a reserva (e os alunos) para outra turma aberta do mesmo curso — turma
   * cancelada ou que mudou para uma data que não serve. Aluno com presença,
   * prova ou certificado na turma atual não se move: aí recusa e diz quem.
   */
  async transfer(actor: ReservationActor, id: number, body: Body) {
    const reservation = await this.byId(actor, id);
    const targetId = Number(body.classId);
    if (targetId === reservation.classId) throw new BadRequestException('A reserva já está nesta turma');
    const raiseLimit = truthy(body.raiseLimit);
    if (raiseLimit) requireAny(actor, [RAISE_LIMIT_PERMISSION]);
    const [from, target] = await Promise.all([
      this.prisma.courseClass.findUnique({ where: { id: reservation.classId }, select: { courseId: true } }),
      this.prisma.courseClass.findFirst({ where: { id: targetId, companyId: actor.companyId }, select: CLASS_SELECT }),
    ]);
    if (!target || target.inactiveAt) throw new NotFoundException('Turma de destino não encontrada');
    if (target.customerId) throw new BadRequestException('A turma de destino é fechada de um cliente');
    if (from && target.courseId !== from.courseId) throw new BadRequestException('A turma de destino é de outro curso');
    const students = await this.prisma.courseClassSubscription.findMany({ where: { reservationId: id, inactiveAt: null, subscribeStatus: 'confirmed' }, select: STUDENT_SELECT });
    const stuck: string[] = [];
    for (const s of students) if (await this.touched(s, reservation.classId)) stuck.push(s.name);
    if (stuck.length) throw new ConflictException(`Já têm presença, prova ou certificado nesta turma: ${stuck.join(', ')}. Tire-os da transferência antes (ou mantenha a reserva aqui).`);
    const cpfs = students.map((s) => s.cpf);
    if (cpfs.length) {
      const twins = await this.prisma.courseClassSubscription.findMany({ where: { classId: targetId, cpf: { in: cpfs }, inactiveAt: null, subscribeStatus: { not: 'declined' } }, select: { name: true } });
      if (twins.length) throw new ConflictException(`Já inscritos na turma de destino: ${twins.map((t) => t.name).join(', ')}`);
    }
    await this.prisma.$transaction(async (tx) => {
      await lockClassSeats(tx, targetId);
      await this.ensureClassRoom(tx, targetId, Math.max(reservation.seats, students.length), raiseLimit);
      await tx.courseClassReservation.update({ where: { id }, data: { classId: targetId } });
      await tx.courseClassSubscription.updateMany({ where: { reservationId: id, inactiveAt: null, subscribeStatus: 'confirmed' }, data: { classId: targetId } });
    });
    await this.evict();
    return this.get(actor, id);
  }

  // ------------------------------------------------------------------ apoio

  private present(
    r: Prisma.CourseClassReservationGetPayload<{ include: { class: { select: typeof CLASS_SELECT }; customer: { select: typeof CUSTOMER_SELECT }; subscriptions: { select: typeof STUDENT_SELECT } } }>,
    seats: ClassSeats | null, contract: { id: number; number: string; status: string } | null,
  ) {
    const used = r.subscriptions.length;
    return {
      id: r.id, classId: r.classId, customerId: r.customerId, contractId: r.contractId, contractSlotIndex: r.contractSlotIndex,
      seats: r.seats, used, open: Math.max(0, r.seats - used), unitValue: r.unitValue === null ? null : Number(r.unitValue),
      notes: r.notes, cancelled: Boolean(r.inactiveAt), cancelReason: r.cancelReason, createdAt: r.createdAt, inactiveAt: r.inactiveAt,
      class: r.class, customer: r.customer, contract, classSeats: seats, students: r.subscriptions,
    };
  }

  private async contractsOf(ids: Array<number | null>) {
    const list = [...new Set(ids.filter((v): v is number => Boolean(v)))];
    if (!list.length) return new Map<number, { id: number; number: string; status: string }>();
    const rows = await this.prisma.commercial_Contract.findMany({ where: { id: { in: list } }, select: { id: true, number: true, status: true } });
    return new Map(rows.map((r) => [r.id, { ...r, status: String(r.status) }]));
  }

  private async byId(actor: ReservationActor, id: number, allowCancelled = false) {
    const row = await this.prisma.courseClassReservation.findFirst({ where: { id, companyId: actor.companyId } });
    if (!row) throw new NotFoundException('Reserva não encontrada');
    if (row.inactiveAt && !allowCancelled) throw new ConflictException('Reserva cancelada');
    return row;
  }

  private async contractOf(actor: ReservationActor, contractId: number) {
    const contract = await this.prisma.commercial_Contract.findFirst({ where: { id: contractId, companyId: actor.companyId, inactiveAt: null }, select: { id: true, status: true, customerId: true, classes: true } });
    if (!contract) throw new NotFoundException('Venda não encontrada');
    if (contract.status === 'cancelado') throw new ConflictException('Esta venda está cancelada');
    return contract;
  }

  /** Vagas vendidas num item de treinamento: o nº de alunos; sem ele, a quantidade. */
  private soldSeats(slot: ClassSlot) {
    return Math.max(1, Math.ceil(Number(slot.students ?? slot.quantity) || 1));
  }

  private async ensureSlotRoom(contractId: number, slotIndex: number, slot: ClassSlot, extra: number) {
    const sold = this.soldSeats(slot);
    const agg = await this.prisma.courseClassReservation.aggregate({ where: { contractId, contractSlotIndex: slotIndex, inactiveAt: null }, _sum: { seats: true } });
    const reserved = agg._sum.seats ?? 0;
    if (reserved + extra > sold) throw new ConflictException(`O item da venda tem ${sold} vaga(s) e ${reserved} já estão reservadas: sobram ${Math.max(0, sold - reserved)}`);
  }

  /** Cabe `extra` vagas na turma? Com `raiseLimit`, aumenta o limite da turma no que faltar. */
  private async ensureClassRoom(tx: Tx, classId: number, extra: number, raiseLimit: boolean) {
    if (extra <= 0) return;
    const seats = await seatsOfClass(tx, classId);
    if (!seats || seats.free === null || seats.free >= extra) return;
    if (!raiseLimit) {
      throw new ConflictException(`A turma tem ${seats.free} vaga(s) livre(s) e a reserva pede ${extra}. Escolha outra turma ou aumente o limite da turma.`);
    }
    await tx.courseClass.update({ where: { id: classId }, data: { maxSubscriptions: (seats.max ?? 0) + (extra - seats.free) } });
  }

  private seatsOf(value: unknown) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new BadRequestException('Vagas: informe um número inteiro de 1 a 500');
    return n;
  }

  private moneyOf(value: unknown) {
    if (blank(value)) return null;
    const n = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) throw new BadRequestException('Valor da vaga inválido');
    return Math.round(n * 100) / 100;
  }

  private async studentOf(reservationId: number, subscriptionId: number) {
    const sub = await this.prisma.courseClassSubscription.findFirst({ where: { id: subscriptionId, reservationId, inactiveAt: null }, select: STUDENT_SELECT });
    if (!sub) throw new NotFoundException('Aluno não encontrado nesta reserva');
    return sub;
  }

  private async touched(sub: { traineeId: number | null }, classId: number) {
    if (!sub.traineeId) return false;
    const where = { traineeId: sub.traineeId, classId, inactiveAt: null };
    const [cert, presence, exam] = await Promise.all([
      this.prisma.traineeCourseCertificate.findFirst({ where, select: { id: true } }),
      this.prisma.courseClassAttendanceList.findFirst({ where, select: { id: true } }),
      this.prisma.courseClassExam.findFirst({ where, select: { id: true } }),
    ]);
    return Boolean(cert || presence || exam);
  }

  private async assertUntouched(sub: { traineeId: number | null }, classId: number) {
    if (await this.touched(sub, classId)) throw new ConflictException('O aluno já tem presença, prova ou certificado nesta turma');
  }

  /** Aluno é um por CPF (o mesmo do site); liga à empresa-base como a inscrição do site faz. */
  private async traineeOf(tx: Tx, companyId: number, data: { name: string; cpf: string; email: string | null; phone: string | null; occupation: string | null }) {
    const found = await tx.trainee.findFirst({ where: { cpf: data.cpf }, select: { id: true } });
    const id = found?.id ?? (await tx.trainee.create({ data: { name: data.name, cpf: data.cpf, email: data.email, phone: data.phone, occupation: data.occupation } })).id;
    await tx.traineeCompany.upsert({ where: { traineeId_companyId: { traineeId: id, companyId } }, create: { traineeId: id, companyId }, update: {} });
    return id;
  }

  async evict() {
    await Promise.all(['training-classes:*', 'cache:*/classes*', 'subscription:*', 'cache:*/subscription*'].map((p) => this.cache.reset(p).catch(() => undefined)));
  }
}
