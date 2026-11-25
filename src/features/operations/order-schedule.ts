/**
 * Cronograma da OS em datas: a proposta combina "dia 3 a 7"; a obra precisa de
 * "25/11 a 29/11". Daqui saem as datas de cada etapa, o previsto de cada dia,
 * as etapas do dia (para o RDO e para a folha) e a projeção de término.
 *
 * Arquivo sem imports do Nest/Prisma de propósito: é testado sozinho.
 */
export interface ScheduleStep { title: string; start: number; duration: number; details?: string | null }
export interface Schedule { unit?: string; steps?: ScheduleStep[] }

export const UNIT_DAYS: Record<string, number> = { dia: 1, semana: 7, mes: 30 };
const DAY = 86400000;
export const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
export const isoOf = (value: Date) => value.toISOString().slice(0, 10);
export const addDays = (value: string, days: number) => isoOf(new Date(asDate(value).getTime() + days * DAY));
export const daysBetween = (from: string, to: string) => Math.round((asDate(to).getTime() - asDate(from).getTime()) / DAY);
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export const unitDaysOf = (schedule: Schedule | null | undefined) => UNIT_DAYS[schedule?.unit ?? 'dia'] ?? 1;

/** Etapas normalizadas, na ordem; `step` é o índice (é por ele que o RDO guarda o avanço). */
export function stepsOf(schedule: Schedule | null | undefined) {
  return (schedule?.steps ?? []).map((step, index) => ({
    step: index, title: String(step.title ?? ''), start: Math.max(1, Number(step.start) || 1), duration: Math.max(1, Number(step.duration) || 1),
    details: step.details ? String(step.details) : null,
  }));
}

/** Datas de cada etapa contadas a partir do início da obra (o real; sem ele, o previsto). */
export function stepDates(schedule: Schedule | null | undefined, start: string | null) {
  const unit = unitDaysOf(schedule);
  return stepsOf(schedule).map((step) => {
    const from = start ? addDays(start, (step.start - 1) * unit) : null;
    const to = start ? addDays(start, (step.start - 1 + step.duration) * unit - 1) : null;
    return { ...step, from, to };
  });
}

/** Último dia do cronograma (a data de término que ele combina). */
export function scheduleEnd(schedule: Schedule | null | undefined, start: string | null): string | null {
  const dates = stepDates(schedule, start);
  return dates.reduce<string | null>((last, step) => (step.to && (!last || step.to > last) ? step.to : last), null);
}

/** % previsto de cada etapa num dia (0 a 1), contando do início. */
export function plannedStepRatio(step: { start: number; duration: number }, unitDays: number, start: string, date: string): number {
  const elapsed = (daysBetween(start, date) + 1) / unitDays;
  return Math.min(1, Math.max(0, (elapsed - (step.start - 1)) / step.duration));
}

/** % previsto da obra num dia, pesado pela duração das etapas (igual ao avanço físico). */
export function plannedPercent(schedule: Schedule | null | undefined, start: string, date: string): number | null {
  const steps = stepsOf(schedule);
  const weight = steps.reduce((sum, step) => sum + step.duration, 0);
  if (!weight) return null;
  const unit = unitDaysOf(schedule);
  return round2((steps.reduce((sum, step) => sum + step.duration * plannedStepRatio(step, unit, start, date), 0) / weight) * 100);
}

/** % feito a partir do último percentual informado de cada etapa. */
export function donePercent(schedule: Schedule | null | undefined, last: Map<number, number>): number | null {
  const steps = stepsOf(schedule);
  const weight = steps.reduce((sum, step) => sum + step.duration, 0);
  if (!weight) return null;
  return round2(steps.reduce((sum, step) => sum + step.duration * (last.get(step.step) ?? 0), 0) / weight);
}

/** Etapas que o cronograma prevê para um dia. */
export function stepsOn(schedule: Schedule | null | undefined, start: string | null, date: string): number[] {
  if (!start) return [];
  return stepDates(schedule, start).filter((step) => step.from! <= date && date <= step.to!).map((step) => step.step);
}

/**
 * Projeção de término pelo ritmo: % ganho por dia corrido entre o início e o
 * último RDO. Sem avanço ainda, sem projeção.
 */
export function projectEnd(start: string | null, done: number | null, lastDate: string | null, plannedEnd: string | null) {
  if (!start || done === null || !lastDate || done <= 0) return { date: null, delayDays: null, ratePerDay: null };
  const days = Math.max(1, daysBetween(start, lastDate) + 1);
  const rate = done / days;
  if (done >= 100) return { date: lastDate, delayDays: plannedEnd ? Math.max(0, daysBetween(plannedEnd, lastDate)) : null, ratePerDay: round2(rate) };
  const date = addDays(lastDate, Math.ceil((100 - done) / rate));
  return { date, delayDays: plannedEnd ? daysBetween(plannedEnd, date) : null, ratePerDay: round2(rate) };
}

/** Valida e normaliza um cronograma vindo da tela. */
export function parseSchedule(value: unknown): Schedule {
  const raw = (value ?? {}) as { unit?: unknown; steps?: unknown };
  const unit = typeof raw.unit === 'string' && raw.unit in UNIT_DAYS ? raw.unit : 'dia';
  if (!Array.isArray(raw.steps)) throw new Error('Cronograma inválido');
  if (raw.steps.length > 60) throw new Error('Etapas demais no cronograma');
  const steps = raw.steps.map((entry, index) => {
    const step = (entry ?? {}) as Record<string, unknown>;
    const title = String(step.title ?? '').trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!title) throw new Error(`Etapa ${index + 1}: informe o nome`);
    const start = Number(step.start);
    const duration = Number(step.duration);
    if (!Number.isInteger(start) || start < 1 || start > 1000) throw new Error(`Etapa "${title}": o início precisa ser um número inteiro a partir de 1`);
    if (!Number.isInteger(duration) || duration < 1 || duration > 1000) throw new Error(`Etapa "${title}": a duração precisa ser um número inteiro a partir de 1`);
    const details = String(step.details ?? '').trim().slice(0, 2000);
    return { title, start, duration, ...(details ? { details } : {}) };
  });
  return { unit, steps };
}
