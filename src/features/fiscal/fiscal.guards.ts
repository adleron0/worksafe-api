import { ConflictException } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

type Db = Pick<PrismaClient, 'financialRecords' | 'fiscal_Invoice'> | Prisma.TransactionClient;

/**
 * Faturamento com NFS-e autorizada não se desfaz por fora: o certo é cancelar a
 * nota (o cancelamento desfaz o faturamento junto). Usado ao desfaturar parcela,
 * boletim de obra e medição de locação.
 */
export async function assertNoAuthorizedInvoice(db: Db, financialRecordId: number | null | undefined) {
  if (!financialRecordId) return;
  const record = await db.financialRecords.findUnique({ where: { id: financialRecordId }, select: { fiscalInvoiceId: true } });
  if (!record?.fiscalInvoiceId) return;
  const invoice = await db.fiscal_Invoice.findUnique({ where: { id: record.fiscalInvoiceId }, select: { status: true, provider: true, number: true } });
  if (invoice?.status === 'autorizada' && invoice.provider === 'sefin') {
    throw new ConflictException(`Este faturamento tem a NFS-e nº ${invoice.number} autorizada. Cancele a nota em Financeiro → Notas fiscais: o cancelamento desfaz o faturamento junto.`);
  }
}
