import { CrudError, EntityRules, composeHooks } from '@adleron/crud-core';
import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { fileUpload } from 'src/common/crud/hooks';
import { PrismaService } from 'src/prisma/prisma.service';
import { assertClassification } from './classification';
import { TAX_GUIDES } from './retention.service';

const PERMISSIONS = {
  list: 'list_financeiro', getById: 'list_financeiro', create: 'create_financeiro',
  update: 'update_financeiro', archive: 'inactive_financeiro', restore: 'activate_financeiro',
} as const;

const clean = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ');
const blank = (value: unknown) => value === undefined || value === null || value === '' || value === 'null' || value === 'undefined';
const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

type Fail = (message: string, field: string) => never;
const crudFail: Fail = (message, field) => { throw new CrudError('VALIDATION_FAILED', message, field); };

// ---------------------------------------------------------------- fornecedores

const SUPPLIER_TEXT: Array<[string, number]> = [
  ['legalName', 200], ['supplies', 255], ['contactName', 120], ['email', 160], ['phone', 30], ['phone2', 30], ['stateRegistration', 30],
  ['pixKey', 140], ['bankName', 120], ['agency', 20], ['account', 30], ['notes', 500],
  ['street', 255], ['number', 20], ['complement', 255], ['neighborhood', 120], ['city', 120],
];

/** Regras do cadastro de fornecedor, comuns ao CRUD e ao cadastro rápido no pedido de compra. */
export async function normalizeSupplier(
  prisma: Pick<PrismaService, 'financial_Supplier'>, companyId: number, input: Record<string, any>, existing: Record<string, any> | null | undefined, fail: Fail,
): Promise<Record<string, any>> {
  const next: Record<string, any> = { ...input };
  if ('name' in next || !existing) {
    next.name = clean(next.name).slice(0, 160);
    if (next.name.length < 2) fail('Informe o nome do fornecedor', 'name');
  }
  if ('document' in next) {
    const document = digits(next.document);
    if (document && document.length !== 11 && document.length !== 14) fail('CNPJ deve ter 14 dígitos e CPF, 11', 'document');
    if (document) {
      const dup = await prisma.financial_Supplier.findFirst({
        where: { companyId, document, ...(existing ? { NOT: { id: Number(existing.id) } } : {}) }, select: { name: true },
      });
      if (dup) throw new CrudError('CONFLICT', `Já existe um fornecedor com esse documento: ${dup.name}`, 'document');
    }
    next.document = document || null;
  }
  for (const [field, max] of SUPPLIER_TEXT) if (field in next) next[field] = clean(next[field]).slice(0, max) || null;
  if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) fail('E-mail inválido', 'email');
  if ('zipcode' in next) {
    const cep = digits(next.zipcode);
    if (cep && cep.length !== 8) fail('CEP deve ter 8 dígitos', 'zipcode');
    next.zipcode = cep ? `${cep.slice(0, 5)}-${cep.slice(5)}` : null;
  }
  if ('state' in next) {
    const uf = clean(next.state).toUpperCase();
    if (uf && !/^[A-Z]{2}$/.test(uf)) fail('UF deve ter 2 letras', 'state');
    next.state = uf || null;
  }
  return next;
}

/** Fornecedores: cadastro simples; nome obrigatório, CNPJ/CPF único quando informado. */
export const supplierEntity: EntityRules = {
  entity: 'financial-suppliers', model: 'Financial_Supplier',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: PERMISSIONS,
  filterable: ['name', 'document', 'supplies', 'city', 'state', 'createdAt'],
  sortable: ['id', 'name', 'createdAt'],
  includable: ['_count'],
  includes: { _count: { select: { payables: true } } },
  softDelete: { field: 'inactiveAt' },
  hooks: {
    preWrite: async ({ op, data, existing, scopeId, deps }) => {
      const prisma = deps.prisma as PrismaService;
      const companyId = Number(scopeId);
      if (op === 'archive' && existing) {
        const open = await prisma.financial_Payable.count({ where: { companyId, supplierId: Number(existing.id), inactiveAt: null, status: 'aberta' } });
        if (open > 0) throw new CrudError('CONFLICT', `Há ${open} conta(s) a pagar em aberto deste fornecedor`);
        return undefined;
      }
      if (op !== 'create' && op !== 'update') return undefined;
      return normalizeSupplier(prisma, companyId, { ...data }, op === 'update' ? existing : null, crudFail);
    },
  },
};

// ---------------------------------------------------------------- contas a pagar

export const PAYABLE_METHODS = ['transferencia', 'pix', 'boleto', 'cartaoCredito', 'dinheiro', 'outro'];

