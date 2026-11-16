import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Regras e utilitários comuns do estoque (Suprimentos). */
export type Tx = Prisma.TransactionClient;
export type Body = Record<string, any>;

export interface StockActor { userId: number; companyId: number; permissions: string[] }
export const can = (actor: StockActor, permission: string) => actor.permissions.includes(permission);
/** O guard exige todas as permissões listadas; para "qualquer uma destas", conferir aqui. */
export function requireAny(actor: StockActor, permissions: string[]) {
  if (!permissions.some((p) => actor.permissions.includes(p))) throw new ForbiddenException('Acesso negado: Permissões insuficientes');
}

export const PERM = {
  items: 'itens_estoque',
  move: 'movimentar_estoque',
  adjust: 'ajuste_estoque',
  costs: 'custos_estoque',
  equipment: 'equipamentos',
  inspect: 'inspecoes_equipamentos',
  ppe: 'entregas_epi',
  rentals: 'locacoes',
} as const;

/** Posições com saldo. "externo" é a origem/destino final (compra, consumo, descarte, ajuste). */
export const HOLDERS = ['local', 'os', 'funcionario', 'locacao', 'fornecedor'] as const;
export type HolderType = (typeof HOLDERS)[number] | 'externo';
export interface Holder { type: HolderType; id: number | null }
export const EXTERNAL: Holder = { type: 'externo', id: null };
export const holder = (type: HolderType, id: number | null): Holder => ({ type, id: type === 'externo' ? null : id });
/** Para onde o equipamento vai "em uso" (pede peça liberada). */
export const IN_USE: HolderType[] = ['os', 'funcionario', 'locacao'];

export const MOVEMENT_TYPES = {
  saldo_inicial: 'Saldo inicial',
  entrada_compra: 'Entrada por compra',
  entrada_avulsa: 'Entrada avulsa',
  transferencia: 'Transferência',
  saida_os: 'Saída para obra',
  retorno_os: 'Retorno da obra',
  consumo_os: 'Consumo na obra',
  consumo_interno: 'Consumo interno',
  entrega_epi: 'Entrega de EPI',
  devolucao_epi: 'Devolução de EPI',
  saida_locacao: 'Saída para locação',
  retorno_locacao: 'Retorno de locação',
  envio_fornecedor: 'Envio ao fornecedor',
  retorno_fornecedor: 'Retorno do fornecedor',
  baixa: 'Baixa',
  ajuste: 'Ajuste',
  venda: 'Venda',
  estorno: 'Estorno',
} as const;
export type MovementType = keyof typeof MOVEMENT_TYPES;

export const TRACKINGS = ['quantidade', 'lote', 'unidade'] as const;
export const UNIT_STATUS = {
  disponivel: 'Disponível', em_uso: 'Em uso', em_inspecao: 'Em inspeção', em_manutencao: 'Em manutenção',
  em_calibracao: 'Em calibração', bloqueado: 'Bloqueado', baixado: 'Baixado',
} as const;
export type UnitStatus = keyof typeof UNIT_STATUS;
export const RETIRE_REASONS = {
  reprovado: 'Reprovado na inspeção', fim_vida: 'Fim da vida útil', perda: 'Perda', extravio: 'Extravio', avaria: 'Avaria',
  venda: 'Venda', corte: 'Corte', outro: 'Outro',
} as const;

export const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
export const text = (value: unknown, max = 2000) => String(value ?? '').trim().slice(0, max);
export const blank = (value: unknown) => value === undefined || value === null || value === '';
export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export const round3 = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;
export const round4 = (value: number) => Math.round((value + Number.EPSILON) * 10000) / 10000;
export const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
export const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
export const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
/** Hoje no fuso de Brasília. */
export const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
export const fail = (message: string): never => { throw new BadRequestException(message); };
export function dateOf(value: unknown, label: string): string {
  const raw = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(String(value ?? '').trim())?.[1] ?? '';
  if (!raw || Number.isNaN(asDate(raw).getTime()) || iso(asDate(raw)) !== raw) throw new BadRequestException(`${label}: informe uma data válida`);
  return raw;
}
export const optionalDate = (value: unknown, label: string) => (blank(value) ? null : asDate(dateOf(value, label)));
export const addDays = (date: string, days: number) => iso(new Date(asDate(date).getTime() + days * 86400000))!;
export function addMonthsIso(date: string, months: number): string {
  const d = asDate(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d)!;
}
export function positive(value: unknown, label: string, max = 1e9): number {
  const n = Number(value);
  if (!(n > 0) || n > max) fail(`${label}: informe uma quantidade maior que zero`);
  return round3(n);
}
export function optionalNumber(value: unknown, label: string, { min = 0, max = 1e12, int = false } = {}): number | null {
  if (blank(value)) return null;
  const n = Number(value);
  if (Number.isNaN(n) || n < min || n > max || (int && !Number.isInteger(n))) fail(`${label}: valor inválido`);
  return n;
}
export const idOf = (value: unknown): number | null => (blank(value) ? null : Number(value) > 0 ? Number(value) : null);

/** Situação de um vencimento, calculada na leitura (como no RH). */
export type DueState = 'vencido' | 'a_vencer' | 'em_dia';
export function dueState(date: string | null, warnDays = 30, now = today()): DueState | null {
  if (!date) return null;
  if (date < now) return 'vencido';
  return date <= addDays(now, warnDays) ? 'a_vencer' : 'em_dia';
}

/** Lê "AAAA-MM-DD" de uma data do banco (ou null). */
export const d = (value: Date | null | undefined) => iso(value ?? null);
