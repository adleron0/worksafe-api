import { EntityHooks, EntityRules, FilterNode, Repository, Row } from '@adleron/crud-core';
import { Request } from 'express';

/** Papel do contato → coluna do papel e coluna de "padrão" daquele papel. */
export const CONTACT_ROLES = [
  { flag: 'isCommercial', def: 'defaultCommercial' },
  { flag: 'isFinancial', def: 'defaultFinancial' },
  { flag: 'isFiscal', def: 'defaultFiscal' },
] as const;

const MODEL = 'Customer_Contacts';
const eq = (column: string, value: string | number | boolean | null): FilterNode =>
  ({ kind: 'cmp', path: [column], operator: value === null ? 'isNull' : 'eq', value });

/**
 * Cada cliente tem no máximo um contato padrão por papel, entre os contatos
 * ativos que têm o papel. Quem acabou de ser marcado como padrão (`prefer`)
 * ganha; se ninguém é padrão, o primeiro com o papel vira. Roda dentro da
 * transação do CRUD, pelo mesmo repositório.
 */
export async function normalizeContactDefaults(repo: Repository, customerId: number, prefer?: Row): Promise<void> {
  const rows = await repo.findMany(MODEL, {
    filter: { kind: 'and', nodes: [eq('customerId', customerId), eq('inactiveAt', null)] },
    orderBy: [{ path: ['id'], direction: 'asc' }],
    skip: null,
    take: null,
  });
  for (const { flag, def } of CONTACT_ROLES) {
    const holders = rows.filter((r) => r[flag]);
    const chosen =
      (prefer && prefer[def] && prefer[flag] && !prefer.inactiveAt ? holders.find((r) => r.id === prefer.id) : undefined) ??
      holders.find((r) => r[def]) ??
      holders[0];
    for (const r of rows) {
      const want = r.id === chosen?.id;
      if (Boolean(r[def]) !== want) {
        await repo.update(MODEL, { filter: eq('id', r.id as number), data: { [def]: want } });
      }
    }
  }
}

const contactHooks: EntityHooks<Request> = {
  // sem o papel, não pode ser padrão dele; contato inativado deixa de ser padrão
  preWrite: ({ op, data, existing }) => {
    const next = { ...data };
    for (const { flag, def } of CONTACT_ROLES) {
      const has = flag in next ? Boolean(next[flag]) : Boolean(existing?.[flag]);
      if (!has || op === 'archive') next[def] = false;
    }
    return next;
  },
  postWrite: async ({ result, repository }) => {
    await normalizeContactDefaults(repository, Number(result.customerId), result);
  },
};

export const customerContactsEntity: EntityRules = {
  entity: 'customer-contacts',
  model: MODEL,
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  restorePermission: 'own',
  permissions: {
    list: 'list_clientes', getById: 'list_clientes', create: 'create_clientes',
    update: 'update_clientes', archive: 'inactive_clientes', restore: 'activate_clientes',
  },
  filterable: [
    'name', 'email', 'phone', 'customerId', 'roleId', 'createdAt', 'customer.name', 'role.name', 'inactiveAt',
    'isCommercial', 'isFinancial', 'isFiscal',
  ],
  sortable: ['id', 'name', 'createdAt'],
  includable: ['customer', 'role'],
  includes: { customer: { select: { id: true, name: true } }, role: { select: { id: true, name: true } } },
  softDelete: { field: 'inactiveAt' },
  hooks: contactHooks,
};
