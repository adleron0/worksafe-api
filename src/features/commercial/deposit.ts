import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { classificationDefaults } from 'src/features/financial/classification';
import { commissionFor } from './measurement.service';

/**
 * Caução contratual das parcelas (plano 12): cada nota de parcela retém
 * `depositRate` do valor numa conta a receber única da caução do contrato,
 * que vence `depositReleaseDays` depois do fim da obra. Mesmo mecanismo do
 * boletim de obra (`work.service.ts`).
 */

type Tx = Prisma.TransactionClient;
type DepositContract = Prisma.Commercial_ContractGetPayload<object>;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const noonUtc = (value: string) => new Date(`${value}T12:00:00.000Z`);
const addDays = (value: string, days: number) => { const d = new Date(`${value}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

/** Quanto da nota de uma parcela fica retido como caução. */
export const depositOf = (contract: Pick<DepositContract, 'depositRate'>, value: number) => {
  const rate = Number(contract.depositRate ?? 0);
  return rate > 0 ? round2(value * rate) : 0;
};

async function dueOf(tx: Tx, contract: DepositContract) {
  const order = await tx.service_Order.findUnique({ where: { contractId: contract.id }, select: { plannedEnd: true, finishedAt: true } });
  const end = iso(contract.endDate) ?? iso(order?.finishedAt) ?? iso(order?.plannedEnd) ?? addDays(today(), 180);
  return addDays(end, contract.depositReleaseDays || 0);
}

/** Soma a caução na conta a receber da caução do contrato (cria na primeira vez). */
export async function addDeposit(tx: Tx, contract: DepositContract, amount: number) {
  if (!(amount > 0)) return;
  const fresh = await tx.commercial_Contract.findUniqueOrThrow({ where: { id: contract.id } });
  const current = fresh.depositRecordId ? await tx.financialRecords.findUnique({ where: { id: fresh.depositRecordId } }) : null;
  if (current && !current.inactiveAt && current.status === 'waiting') {
    const total = round2(Number(current.value) + amount);
    await tx.financialRecords.update({ where: { id: current.id }, data: { value: total, ...(await commissionFor(tx, fresh, total)) } });
    return;
  }
  if (current && current.status === 'received') throw new ConflictException('A caução deste contrato já foi recebida: não dá para reter mais');
  const record = await tx.financialRecords.create({ data: {
    companyId: fresh.companyId, gateway: 'manual', status: 'waiting', paymentMethod: 'boleto', customerId: fresh.customerId, sellerId: fresh.sellerId,
    value: amount, ...(await commissionFor(tx, fresh, amount)),
    dueDate: noonUtc(await dueOf(tx, fresh)), accrualDate: today().slice(0, 7),
    description: `${fresh.number} — caução contratual retida nas parcelas · ${fresh.title}`.slice(0, 255),
    observations: 'Caução contratual: liberada no fim da obra', contractId: fresh.id,
    ...(await classificationDefaults(tx, fresh.companyId, 'contrato')),
  } });
  await tx.commercial_Contract.update({ where: { id: fresh.id }, data: { depositRecordId: record.id } });
}

/** Devolve a caução de uma parcela desfeita (cancela a conta da caução quando zera). */
export async function removeDeposit(tx: Tx, contractId: number, amount: number) {
  if (!(amount > 0)) return null;
  const contract = await tx.commercial_Contract.findUniqueOrThrow({ where: { id: contractId } });
  const record = contract.depositRecordId ? await tx.financialRecords.findUnique({ where: { id: contract.depositRecordId } }) : null;
  if (!record || record.inactiveAt) return null;
  if (record.status === 'received') throw new ConflictException('A caução deste contrato já foi recebida: estorne a baixa dela antes');
  const rest = round2(Number(record.value) - amount);
  if (rest > 0.005) await tx.financialRecords.update({ where: { id: record.id }, data: { value: rest, ...(await commissionFor(tx, contract, rest)) } });
  else {
    await tx.financialRecords.update({ where: { id: record.id }, data: { inactiveAt: new Date(), status: 'cancelled' } });
    await tx.commercial_Contract.update({ where: { id: contractId }, data: { depositRecordId: null } });
  }
  return record.id;
}

/** Garante, antes de desfazer, que a caução não foi recebida (sem abrir transação). */
export async function assertDepositOpen(db: Pick<Prisma.TransactionClient, 'commercial_Contract' | 'financialRecords'>, contractId: number) {
  const contract = await db.commercial_Contract.findUnique({ where: { id: contractId }, select: { depositRecordId: true } });
  if (!contract?.depositRecordId) return;
  const record = await db.financialRecords.findUnique({ where: { id: contract.depositRecordId }, select: { status: true } });
  if (record?.status === 'received') throw new ConflictException('A caução deste contrato já foi recebida: estorne a baixa dela antes');
}
