import { CrudError, EntityRules } from '@adleron/crud-core';
import { PrismaService } from 'src/prisma/prisma.service';

const PERMISSIONS = {
  list: 'list_financeiro', getById: 'list_financeiro', create: 'create_financeiro',
  update: 'update_financeiro', archive: 'inactive_financeiro', restore: 'activate_financeiro',
} as const;

const clean = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ');
const blank = (value: unknown) => value === undefined || value === null || value === '' || value === 'null';
const OPEN = ['waiting', 'overdue', 'processing'] as const;

/** Centros de custo: lista simples (área do negócio), nome único por empresa. */
export const costCenterEntity: EntityRules = {
  entity: 'financial-cost-centers', model: 'Financial_CostCenter',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: PERMISSIONS,
  filterable: ['name', 'code', 'createdAt'],
  sortable: ['id', 'name', 'code', 'createdAt'],
  includable: ['_count'],
  includes: { _count: { select: { financialRecords: true } } },
  softDelete: { field: 'inactiveAt' },
  hooks: {
    preWrite: async ({ op, data, existing, scopeId, deps }) => {
      const prisma = deps.prisma as PrismaService;
      const companyId = Number(scopeId);
      if (op === 'archive' && existing) {
        const open = await prisma.financialRecords.count({ where: { companyId, costCenterId: Number(existing.id), inactiveAt: null, status: { in: [...OPEN] } } });
        if (open > 0) throw new CrudError('CONFLICT', `Há ${open} lançamento(s) em aberto neste centro de custo`);
        const defaults = await prisma.financial_ClassificationDefault.count({ where: { companyId, costCenterId: Number(existing.id) } });
        if (defaults > 0) throw new CrudError('CONFLICT', 'Este centro de custo é usado na classificação automática: troque o padrão antes de inativar');
        return undefined;
      }
      if (op !== 'create' && op !== 'update') return undefined;
      const next: Record<string, any> = { ...data };
      if ('name' in next || op === 'create') {
        const name = clean(next.name);
        if (name.length < 2) throw new CrudError('VALIDATION_FAILED', 'Informe o nome do centro de custo', 'name');
        const dup = await prisma.financial_CostCenter.findFirst({
          where: { companyId, name: { equals: name, mode: 'insensitive' }, ...(existing ? { NOT: { id: Number(existing.id) } } : {}) },
          select: { id: true },
        });
        if (dup) throw new CrudError('CONFLICT', 'Já existe um centro de custo com esse nome', 'name');
        next.name = name;
      }
      for (const field of ['code', 'description'] as const) if (field in next) next[field] = clean(next[field]) || null;
      return next;
    },
  },
};

const BANK_TYPES = ['corrente', 'poupanca', 'caixa', 'gateway'];

/** Contas bancárias e caixas: onde o dinheiro entra na baixa. */
export const bankAccountEntity: EntityRules = {
  entity: 'financial-bank-accounts', model: 'Financial_BankAccount',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: PERMISSIONS,
  filterable: ['name', 'type', 'isDefault', 'createdAt'],
  sortable: ['id', 'name', 'type', 'createdAt'],
  includable: ['_count'],
  includes: { _count: { select: { financialRecords: true } } },
  softDelete: { field: 'inactiveAt' },
  hooks: {
    preWrite: async ({ op, data, existing, scopeId, deps }) => {
      const prisma = deps.prisma as PrismaService;
      const companyId = Number(scopeId);
      if (op === 'archive') return { ...data, isDefault: false };
      if (op !== 'create' && op !== 'update') return undefined;
      const next: Record<string, any> = { ...data };

      if ('name' in next || op === 'create') {
        const name = clean(next.name);
        if (name.length < 2) throw new CrudError('VALIDATION_FAILED', 'Informe o nome da conta', 'name');
        const dup = await prisma.financial_BankAccount.findFirst({
          where: { companyId, name: { equals: name, mode: 'insensitive' }, ...(existing ? { NOT: { id: Number(existing.id) } } : {}) },
          select: { id: true },
        });
        if (dup) throw new CrudError('CONFLICT', 'Já existe uma conta com esse nome', 'name');
        next.name = name;
      }
      if ('type' in next && !BANK_TYPES.includes(String(next.type))) throw new CrudError('VALIDATION_FAILED', 'Tipo de conta inválido', 'type');
      const type = String(next.type ?? existing?.type ?? 'corrente');
      if (type === 'gateway') {
        const gateway = next.gateway ?? existing?.gateway;
        if (blank(gateway) || gateway === 'manual') throw new CrudError('VALIDATION_FAILED', 'Escolha o provedor da conta de gateway', 'gateway');
        const dup = await prisma.financial_BankAccount.findFirst({
          where: { companyId, type: 'gateway', gateway, inactiveAt: null, ...(existing ? { NOT: { id: Number(existing.id) } } : {}) },
          select: { id: true },
        });
        if (dup) throw new CrudError('CONFLICT', 'Já existe uma conta para esse provedor', 'gateway');
      } else if ('type' in next || 'gateway' in next) {
        next.gateway = null;
      }
      for (const field of ['bankCode', 'bankName', 'agency', 'agencyDigit', 'account', 'accountDigit', 'pixKey', 'holderName', 'holderDocument'] as const) {
        if (field in next) next[field] = clean(next[field]) || null;
      }
      if ('openingBalance' in next) {
        const value = blank(next.openingBalance) ? 0 : Number(next.openingBalance);
        if (Number.isNaN(value)) throw new CrudError('VALIDATION_FAILED', 'Saldo inicial inválido', 'openingBalance');
        next.openingBalance = Math.round(value * 100) / 100;
      }
      if ('openingBalanceDate' in next && blank(next.openingBalanceDate)) next.openingBalanceDate = null;
      if ('isDefault' in next) next.isDefault = next.isDefault === true || next.isDefault === 'true';
      return next;
    },
    // Só uma conta padrão por empresa: marcar uma desmarca as outras.
    postWrite: async ({ op, result, scopeId, deps }) => {
      if ((op !== 'create' && op !== 'update') || result.isDefault !== true) return;
      const prisma = deps.prisma as PrismaService;
      await prisma.financial_BankAccount.updateMany({
        where: { companyId: Number(scopeId), isDefault: true, NOT: { id: Number(result.id) } }, data: { isDefault: false },
      });
    },
  },
};
