import { SellerWalletService } from 'src/features/commercial/wallet.service';
import { CrudError, EntityRules, composeHooks } from '@adleron/crud-core';
import { Request } from 'express';
import { fileUpload, parseJsonFields } from 'src/common/crud/hooks';
import { assertClassification, classificationDefaults } from 'src/features/financial/classification';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Campos que só fazem sentido alterar à mão num recebível MANUAL. Num
 * recebível gerado por gateway (Asaas etc.) eles espelham a cobrança do
 * provedor: mudar aqui deixaria o sistema dizendo uma coisa e o gateway outra.
 */
const GATEWAY_OWNED = [
  'value', 'dueDate', 'paymentMethod', 'accrualDate', 'customerId', 'traineeId', 'subscriptionId',
  'originalValue', 'discount', 'installmentNumber', 'installmentTotal',
] as const;

/** Campos de data só com dia: meio-dia UTC, para não virar o dia anterior no fuso do Brasil. */
const DATE_ONLY = ['dueDate', 'invoiceIssuedAt'] as const;

/**
 * O núcleo converte "2026-12-10" em meia-noite UTC antes do hook, o que no
 * Brasil (UTC-3) aparece como dia 9. Data sem hora vira meio-dia UTC.
 */
function noonUtc(value: unknown): unknown {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return value;
  const dateOnly = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  return dateOnly ? new Date(date.getTime() + 12 * 60 * 60 * 1000) : date;
}

const blank = (v: unknown) => v === undefined || v === null || v === '' || v === 'null' || v === 'undefined';

function same(a: unknown, b: unknown): boolean {
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  if (a instanceof Date || b instanceof Date) return new Date(a as any).getTime() === new Date(b as any).getTime();
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a) === String(b);
}

