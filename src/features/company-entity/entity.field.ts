import { CrudError } from '@adleron/crud-core';
import { Prisma, PrismaClient } from '@prisma/client';
import { entityScope } from './entity-scope';

type Db = Pick<PrismaClient, 'company_Entity'> | Prisma.TransactionClient;
type Fail = (message: string, field?: string) => never;

/**
 * Campo "Empresa" (CNPJ do grupo) vindo de um formulário: confere que é do grupo
 * e está ativo. Vazio devolve undefined: o banco preenche pela origem ou pelo padrão.
 */
export async function entityField(db: Db, companyId: number, value: unknown, fail: Fail, current?: number | null): Promise<number | undefined> {
  if (value === undefined || value === null || value === '' || value === 'null') return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return fail('Empresa (CNPJ) inválida', 'entityId');
  const allowed = entityScope.allowed();
  if (allowed && !allowed.includes(id)) return fail('Seu usuário não tem acesso a este CNPJ do grupo', 'entityId');
  if (current && id === current) return id;
  const found = await db.company_Entity.findFirst({ where: { id, companyId }, select: { inactiveAt: true, tradeName: true } });
  if (!found) return fail('Empresa (CNPJ) do grupo não encontrada', 'entityId');
  if (found.inactiveAt) return fail(`O CNPJ ${found.tradeName} está inativo`, 'entityId');
  return id;
}

/** Filtro "Empresa" das listas: ?entityId=1 ou 1,2 (vazio = todas). */
export function entityFilter(value: unknown): { entityId: { in: number[] } } | Record<string, never> {
  const ids = [...new Set(String(value ?? '').split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0))];
  return ids.length ? { entityId: { in: ids } } : {};
}

export const ENTITY_SELECT = { select: { id: true, tradeName: true, color: true } } as const;

/**
 * Gancho do crud-core para o campo "Empresa": confere o CNPJ escolhido (do grupo
 * e ativo). Vazio some do corpo: o banco preenche pela origem ou pelo padrão.
 */
export const entityHook = {
  preWrite: async ({ op, data, existing, scopeId, deps }: any) => {
    if ((op !== 'create' && op !== 'update') || !data || !('entityId' in data)) return undefined;
    const id = await entityField(deps.prisma, Number(scopeId), data.entityId, (message, field) => { throw new CrudError('VALIDATION_FAILED', message, field); }, existing?.entityId);
    const next = { ...data };
    if (id) next.entityId = id;
    else delete next.entityId;
    return next;
  },
};