/** Data sem hora vira meio-dia UTC, para não cair no dia anterior no fuso do Brasil. */
export function payableDay(value: unknown, label: string, field: string, fail: Fail): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(`${value.toISOString().slice(0, 10)}T12:00:00.000Z`);
  }
  const raw = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  const date = raw ? new Date(`${raw[0]}T12:00:00.000Z`) : null;
  // 2026-02-31 viraria março: a data tem de voltar igual
  if (!raw || !date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw[0]) return fail(`${label} inválido`, field);
  return date;
}

export function payableMoney(value: unknown, label: string, field: string, fail: Fail): number {
  const n = Number(value);
  if (blank(value) || Number.isNaN(n) || n <= 0) return fail(`${label} deve ser maior que zero`, field);
  return Math.round(n * 100) / 100;
}

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Regras de uma conta a pagar, comuns ao cadastro (CRUD) e ao lançamento em
 * parcelas: só devolve os campos que vieram, já limpos e conferidos.
 */
export async function normalizePayable(
  prisma: Db, companyId: number, input: Record<string, any>, existing: Record<string, any> | null | undefined, fail: Fail,
): Promise<Record<string, any>> {
  const next: Record<string, any> = {};
  const creating = !existing;
  const has = (field: string) => field in input;

  if (has('description') || creating) {
    next.description = clean(input.description).slice(0, 255);
    if (next.description.length < 2) fail('Informe a descrição', 'description');
  }
  if (has('value') || creating) {
    next.value = payableMoney(input.value, 'Valor', 'value', fail);
    if (existing?.status === 'paga' && Number(existing.value) !== next.value) fail('Conta já paga: estorne a baixa antes de alterar o valor', 'value');
  }
  if (has('dueDate') || creating) {
    if (blank(input.dueDate)) fail('Informe o vencimento', 'dueDate');
    next.dueDate = payableDay(input.dueDate, 'Vencimento', 'dueDate', fail);
  }
  if (has('accrualDate') || creating) {
    const accrual = blank(input.accrualDate) ? (next.dueDate ?? existing?.dueDate).toISOString().slice(0, 7) : String(input.accrualDate);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(accrual)) fail('Competência deve estar no formato AAAA-MM', 'accrualDate');
    next.accrualDate = accrual;
  }
  if (has('paymentMethod')) {
    if (!blank(input.paymentMethod) && !PAYABLE_METHODS.includes(String(input.paymentMethod))) fail('Forma de pagamento inválida', 'paymentMethod');
    next.paymentMethod = blank(input.paymentMethod) ? null : String(input.paymentMethod);
  }
  if (has('taxKind')) {
    const kind = blank(input.taxKind) ? null : String(input.taxKind);
    if (kind && !Object.keys(TAX_GUIDES).includes(kind)) fail('Guia de imposto inválida', 'taxKind');
    next.taxKind = kind;
  }
  if (has('documentNumber')) next.documentNumber = clean(input.documentNumber).slice(0, 60) || null;
  if (has('barcode')) {
    // linha digitável: guarda só os dígitos (47 do boleto bancário, 48 da conta de consumo)
    const code = digits(input.barcode);
    if (code && (code.length < 44 || code.length > 48)) fail('Linha digitável deve ter de 44 a 48 dígitos', 'barcode');
    next.barcode = code || null;
  }
  if (has('pixCode')) next.pixCode = String(input.pixCode ?? '').trim().slice(0, 600) || null;
  if (has('observations')) next.observations = String(input.observations ?? '').trim().slice(0, 500) || null;

  for (const field of ['installmentNumber', 'installmentTotal'] as const) {
    if (!has(field)) continue;
    if (blank(input[field])) { next[field] = null; continue; }
    const n = Number(input[field]);
    if (!Number.isInteger(n) || n < 1) fail('Parcela deve ser um número inteiro maior que zero', field);
    next[field] = n;
  }
  const number = has('installmentNumber') ? next.installmentNumber : existing?.installmentNumber;
  const total = has('installmentTotal') ? next.installmentTotal : existing?.installmentTotal;
  if (Boolean(number) !== Boolean(total)) fail('Informe a parcela e o total de parcelas', 'installmentNumber');
  if (number && total && number > total) fail('Número da parcela não pode ser maior que o total', 'installmentNumber');

  if (has('supplierId')) {
    next.supplierId = blank(input.supplierId) ? null : Number(input.supplierId);
    if (next.supplierId && next.supplierId !== Number(existing?.supplierId ?? 0)) {
      const supplier = await prisma.financial_Supplier.findFirst({ where: { id: next.supplierId, companyId }, select: { inactiveAt: true, name: true } });
      if (!supplier) fail('Fornecedor não encontrado', 'supplierId');
      if (supplier.inactiveAt) fail(`O fornecedor ${supplier.name} está inativo`, 'supplierId');
    }
  }
  if (has('serviceOrderId')) {
    next.serviceOrderId = blank(input.serviceOrderId) ? null : Number(input.serviceOrderId);
    if (next.serviceOrderId && next.serviceOrderId !== Number(existing?.serviceOrderId ?? 0)) {
      const order = await prisma.service_Order.findFirst({ where: { id: next.serviceOrderId, companyId }, select: { id: true } });
      if (!order) fail('Ordem de serviço não encontrada', 'serviceOrderId');
    }
  }
  for (const field of ['chartAccountId', 'costCenterId'] as const) {
    if (has(field)) next[field] = blank(input[field]) ? null : Number(input[field]);
  }
  await assertClassification(
    prisma as PrismaService, companyId,
    { chartAccountId: next.chartAccountId, costCenterId: next.costCenterId },
    { chartAccountId: existing?.chartAccountId, costCenterId: existing?.costCenterId }, fail,
  );
  if (next.chartAccountId && next.chartAccountId !== Number(existing?.chartAccountId ?? 0)) {
    const account = await prisma.financial_ChartAccount.findFirst({ where: { id: next.chartAccountId, companyId }, select: { nature: true, code: true, name: true } });
    if (account?.nature !== 'despesa') fail(`${account?.code} ${account?.name} é conta de receita: conta a pagar usa conta de despesa`, 'chartAccountId');
  }
  return next;
}

