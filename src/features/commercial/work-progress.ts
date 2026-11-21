import { Prisma } from '@prisma/client';

/**
 * Avanço físico da obra de um contrato de serviço (plano 12): o mesmo número
 * das estatísticas do RDO (último % de cada etapa do cronograma da OS, pesado
 * pela duração), mas só com os RDOs **fechados**. Serve de referência para as
 * parcelas "ao atingir X% da obra": nunca fatura nem trava nada sozinho.
 */

type Db = Pick<Prisma.TransactionClient, 'service_Order' | 'service_DailyReport'>;
interface ScheduleShape { unit?: string; steps?: Array<{ title?: string; duration?: number }> }
interface StepProgress { step: number; percent: number }

export interface WorkProgress {
  /** % atual (0–100) ou null quando a OS não tem cronograma/RDO fechado */
  percent: number | null;
  /** data do último RDO fechado */
  date: string | null;
  /** primeiro dia em que o avanço chegou a cada marco pedido */
  reachedAt: Map<number, string>;
  /** início e fim previstos da obra (para estimar a data dos marcos) */
  start: string | null; end: string | null;
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const EMPTY = (): WorkProgress => ({ percent: null, date: null, reachedAt: new Map(), start: null, end: null });

/** Avanço da obra de vários contratos de uma vez (uma consulta de OS e uma de RDO). */
export async function workProgressOf(db: Db, contractIds: number[], marks: Map<number, number[]> = new Map()): Promise<Map<number, WorkProgress>> {
  const out = new Map<number, WorkProgress>();
  if (!contractIds.length) return out;
  const orders = await db.service_Order.findMany({
    where: { contractId: { in: contractIds } },
    select: { id: true, contractId: true, schedule: true, plannedStart: true, plannedEnd: true, startedAt: true, finishedAt: true },
  });
  const reports = orders.length ? await db.service_DailyReport.findMany({
    where: { orderId: { in: orders.map((o) => o.id) }, status: 'fechado', inactiveAt: null },
    orderBy: [{ date: 'asc' }, { id: 'asc' }], select: { orderId: true, date: true, progress: true },
  }) : [];
  for (const order of orders) {
    if (!order.contractId) continue;
    const progress = EMPTY();
    progress.start = iso(order.startedAt) ?? iso(order.plannedStart);
    progress.end = iso(order.finishedAt) ?? iso(order.plannedEnd);
    const durations = ((order.schedule as ScheduleShape | null)?.steps ?? []).map((step) => Math.max(1, Number(step.duration) || 1));
    const weight = durations.reduce((sum, d) => sum + d, 0);
    const wanted = [...(marks.get(order.contractId) ?? [])].sort((a, b) => a - b);
    const last = new Map<number, number>();
    for (const report of reports.filter((r) => r.orderId === order.id)) {
      for (const item of (report.progress as unknown as StepProgress[]) ?? []) last.set(item.step, Number(item.percent) || 0);
      if (!weight) continue;
      const done = round2(durations.reduce((sum, d, step) => sum + d * Math.min(100, last.get(step) ?? 0), 0) / weight);
      progress.percent = done;
      progress.date = iso(report.date);
      for (const mark of wanted) if (done + 1e-6 >= mark && !progress.reachedAt.has(mark)) progress.reachedAt.set(mark, iso(report.date)!);
    }
    out.set(order.contractId, progress);
  }
  for (const id of contractIds) if (!out.has(id)) out.set(id, EMPTY());
  return out;
}

/** Data estimada de um marco: linear pelo prazo da obra (início + % × duração). */
export function expectedDateOf(progress: WorkProgress, mark: number): string | null {
  if (!progress.start || !progress.end || progress.end < progress.start) return null;
  const start = new Date(`${progress.start}T00:00:00Z`).getTime();
  const end = new Date(`${progress.end}T00:00:00Z`).getTime();
  return new Date(start + ((end - start) * Math.min(100, Math.max(0, mark))) / 100).toISOString().slice(0, 10);
}

/** Situação de uma parcela por % da obra, em relação ao avanço atual. */
export function workStateOf(progress: WorkProgress | undefined, mark: number) {
  const p = progress ?? EMPTY();
  const reached = p.percent !== null && p.percent + 1e-6 >= mark;
  return {
    workPercent: mark, workProgress: p.percent, workProgressDate: p.date, reached,
    reachedAt: p.reachedAt.get(mark) ?? null, expectedDate: reached ? null : expectedDateOf(p, mark),
  };
}
