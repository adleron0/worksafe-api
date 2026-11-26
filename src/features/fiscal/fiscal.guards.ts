import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, 'financialRecords' | 'fiscal_Invoice' | 'fiscal_InvoiceLink' | 'financial_Retention'> | Prisma.TransactionClient;

/** Nota feita para um faturamento específico (parcela, boletim, OL): cancelar a nota desfaz esse faturamento. */
const BILLING_ORIGINS = ['installments', 'measurement', 'rental'];
const kindOf = (origin: unknown) => (origin && typeof origin === 'object' ? String((origin as { kind?: unknown }).kind ?? '') : '');
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * Faturamento feito por uma NFS-e autorizada não se desfaz por fora: o certo é
 * cancelar a nota (o cancelamento desfaz o faturamento junto). Parcela cobrada
 * com uma nota do contrato inteiro pode ser desfeita: a nota continua valendo e
 * o saldo dela volta.
 */
export async function assertNoAuthorizedInvoice(db: Db, financialRecordId: number | null | undefined) {
  if (!financialRecordId) return;
  const record = await db.financialRecords.findUnique({ where: { id: financialRecordId }, select: { fiscalInvoiceId: true } });
  if (!record?.fiscalInvoiceId) return;
  const invoice = await db.fiscal_Invoice.findUnique({ where: { id: record.fiscalInvoiceId }, select: { status: true, provider: true, number: true, origin: true } });
  if (invoice?.status === 'autorizada' && invoice.provider === 'sefin' && BILLING_ORIGINS.includes(kindOf(invoice.origin))) {
    throw new ConflictException(`Este faturamento tem a NFS-e nº ${invoice.number} autorizada. Cancele a nota em Financeiro → Notas fiscais: o cancelamento desfaz o faturamento junto.`);
  }
}

/** Quanto de uma nota do contrato já foi usado para cobrar parcelas e boletins (contas a receber ativas). */
export async function coverageUsed(db: Db, invoiceId: number): Promise<number> {
  const links = await db.fiscal_InvoiceLink.findMany({ where: { invoiceId, contractId: null, financialRecordId: { not: null } }, select: { amount: true, financialRecordId: true } });
  if (!links.length) return 0;
  const active = await db.financialRecords.findMany({ where: { id: { in: links.map((l) => l.financialRecordId!) }, inactiveAt: null, status: { not: 'cancelled' } }, select: { id: true } });
  const ids = new Set(active.map((r) => r.id));
  return round2(links.filter((l) => ids.has(l.financialRecordId!)).reduce((s, l) => s + Number(l.amount), 0));
}

/**
 * Nota já emitida do contrato (inteiro, saldo ou valor livre) escolhida ao
 * faturar uma parcela ou boletim: devolve número e data para o faturamento.
 */
export async function coverageInvoice(db: Db, companyId: number, contractId: number, invoiceId: number, amount: number) {
  const invoice = await db.fiscal_Invoice.findFirst({ where: { id: invoiceId, companyId } });
  if (!invoice) throw new NotFoundException('Nota fiscal não encontrada');
  const origin = invoice.origin as { kind?: string; contractId?: number } | null;
  if (invoice.status !== 'autorizada') throw new ConflictException('A nota escolhida não está autorizada');
  if (origin?.kind !== 'contract' || Number(origin.contractId) !== contractId) throw new BadRequestException('A nota escolhida não é deste contrato');
  const total = round2(Number(invoice.grossValue) - Number(invoice.discountValue));
  const left = round2(total - (await coverageUsed(db, invoice.id)));
  if (amount - left > 0.009) throw new ConflictException(`A nota ${invoice.number} tem saldo de R$ ${left.toFixed(2).replace('.', ',')}, menor que este faturamento.`);
  const issued = invoice.issuedAt ? new Date(invoice.issuedAt.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10) : undefined;
  return { id: invoice.id, number: invoice.number ?? String(invoice.id), issuedAt: issued, issuedAtDate: invoice.issuedAt };
}

/** Liga as contas a receber do faturamento à nota do contrato (consome o saldo dela). */
export async function attachToInvoice(db: Db, invoiceId: number, records: Array<{ id: number; amount: number }>, issuedAt?: Date | null) {
  if (!records.length) return;
  const ids = records.map((r) => r.id);
  await db.financialRecords.updateMany({ where: { id: { in: ids } }, data: { fiscalInvoiceId: invoiceId, ...(issuedAt ? { invoiceIssuedAt: issuedAt } : {}) } });
  await db.financial_Retention.updateMany({ where: { financialRecordId: { in: ids } }, data: { fiscalInvoiceId: invoiceId } });
  await db.fiscal_InvoiceLink.createMany({ data: records.map((r) => ({ invoiceId, financialRecordId: r.id, amount: r.amount })) });
}