function positiveInt(value: unknown, field: string, label: string): number | null {
  if (blank(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new CrudError('VALIDATION_FAILED', `${label} deve ser um número inteiro maior que zero`, field);
  return n;
}

function money(value: unknown, field: string, label: string, required = false): number | null {
  if (blank(value)) {
    if (required) throw new CrudError('VALIDATION_FAILED', `${label} é obrigatório`, field);
    return null;
  }
  const n = Number(value);
  if (Number.isNaN(n) || n <= 0) throw new CrudError('VALIDATION_FAILED', `${label} deve ser maior que zero`, field);
  return Math.round(n * 100) / 100;
}

export const financialRecordEntity: EntityRules = {
  entity: 'financial-records', model: 'FinancialRecords',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_financeiro', getById: 'list_financeiro', create: 'create_financeiro',
    update: 'update_financeiro', archive: 'inactive_financeiro', restore: 'activate_financeiro' },
  filterable: ['contractId', 'accrualDate', 'gateway', 'status', 'paymentMethod', 'subscriptionId', 'traineeId', 'customerId', 'sellerId', 'couponId',
    'dueDate', 'paidAt', 'externalId', 'createdAt', 'invoiceNumber', 'invoiceIssuedAt',
    'chartAccountId', 'costCenterId', 'bankAccountId', 'trainee.name', 'customer.name', 'seller.name'],
  sortable: ['id', 'dueDate', 'paidAt', 'value', 'createdAt', 'invoiceIssuedAt'],
  includable: ['subscription', 'trainee', 'customer', 'seller', 'coupon', 'splitTransactions', 'chartAccount', 'costCenter', 'bankAccount'],
  includes: { trainee: { select: { id: true, name: true, cpf: true } }, customer: { select: { id: true, name: true, cnpj: true } },
    seller: { select: { id: true, name: true } }, coupon: { select: { id: true, code: true } },
    chartAccount: { select: { id: true, code: true, name: true } }, costCenter: { select: { id: true, name: true } },
    bankAccount: { select: { id: true, name: true, type: true } } },
  aggregatable: ['status', 'value', 'paymentMethod', 'gateway', 'chartAccountId', 'costCenterId', 'bankAccountId'],
  // A key é o acesso público ao registro (GET /key/:key): nunca na listagem.
  maskedFields: ['key'],
  // Status, pagamento e quem baixou só mudam pelas rotas de baixa/estorno
  // (e pelo webhook do gateway) — nunca por um PUT genérico.
  // contrato e parcela só são gravados pelo faturamento do contrato
  neverWritable: ['contractId', 'contractInstallmentId', 'key', 'externalId', 'requestData', 'responseData', 'errorData',
    'paidAt', 'receivedValue', 'settledByUserId', 'bankAccountId', 'billUrl', 'billNumber', 'pixUrl', 'pixNumber'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks<Request>(parseJsonFields(), fileUpload({ invoiceFile: 'invoiceUrl' }), {
    // vendedor, comissão ou situação mudaram por aqui: a carteira do vendedor acompanha
    postWrite: async ({ result, deps }) => {
      // ainda dentro da transação: a linha recém-gravada vai junto, porque por fora só se vê a antiga
      await (deps.wallet as SellerWalletService).syncRecordSafe(Number(result?.id), result);
    },
  }, {
    preWrite: async ({ op, data, existing, scopeId, deps }) => {
      if (op !== 'create' && op !== 'update') return undefined;
      const prisma = deps.prisma as PrismaService;
      const companyId = Number(scopeId);
      const next: Record<string, any> = { ...data };

      for (const field of DATE_ONLY) {
        if (!(field in next)) continue;
        next[field] = blank(next[field]) ? null : noonUtc(next[field]);
      }
      for (const field of ['invoiceNumber', 'description', 'observations'] as const) {
        if (typeof next[field] === 'string') next[field] = next[field].trim() || null;
      }
      for (const field of ['customerId', 'traineeId', 'subscriptionId', 'chartAccountId', 'costCenterId'] as const) {
        if (field in next && blank(next[field])) next[field] = null;
      }
      if ('netValue' in next) next.netValue = money(next.netValue, 'netValue', 'Valor líquido');
      if ('installmentNumber' in next) next.installmentNumber = positiveInt(next.installmentNumber, 'installmentNumber', 'Número da parcela');
      if ('installmentTotal' in next) next.installmentTotal = positiveInt(next.installmentTotal, 'installmentTotal', 'Total de parcelas');

      if (op === 'create') {
        // Criado à mão é sempre recebível manual em aberto: cobrança de gateway
        // nasce pelo checkout, e pagamento só entra pela baixa.
        next.gateway = 'manual';
        next.status = 'waiting';
        next.value = money(next.value, 'value', 'Valor', true);
        if (blank(next.dueDate)) throw new CrudError('VALIDATION_FAILED', 'Vencimento é obrigatório', 'dueDate');
        if (blank(next.customerId) && blank(next.traineeId)) {
          throw new CrudError('VALIDATION_FAILED', 'Informe o cliente', 'customerId');
        }
        if (blank(next.paymentMethod)) next.paymentMethod = 'outro';
        if (blank(next.accrualDate)) next.accrualDate = new Date(next.dueDate).toISOString().slice(0, 7);
        // Sem classificação informada, vale o padrão de lançamento manual (se houver).
        const defaults = await classificationDefaults(prisma, companyId, 'manual');
        if (blank(next.chartAccountId) && defaults.chartAccountId) next.chartAccountId = defaults.chartAccountId;
        if (blank(next.costCenterId) && defaults.costCenterId) next.costCenterId = defaults.costCenterId;
      }

      // Conta mãe, inativa ou de outra empresa não classifica lançamento.
      await assertClassification(
        prisma, companyId,
        { chartAccountId: next.chartAccountId, costCenterId: next.costCenterId },
        { chartAccountId: existing?.chartAccountId, costCenterId: existing?.costCenterId },
        (message, field) => { throw new CrudError('VALIDATION_FAILED', message, field); },
      );

      if (op === 'update' && existing) {
        delete next.gateway;
        delete next.status;
        if (existing.gateway !== 'manual') {
          const changed = GATEWAY_OWNED.find((f) => f in next && !same(next[f], existing[f]));
          if (changed) {
            throw new CrudError('CONFLICT',
              'Cobrança gerada pelo gateway: só nota fiscal, valor líquido, descrição e observações podem ser alterados', changed);
          }
        } else {
          if ('value' in next) next.value = money(next.value, 'value', 'Valor', true);
          if (existing.status === 'received' && 'value' in next && !same(next.value, existing.value)) {
            throw new CrudError('CONFLICT', 'Recebível já baixado: estorne a baixa antes de alterar o valor', 'value');
          }
        }
      }

      if (typeof next.accrualDate === 'string' && !/^\d{4}-\d{2}$/.test(next.accrualDate)) {
        throw new CrudError('VALIDATION_FAILED', 'Competência deve estar no formato AAAA-MM', 'accrualDate');
      }
      const number = next.installmentNumber ?? existing?.installmentNumber;
      const total = next.installmentTotal ?? existing?.installmentTotal;
      if (number && total && Number(number) > Number(total)) {
        throw new CrudError('VALIDATION_FAILED', 'Número da parcela não pode ser maior que o total de parcelas', 'installmentNumber');
      }
      return next;
    },
  }),
};