const PAYABLE_FIELDS = ['description', 'value', 'dueDate', 'accrualDate', 'paymentMethod', 'documentNumber', 'observations', 'barcode', 'pixCode',
  'installmentNumber', 'installmentTotal', 'supplierId', 'serviceOrderId', 'chartAccountId', 'costCenterId', 'taxKind'];

/**
 * Contas a pagar. Situação e pagamento só mudam pelas rotas de baixa e estorno;
 * o lançamento em várias parcelas tem rota própria (cria todas de uma vez).
 */
export const payableEntity: EntityRules = {
  entity: 'financial-payables', model: 'Financial_Payable',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: PERMISSIONS,
  filterable: ['status', 'accrualDate', 'dueDate', 'paidAt', 'supplierId', 'serviceOrderId', 'chartAccountId', 'costCenterId', 'bankAccountId',
    'origin', 'groupKey', 'taxKind', 'description', 'documentNumber', 'createdAt', 'supplier.name', 'value', 'recurrenceId'],
  sortable: ['id', 'dueDate', 'paidAt', 'value', 'createdAt'],
  includable: ['supplier', 'serviceOrder', 'chartAccount', 'costCenter', 'bankAccount'],
  includes: {
    supplier: { select: { id: true, name: true, document: true, pixKey: true } },
    serviceOrder: { select: { id: true, number: true } },
    chartAccount: { select: { id: true, code: true, name: true } }, costCenter: { select: { id: true, name: true } },
    bankAccount: { select: { id: true, name: true, type: true } },
  },
  aggregatable: ['status', 'value'],
  neverWritable: ['status', 'paidAt', 'paidValue', 'bankAccountId', 'settledByUserId', 'origin', 'purchaseOrderId', 'groupKey', 'createdByUserId',
    'interestValue', 'fineValue', 'discountValue', 'recurrenceId', 'statementRef'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks<Request>(fileUpload({ billFile: 'billUrl', invoiceFile: 'invoiceUrl', receiptFile: 'receiptUrl' }), {
    preWrite: async ({ op, data, existing, scopeId, deps, context }) => {
      if (op === 'archive' && existing?.status === 'paga') {
        throw new CrudError('CONFLICT', 'Conta já paga: estorne a baixa antes de excluir');
      }
      if (op !== 'create' && op !== 'update') return undefined;
      const next: Record<string, any> = { ...data };
      // o núcleo já converteu a data (31/02 viraria março): confere o texto que chegou
      const sent = (context as Request)?.body?.dueDate;
      if (typeof sent === 'string' && 'dueDate' in next) next.dueDate = sent;
      const normalized = await normalizePayable(deps.prisma as PrismaService, Number(scopeId), next, op === 'update' ? existing : null, crudFail);
      for (const field of PAYABLE_FIELDS) delete next[field];
      Object.assign(next, normalized);
      for (const field of ['billUrl', 'invoiceUrl', 'receiptUrl']) if (field in next && blank(next[field])) next[field] = null;
      if (op === 'create') {
        next.status = 'aberta';
        next.origin = 'manual';
        const user = (context as Request & { user?: { sub?: number } })?.user;
        next.createdByUserId = Number(user?.sub ?? 0) || null;
      }
      return next;
    },
  }),
};
