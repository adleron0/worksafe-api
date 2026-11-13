import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** Origem do recebível, para a classificação automática. */
export type ClassificationOrigin = 'inscricao' | 'manual';
export const CLASSIFICATION_ORIGINS: Array<{ origin: ClassificationOrigin; label: string }> = [
  { origin: 'inscricao', label: 'Inscrição em turma (checkout)' },
  { origin: 'manual', label: 'Lançamento manual' },
];

type Db = Pick<PrismaClient, 'financial_ClassificationDefault'>;

/**
 * Conta e centro de custo padrão para um recebível novo, conforme a origem.
 *
 * Roda dentro do checkout, então NUNCA lança: classificação é informação
 * gerencial e não pode impedir uma venda. Sem padrão configurado, conta
 * inativa ou qualquer erro → `{}` e o recebível nasce sem classificação.
 */
export async function classificationDefaults(
  prisma: Db,
  companyId: number | null | undefined,
  origin: ClassificationOrigin,
): Promise<{ chartAccountId?: number; costCenterId?: number }> {
  if (!companyId) return {};
  try {
    const row = await prisma.financial_ClassificationDefault.findUnique({
      where: { companyId_origin: { companyId: Number(companyId), origin } },
      select: {
        chartAccount: { select: { id: true, inactiveAt: true, acceptsEntries: true } },
        costCenter: { select: { id: true, inactiveAt: true } },
      },
    });
    if (!row) return {};
    const out: { chartAccountId?: number; costCenterId?: number } = {};
    if (row.chartAccount && !row.chartAccount.inactiveAt && row.chartAccount.acceptsEntries) out.chartAccountId = row.chartAccount.id;
    if (row.costCenter && !row.costCenter.inactiveAt) out.costCenterId = row.costCenter.id;
    return out;
  } catch {
    return {};
  }
}

type GuardDb = Pick<PrismaClient, 'financial_ChartAccount' | 'financial_CostCenter' | 'financial_BankAccount'>;

/**
 * Valida a classificação informada num lançamento: tem de ser da empresa,
 * estar ativa e — no plano de contas — ser conta que aceita lançamento
 * (sem filhas). A regra mora aqui, na API, e não só no seletor da tela.
 *
 * `current` são os ids que o registro já tem: manter o que já estava (mesmo
 * que a conta tenha sido inativada depois) não é erro.
 */
export async function assertClassification(
  prisma: GuardDb,
  companyId: number,
  ids: { chartAccountId?: unknown; costCenterId?: unknown; bankAccountId?: unknown },
  current: { chartAccountId?: unknown; costCenterId?: unknown; bankAccountId?: unknown } = {},
  fail: (message: string, field: string) => never = (message) => { throw new BadRequestException(message); },
): Promise<void> {
  const changed = (field: 'chartAccountId' | 'costCenterId' | 'bankAccountId') =>
    ids[field] !== undefined && ids[field] !== null && Number(ids[field]) !== Number(current[field] ?? 0);

  if (changed('chartAccountId')) {
    const account = await prisma.financial_ChartAccount.findFirst({
      where: { id: Number(ids.chartAccountId), companyId },
      select: { inactiveAt: true, acceptsEntries: true, code: true, name: true },
    });
    if (!account) fail('Conta do plano de contas não encontrada', 'chartAccountId');
    if (account.inactiveAt) fail(`A conta ${account.code} ${account.name} está inativa`, 'chartAccountId');
    if (!account.acceptsEntries) {
      fail(`${account.code} ${account.name} é uma conta mãe: escolha uma das contas filhas`, 'chartAccountId');
    }
  }
  if (changed('costCenterId')) {
    const center = await prisma.financial_CostCenter.findFirst({
      where: { id: Number(ids.costCenterId), companyId }, select: { inactiveAt: true, name: true },
    });
    if (!center) fail('Centro de custo não encontrado', 'costCenterId');
    if (center.inactiveAt) fail(`O centro de custo ${center.name} está inativo`, 'costCenterId');
  }
  if (changed('bankAccountId')) {
    const bank = await prisma.financial_BankAccount.findFirst({
      where: { id: Number(ids.bankAccountId), companyId }, select: { inactiveAt: true, name: true },
    });
    if (!bank) fail('Conta bancária não encontrada', 'bankAccountId');
    if (bank.inactiveAt) fail(`A conta bancária ${bank.name} está inativa`, 'bankAccountId');
  }
}
