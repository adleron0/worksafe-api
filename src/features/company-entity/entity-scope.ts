import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

/**
 * Usuário limitado a alguns CNPJs do grupo.
 *
 * `User.entityIds` vazio = vê todos os CNPJs (o normal). Com CNPJs escolhidos, a
 * requisição dele só enxerga e grava registros desses CNPJs. A trava fica no
 * próprio Prisma (extensão abaixo): vale para todas as telas, relatórios, bots
 * e MCP sem cada serviço lembrar de filtrar. Fora de uma requisição de usuário
 * (checkout público, webhook, rotinas agendadas) não há limite.
 */
interface ScopeStore { ids: number[] | null }

const storage = new AsyncLocalStorage<ScopeStore>();

export const entityScope = {
  /** Abre a "caixa" da requisição; o AuthGuard preenche depois de ler o usuário. */
  middleware(_req: Request, _res: Response, next: NextFunction) { storage.run({ ids: null }, next); },
  set(ids: number[] | null) { const store = storage.getStore(); if (store) store.ids = ids?.length ? [...ids] : null; },
  /** CNPJs permitidos na requisição atual (null = todos). */
  allowed(): number[] | null { return storage.getStore()?.ids ?? null; },
  run<T>(ids: number[] | null, fn: () => Promise<T>): Promise<T> { return storage.run({ ids: ids?.length ? ids : null }, fn); },
};

/** Tabelas com CNPJ que a trava filtra. Funcionário fica de fora: trabalha para mais de um CNPJ (equipe da OS). */
export const SCOPED_MODELS = new Set<string>([
  'Fiscal_Settings', 'Fiscal_Invoice', 'Fiscal_ReceivedInvoice', 'Fiscal_ServiceCode',
  'Financial_BankAccount', 'FinancialRecords', 'Financial_Payable', 'Financial_Recurrence',
  'CompanyGateWays', 'Commercial_Proposal', 'Commercial_Contract', 'Service_Order', 'Stock_Rental',
  'Course', 'CourseClass',
]);
/** Sem CNPJ = vale para todos (serviço fiscal). */
const NULL_MEANS_ALL = new Set<string>(['Fiscal_ServiceCode']);

const WHERE_OPS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy', 'updateMany', 'updateManyAndReturn', 'deleteMany']);
const UNIQUE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']);

const deny = (): never => { throw new ForbiddenException('Seu usuário não tem acesso a este CNPJ do grupo'); };

function checkData(data: any, ids: number[]) {
  if (!data || typeof data !== 'object') return;
  const raw = data.entityId;
  const value = raw && typeof raw === 'object' && 'set' in raw ? raw.set : raw;
  if (value !== undefined && value !== null && !ids.includes(Number(value))) deny();
  const connect = data.entity?.connect?.id;
  if (connect !== undefined && !ids.includes(Number(connect))) deny();
}

/** Extensão do Prisma: soma "entityId nos CNPJs permitidos" às consultas e confere o que é gravado. */
export const entityScopeExtension = Prisma.defineExtension({
  name: 'entity-scope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const ids = entityScope.allowed();
        if (!ids || !model || !SCOPED_MODELS.has(model)) return query(args);
        const cond = NULL_MEANS_ALL.has(model) ? { OR: [{ entityId: { in: ids } }, { entityId: null }] } : { entityId: { in: ids } };
        const a: any = { ...(args as any) };
        if (WHERE_OPS.has(operation)) a.where = a.where ? { AND: [a.where, cond] } : cond;
        if (UNIQUE_OPS.has(operation)) a.where = { ...a.where, AND: [...([] as any[]).concat(a.where?.AND ?? []), cond] };
        // limitado a um CNPJ só: o que ele cria sem CNPJ nasce nesse CNPJ (senão o banco
        // escolheria pela frente ou pelo padrão, e o registro sumiria da tela dele)
        if (operation === 'create' && ids.length === 1 && a.data && a.data.entityId == null && !a.data.entity) {
          const relational = Object.values(a.data).some((v: any) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && ('connect' in v || 'create' in v || 'connectOrCreate' in v));
          a.data = relational ? { ...a.data, entity: { connect: { id: ids[0] } } } : { ...a.data, entityId: ids[0] };
        }
        if (operation === 'create' || operation === 'update' || operation === 'updateMany' || operation === 'updateManyAndReturn') checkData(a.data, ids);
        if (operation === 'upsert') { checkData(a.create, ids); checkData(a.update, ids); }
        if (operation === 'createMany' || operation === 'createManyAndReturn') ([] as any[]).concat(a.data ?? []).forEach((d) => checkData(d, ids));
        return query(a);
      },
    },
  },
});

/** Lê os CNPJs permitidos do usuário (cache curto: o guard roda em toda requisição). */
const cache = new Map<number, { ids: number[] | null; at: number }>();
const TTL_MS = 30_000;

export async function allowedEntitiesOf(prisma: Pick<PrismaClient, 'user'>, userId: number): Promise<number[] | null> {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { entityIds: true, profile: { select: { name: true } } } });
  // o super vê tudo, mesmo que alguém marque CNPJs nele
  const ids = row && row.profile?.name !== 'super' && row.entityIds.length ? row.entityIds : null;
  cache.set(userId, { ids, at: Date.now() });
  return ids;
}

export function forgetAllowedEntities(userId?: number) {
  if (userId) cache.delete(userId);
  else cache.clear();
}
