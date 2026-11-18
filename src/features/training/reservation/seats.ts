import { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Vagas de uma turma, contando as reservas de empresa.
 *
 * Uma reserva ocupa o MAIOR entre as vagas reservadas e as inscrições já
 * ligadas a ela (a empresa pode estar sem nomes ainda, ou ter recebido vaga
 * extra). Inscrição confirmada sem reserva ocupa uma vaga, como sempre.
 *
 * É a única conta de vagas: o site, a inscrição pelo sistema, a reserva, a
 * listagem de turmas e os painéis usam esta função.
 */
export interface ClassSeats {
  /** null = sem limite */
  max: number | null;
  /** inscrições confirmadas (todas, com ou sem reserva) */
  confirmed: number;
  /** vagas das reservas ainda sem nome */
  reservedOpen: number;
  /** vagas reservadas (soma das reservas ativas) */
  reserved: number;
  /** ocupadas = confirmadas sem reserva + Σ max(vagas, alunos) das reservas */
  occupied: number;
  /** null = sem limite */
  free: number | null;
}

export async function seatsOfClasses(db: Db, classIds: number[]): Promise<Map<number, ClassSeats>> {
  const ids = [...new Set(classIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, ClassSeats>();
  if (!ids.length) return out;
  const [classes, confirmedRows, reservations] = await Promise.all([
    db.courseClass.findMany({ where: { id: { in: ids } }, select: { id: true, maxSubscriptions: true, unlimitedSubscriptions: true } }),
    db.courseClassSubscription.groupBy({
      by: ['classId', 'reservationId'],
      where: { classId: { in: ids }, subscribeStatus: 'confirmed', inactiveAt: null },
      _count: { _all: true },
    }),
    db.courseClassReservation.findMany({ where: { classId: { in: ids }, inactiveAt: null }, select: { id: true, classId: true, seats: true } }),
  ]);
  for (const c of classes) {
    const active = reservations.filter((r) => r.classId === c.id);
    const activeIds = new Set(active.map((r) => r.id));
    const rows = confirmedRows.filter((r) => r.classId === c.id);
    const confirmed = rows.reduce((n, r) => n + r._count._all, 0);
    // inscrição de reserva cancelada conta como avulsa
    const loose = rows.filter((r) => r.reservationId === null || !activeIds.has(r.reservationId)).reduce((n, r) => n + r._count._all, 0);
    let reservedOccupied = 0;
    let reservedOpen = 0;
    let reserved = 0;
    for (const r of active) {
      const used = rows.find((row) => row.reservationId === r.id)?._count._all ?? 0;
      reserved += r.seats;
      reservedOccupied += Math.max(r.seats, used);
      reservedOpen += Math.max(0, r.seats - used);
    }
    const max = c.unlimitedSubscriptions || !c.maxSubscriptions ? null : c.maxSubscriptions;
    const occupied = loose + reservedOccupied;
    out.set(c.id, { max, confirmed, reservedOpen, reserved, occupied, free: max === null ? null : Math.max(0, max - occupied) });
  }
  return out;
}

export async function seatsOfClass(db: Db, classId: number): Promise<ClassSeats | null> {
  return (await seatsOfClasses(db, [classId])).get(classId) ?? null;
}

/** Trava curta por turma (dentro de uma transação): reserva e inscrição não disputam a última vaga. */
export async function lockClassSeats(tx: Prisma.TransactionClient, classId: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(740211::int, ${classId}::int)`;
}
