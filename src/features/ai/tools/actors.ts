import { HttpException } from '@nestjs/common';
import { COSTS_PERMISSION } from 'src/features/commercial/proposal.controller';
import { ALL_PROPOSALS_PERMISSION } from 'src/features/commercial/ownership';
import { APPROVE_PURCHASE_PERMISSION } from 'src/features/operations/purchase-order.controller';
import { ALL_ORDERS_PERMISSION } from 'src/features/operations/service-order.service';
import { OCCURRENCES_VIEW_PERMISSION, OCCURRENCES_WRITE_PERMISSION, PERSONAL_PERMISSION } from 'src/features/hr/employee.service';
import { ToolContext, ToolRefusal } from './tool.types';

/**
 * Os "atores" que cada serviço espera, montados como os controllers montam
 * a partir do token. Assim o bot vê exatamente o que a pessoa veria na tela
 * ("só as minhas" propostas e OS, custos, dados pessoais).
 */
const has = (ctx: ToolContext, permission: string) => ctx.permissions.includes(permission);

export const proposalActor = (ctx: ToolContext) => ({
  userId: ctx.userId, companyId: ctx.companyId, canSeeCosts: has(ctx, COSTS_PERMISSION), seesAll: has(ctx, ALL_PROPOSALS_PERMISSION),
});
export const activityActor = (ctx: ToolContext) => ({ userId: ctx.userId, companyId: ctx.companyId, seesAll: has(ctx, ALL_PROPOSALS_PERMISSION) });
export const orderActor = (ctx: ToolContext) => ({
  userId: ctx.userId, companyId: ctx.companyId, canSeeCosts: has(ctx, COSTS_PERMISSION), seesAll: has(ctx, ALL_ORDERS_PERMISSION),
});
export const resultActor = (ctx: ToolContext) => ({ companyId: ctx.companyId, canSeeCosts: has(ctx, COSTS_PERMISSION) });
export const purchaseActor = (ctx: ToolContext) => ({
  userId: ctx.userId, companyId: ctx.companyId, canApprove: has(ctx, APPROVE_PURCHASE_PERMISSION), canSeeCosts: has(ctx, COSTS_PERMISSION),
});
export const employeeActor = (ctx: ToolContext) => ({
  userId: ctx.userId, companyId: ctx.companyId, seesPersonal: has(ctx, PERSONAL_PERMISSION),
  seesOccurrences: has(ctx, OCCURRENCES_VIEW_PERMISSION), writesOccurrences: has(ctx, OCCURRENCES_WRITE_PERMISSION),
});
export const plainActor = (ctx: ToolContext) => ({ userId: ctx.userId, companyId: ctx.companyId });

/** Erro de regra do serviço (400, 404, 409...) vira recusa com o motivo, para o modelo corrigir. */
export async function asRefusal<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException && error.getStatus() < 500) {
      const body = error.getResponse() as { message?: string | string[] } | string;
      const message = typeof body === 'string' ? body : Array.isArray(body.message) ? body.message.join('; ') : body.message ?? error.message;
      throw new ToolRefusal(String(message));
    }
    throw error;
  }
}

/** Hoje no horário de Brasília (AAAA-MM-DD). */
export const todayBr = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
export const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString().slice(0, 10) : null);
export const money = (value: unknown) => Number(Number(value ?? 0).toFixed(2));
export const brl = (value: unknown) => Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const isDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
export const text = (value: unknown, max = 200) => String(value ?? '').trim().slice(0, max);
export const positiveInt = (value: unknown) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);
