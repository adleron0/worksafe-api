import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Filtros das listas de contas a pagar e a receber. Uma sintaxe só, simples,
 * para a listagem, o resumo dos cartões e a exportação: o que a tela mostra,
 * os totais e a planilha são sempre o mesmo recorte.
 */
export type Query = Record<string, unknown>;

const fail = (message: string): never => { throw new BadRequestException(message); };
const blank = (value: unknown) => value === undefined || value === null || value === '' || value === 'null' || value === 'undefined';
export const round = (value: number) => Math.round(value * 100) / 100;

/** Hoje no fuso de Brasília (AAAA-MM-DD). */
export const todayBr = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
/** Começo do dia (as datas sem hora ficam ao meio-dia UTC; o dia é o da data UTC). */
export const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`);
export function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function monthEnd(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0, 12)).toISOString().slice(0, 10);
}

export function day(value: unknown, label: string): string | null {
  if (blank(value)) return null;
  const text = String(value).slice(0, 10);
  const date = new Date(`${text}T12:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) fail(`${label} inválida`);
  return text;
}

export function month(value: unknown, label: string): string | null {
  if (blank(value)) return null;
  const text = String(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) fail(`${label} deve estar no formato AAAA-MM`);
  return text;
}

export function ints(value: unknown): number[] {
  if (blank(value)) return [];
  const list = (Array.isArray(value) ? value : String(value).split(',')).map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(list)];
}

export function words(value: unknown, allowed?: readonly string[]): string[] {
  if (blank(value)) return [];
  const list = (Array.isArray(value) ? value : String(value).split(',')).map((v) => String(v).trim()).filter(Boolean);
  if (allowed) for (const item of list) if (!allowed.includes(item)) fail(`Valor de filtro inválido: ${item}`);
  return [...new Set(list)];
}

/** "1.234,56", "1234.56" ou "1234" → número; outra coisa → null. */
export function moneyText(value: unknown): number | null {
  if (blank(value)) return null;
  const text = String(value).trim().replace(/^R\$\s*/i, '');
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(text)) return null;
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function amount(value: unknown, label: string): number | null {
  if (blank(value)) return null;
  const n = moneyText(value) ?? Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${label} inválido`);
  return n;
}

/** Período sobre um campo de data: de (inclusive) até (inclusive). */
export function range(from: string | null, to: string | null): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  if (from && to && from > to) fail('A data inicial é maior que a final');
  return { ...(from ? { gte: dayStart(from) } : {}), ...(to ? { lt: dayStart(plusDays(to, 1)) } : {}) };
}

export function paging(query: Query, max = 200) {
  const page = Math.max(0, Number(query.page ?? 0) || 0);
  const limit = Math.min(max, Math.max(1, Number(query.limit ?? 30) || 30));
  return { page, limit, skip: page * limit };
}

export function ordering(query: Query, allowed: readonly string[], fallback: [string, 'asc' | 'desc']) {
  const [field, dir] = String(query.order ?? '').split(':');
  const chosen = allowed.includes(field) ? field : fallback[0];
  const direction = dir === 'asc' || dir === 'desc' ? dir : fallback[1];
  return [{ [chosen]: direction }, { id: direction }] as Array<Record<string, 'asc' | 'desc'>>;
}

/** Conta do plano escolhida no filtro: vale ela e todas as filhas (conta mãe filtra o grupo). */
export async function withDescendants(prisma: PrismaService, companyId: number, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const all = await prisma.financial_ChartAccount.findMany({ where: { companyId }, select: { id: true, code: true } });
  const roots = all.filter((a) => ids.includes(a.id));
  if (!roots.length) return [-1];
  return all.filter((a) => roots.some((r) => a.code === r.code || a.code.startsWith(`${r.code}.`))).map((a) => a.id);
}

export interface Bucket { count: number; total: number }
export const bucketOf = (count: number, total: unknown): Bucket => ({ count, total: round(Number(total ?? 0)) });

/** As faixas de vencimento dos cartões (atrasada, hoje, 7 dias, depois). */
export function dueWindows(today: string) {
  const start = dayStart(today);
  const tomorrow = dayStart(plusDays(today, 1));
  const week = dayStart(plusDays(today, 8));
  return {
    overdue: { lt: start },
    dueToday: { gte: start, lt: tomorrow },
    dueWeek: { gte: tomorrow, lt: week },
    later: { gte: week },
  } as const;
}
