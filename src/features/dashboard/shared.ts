import { financialRecordsStatus } from '@prisma/client';

/** Quem abriu o resumo: a empresa, a pessoa e as permissões dela. */
export interface DashboardActor { userId: number; companyId: number; permissions: string[] }

export const OPEN_RECEIVABLE: financialRecordsStatus[] = ['waiting', 'overdue', 'processing'];

/** Hoje no horário de Brasília (UTC−3), AAAA-MM-DD. */
export const todayBr = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
export const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
export const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
export const plus = (day: string, days: number) => new Date(asDate(day).getTime() + days * 86400000).toISOString().slice(0, 10);
/** Dias corridos de `from` até `to` (positivo quando `to` é depois). */
export const daysBetween = (from: string, to: string) => Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86400000);
/** "AAAA-MM-DD" → "DD/MM". */
export const brShort = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
/** Os últimos `n` meses (AAAA-MM), do mais antigo ao atual. */
export function lastMonths(today: string, n: number): string[] {
  const [y, m] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1)).toISOString().slice(0, 7));
}
