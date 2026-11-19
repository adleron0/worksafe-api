import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Stock_Rental } from '@prisma/client';
import { FlowDefinition, assertMove, listFlowEvents, recordFlowEvent } from 'src/common/flow/flow';
import { PrismaService } from 'src/prisma/prisma.service';
import { LedgerLine, holderKey, holderNames, postMovement, unitBlockReason } from './ledger';
import { signatureOf } from './movement.service';
import {
  Body, HolderType, MOVEMENT_TYPES, MovementType, StockActor, Tx, addDays, asDate, addMonthsIso, blank, clean, d, dateOf, fail, holder, idOf, num, positive, round2, round3, text, today,
} from './stock.rules';

/**
 * Ordem de Locação (OL): equipamento próprio alugado a clientes. Reserva,
 * entrega, devolução com conferência (avaria e falta viram cobrança),
 * caução e encerramento.
 *
 * Toda locação nova nasce de uma proposta de locação aceita (contrato) e é
 * cobrada por medição: cada período vencido, as avarias/faltas e as cobranças
 * avulsas (frete) entram no boletim de medição do contrato (A Faturar). As
 * locações antigas, criadas à mão no estoque, continuam com o "faturar período".
 */
export type RentalStatus = 'reservada' | 'ativa' | 'devolvida' | 'encerrada' | 'cancelada';
export const RENTAL_FLOW: FlowDefinition<RentalStatus> = {
  entity: 'stock_rental',
  labels: { reservada: 'A entregar', ativa: 'Ativa', devolvida: 'Devolvida', encerrada: 'Encerrada', cancelada: 'Cancelada' },
  moves: { reservada: ['ativa', 'cancelada'], ativa: ['devolvida'], devolvida: ['encerrada', 'ativa'], encerrada: ['devolvida'], cancelada: ['reservada'] },
};
/** Etapa da esteira (a situação gravada mais as datas): a entregar, ativa, a devolver, atrasada, devolvida, encerrada. */
export type RentalStage = 'a_entregar' | 'ativa' | 'a_devolver' | 'atrasada' | 'devolvida' | 'encerrada' | 'cancelada';
export const RENTAL_STAGE_LABEL: Record<RentalStage, string> = {
  a_entregar: 'A entregar', ativa: 'Ativa', a_devolver: 'A devolver', atrasada: 'Atrasada', devolvida: 'Devolvida', encerrada: 'Encerrada', cancelada: 'Cancelada',
};
/** Dias antes da devolução prevista em que a OL passa a "a devolver". */
export const RETURN_SOON_DAYS = 7;
export function rentalStage(row: Pick<Stock_Rental, 'status' | 'expectedEnd'>, now = today()): RentalStage {
  if (row.status === 'reservada') return 'a_entregar';
  if (row.status !== 'ativa') return row.status as RentalStage;
  const end = d(row.expectedEnd);
  if (end && end < now) return 'atrasada';
  if (end && end <= addDays(now, RETURN_SOON_DAYS)) return 'a_devolver';
  return 'ativa';
}
export const PERIODS = { dia: 'dia', semana: 'semana', mes: 'mês' } as const;
const PERIODS_PLURAL: Record<string, string> = { dia: 'dias', semana: 'semanas', mes: 'meses' };
const OPEN: RentalStatus[] = ['reservada', 'ativa'];
/** Cobranças avulsas que entram na medição (o aluguel é calculado pelos períodos; a caução tem conta própria). */
const MEASURED_KINDS = ['avaria', 'falta', 'frete', 'avulso', 'abatimento'];
export const CHARGE_LABEL: Record<string, string> = {
  aluguel: 'Aluguel', avaria: 'Avaria', falta: 'Falta', frete: 'Frete', avulso: 'Avulso', caucao: 'Caução', abatimento: 'Caução abatida',
};
const br = (value: string) => value.split('-').reverse().join('/');

/** Fim do período que começa em `start`. */
export function periodEnd(start: string, period: string): string {
  if (period === 'dia') return start;
  if (period === 'semana') return addDays(start, 6);
  return addDays(addMonthsIso(start, 1), -1);
}
/** Último dia de `periods` períodos a partir de `start`. */
export function periodsEnd(start: string, period: string, periods: number): string {
  let end = start;
  for (let i = 0; i < Math.max(1, periods); i++) end = periodEnd(i === 0 ? start : addDays(end, 1), period);
  return end;
}
const daysBetween = (start: string, end: string) => Math.round((asDate(end).getTime() - asDate(start).getTime()) / 86400000) + 1;

/** Termos da locação gravados na proposta (`Commercial_Proposal.rental`). */
export interface RentalTerms {
  period: 'dia' | 'semana' | 'mes';
  periods: number;
  /** sem data de devolução: cobra até devolver (os períodos são só a previsão do orçamento) */
  untilReturn: boolean;
  /** periodo = a cada período vencido; unico = uma vez pelo período contratado */
  billing: 'periodo' | 'unico';
  deposit: number | null;
  deliveryAddress: string | null;
}
export function rentalTermsOf(raw: unknown, fallback?: { period?: unknown; periods?: unknown }): RentalTerms {
  const r = (raw ?? {}) as Body;
  const period = String(r.period ?? fallback?.period ?? 'mes');
  const periods = Math.round(Number(r.periods ?? fallback?.periods ?? 1));
  const deposit = blank(r.deposit) ? null : round2(Number(r.deposit));
  return {
    period: (period in PERIODS ? period : 'mes') as RentalTerms['period'],
    periods: Number.isFinite(periods) && periods >= 1 ? Math.min(periods, 1000) : 1,
    untilReturn: r.untilReturn === true || r.untilReturn === 'true',
    billing: r.billing === 'unico' ? 'unico' : 'periodo',
    deposit: deposit !== null && Number.isFinite(deposit) && deposit > 0 ? deposit : null,
    deliveryAddress: clean(r.deliveryAddress, 300) || null,
  };
}

/** Venda aceita com itens "locação a cliente": nasce a OL a entregar (chamado dentro da transação da venda). */
export async function rentalsFromContract(tx: Tx, contractId: number) {
  const contract = await tx.commercial_Contract.findUnique({ where: { id: contractId }, select: { id: true, companyId: true, proposalId: true, customerId: true, startDate: true, acceptedAt: true, sellerId: true } });
  if (!contract) return null;
  if (await tx.stock_Rental.count({ where: { contractId } })) return null;
  const proposal = await tx.commercial_Proposal.findUnique({ where: { id: contract.proposalId }, select: { rental: true, referenceDate: true, kind: true } });
  const all = await tx.commercial_ProposalItem.findMany({ where: { proposalId: contract.proposalId }, orderBy: [{ order: 'asc' }, { id: 'asc' }] });
  const items = all.filter((item) => item.type === 'locacao_cliente' && item.stockItemId);
  if (!items.length) return null;
  const terms = rentalTermsOf(proposal?.rental, items[0].extra as Body | null);
  const start = d(contract.startDate) ?? (proposal?.referenceDate && d(proposal.referenceDate)! >= d(contract.acceptedAt)! ? d(proposal.referenceDate) : null) ?? d(contract.acceptedAt) ?? today();
  const rental = await createRental(tx, contract.companyId, null, {
    customerId: contract.customerId, contractId: contract.id, proposalId: contract.proposalId, startDate: start,
    expectedEnd: terms.untilReturn ? null : periodsEnd(start, terms.period, terms.periods), period: terms.period, billing: terms.billing,
    periods: terms.untilReturn ? null : terms.periods, deposit: terms.deposit, deliveryAddress: terms.deliveryAddress,
    // valor de cada período por peça: o valor da linha na proposta (já com desconto e preparação) ÷ peças ÷ períodos
    lines: items.map((item) => {
      const periodsOf = Math.max(1, Number((item.extra as Body | null)?.periods ?? terms.periods ?? 1));
      const quantity = Number(item.quantity) || 1;
      // linha antiga sem valor gravado: vale o valor do período digitado
      const rate = Number(item.value) > 0 ? round2(Number(item.value) / quantity / periodsOf) : Number((item.extra as Body | null)?.rate ?? 0);
      return { itemId: item.stockItemId, quantity, rate };
    }),
    notes: 'Criada pela venda',
  }, true);
  // frete, mobilização e outros itens da proposta: cobrança avulsa, entra na primeira medição
  const day = new Date(`${start}T00:00:00.000Z`);
  for (const item of all.filter((i) => i.type !== 'locacao_cliente' && Number(i.value) > 0)) {
    const freight = /frete|transporte|mobiliza|entrega|retirada/i.test(item.description);
    await tx.stock_RentalCharge.create({ data: {
      companyId: contract.companyId, rentalId: rental.id, periodStart: day, periodEnd: day, value: round2(Number(item.value)),
      kind: freight ? 'frete' : 'avulso', description: item.description.slice(0, 255),
    } });
  }
  return rental;
}

/** Uma linha do que está pendente de faturar numa OL (o que a próxima medição leva). */
export interface PendingLine { kind: string; description: string; periodStart: string; periodEnd: string; value: number; chargeId: number | null }
type RentalWithLines = Prisma.Stock_RentalGetPayload<{ include: { lines: true; charges: true } }>;

/**
 * Períodos vencidos de uma OL de contrato até `limit` (hoje, ou a devolução).
 * Por período: cada período fechado; devolvida no meio do período, cobra até a
 * devolução (proporcional). Cobrança única: o período contratado inteiro, assim
 * que entregue; sem data de devolução, tudo de uma vez na devolução. Depois do
 * contratado, segue período a período (prorrogação = continuar faturando).
 */
export function duePeriods(row: Pick<Stock_Rental, 'status' | 'startDate' | 'expectedEnd' | 'returnedAt' | 'billedUntil' | 'billing' | 'period' | 'periods' | 'deliveredAt'> & { lines: Array<{ rate: unknown; quantity: unknown }> }, now = today()): PendingLine[] {
  if (!['ativa', 'devolvida', 'encerrada'].includes(row.status) || !row.deliveredAt) return [];
  const full = round2(row.lines.reduce((s, l) => s + num(l.rate) * num(l.quantity), 0));
  if (full <= 0) return [];
  const limit = d(row.returnedAt) ?? now;
  const out: PendingLine[] = [];
  let start = row.billedUntil ? addDays(d(row.billedUntil)!, 1) : d(row.startDate)!;
  const contracted = d(row.expectedEnd);
  const line = (s: string, e: string, value: number, note = '') => out.push({ kind: 'aluguel', description: `Aluguel de ${br(s)} a ${br(e)}${note}`, periodStart: s, periodEnd: e, value: round2(value), chargeId: null });
  if (row.billing === 'unico' && !row.billedUntil) {
    if (contracted && row.periods) {
      // pagamento único pelo período fechado: sai inteiro na entrega
      line(start, contracted, full * row.periods, ` (${row.periods} ${row.periods === 1 ? PERIODS[row.period as keyof typeof PERIODS] : PERIODS_PLURAL[row.period]}, pagamento único)`);
      start = addDays(contracted, 1);
    } else if (row.returnedAt) {
      // até devolver com pagamento único: soma os períodos usados, de uma vez, na devolução
      let value = 0, s = start;
      while (s <= limit) { const e = periodEnd(s, row.period); value += e <= limit ? full : (full * daysBetween(s, limit)) / daysBetween(s, e); s = addDays(e, 1); }
      line(start, limit, value, ' (pagamento único na devolução)');
      return out;
    } else return [];
  }
  while (start <= limit) {
    const end = periodEnd(start, row.period);
    if (end <= limit) line(start, end, full);
    else if (row.returnedAt) line(start, limit, (full * daysBetween(start, limit)) / daysBetween(start, end), ' (proporcional até a devolução)');
    else break;
    start = addDays(end, 1);
  }
  return out;
}

/** Tudo o que a próxima medição de uma OL de contrato leva: períodos vencidos e cobranças avulsas sem faturar. */
export function pendingLines(row: RentalWithLines, now = today()): PendingLine[] {
  if (!row.contractId || row.status === 'cancelada' || row.status === 'reservada') return [];
  const extras = row.charges
    .filter((c) => !c.financialRecordId && !c.measurementId && MEASURED_KINDS.includes(c.kind))
    .map((c) => ({ kind: c.kind, description: c.description ?? CHARGE_LABEL[c.kind] ?? c.kind, periodStart: d(c.periodStart)!, periodEnd: d(c.periodEnd)!, value: num(c.value), chargeId: c.id }));
  return [...duePeriods(row, now), ...extras];
}

/** Próximo período que ainda vai fechar (para o "aguardando" do A Faturar e o lembrete). */
export function nextOpenPeriod(row: Pick<Stock_Rental, 'status' | 'startDate' | 'expectedEnd' | 'billedUntil' | 'billing' | 'period' | 'periods' | 'deliveredAt'>, now = today()) {
  if (row.status !== 'ativa' || !row.deliveredAt) return null;
  let start = row.billedUntil ? addDays(d(row.billedUntil)!, 1) : d(row.startDate)!;
  if (row.billing === 'unico' && !row.billedUntil) return null;
  for (let guard = 0; guard < 2000; guard++) {
    const end = periodEnd(start, row.period);
    if (end > now) return { start, end };
    start = addDays(end, 1);
  }
  return null;
}

/**
 * Grava na OL o que uma medição faturou: os aluguéis viram cobranças ligadas à
 * medição (com a conta a receber), o "faturado até" anda e as avulsas ficam ligadas.
 */
export async function applyMeasurement(tx: Tx, row: RentalWithLines, lines: PendingLine[], measurementId: number, financialRecordId: number | null) {
  const rents = lines.filter((l) => l.kind === 'aluguel');
  for (const l of rents) {
    await tx.stock_RentalCharge.create({ data: {
      companyId: row.companyId, rentalId: row.id, periodStart: asDate(l.periodStart), periodEnd: asDate(l.periodEnd), value: l.value, kind: 'aluguel',
      description: l.description.slice(0, 255), measurementId, financialRecordId,
    } });
  }
  const ids = lines.map((l) => l.chargeId).filter((x): x is number => !!x);
  if (ids.length) await tx.stock_RentalCharge.updateMany({ where: { id: { in: ids }, rentalId: row.id, measurementId: null }, data: { measurementId, financialRecordId } });
  if (rents.length) {
    const until = rents.map((l) => l.periodEnd).sort().pop()!;
    await tx.stock_Rental.update({ where: { id: row.id }, data: { billedUntil: asDate(until) } });
  }
}

/** Desfaz uma medição na OL: os aluguéis dela somem, o "faturado até" volta e as avulsas voltam a pendentes. */
export async function revertMeasurement(tx: Tx, rentalId: number, measurementId: number) {
  const rents = await tx.stock_RentalCharge.findMany({ where: { rentalId, measurementId, kind: 'aluguel' }, orderBy: { periodStart: 'asc' } });
  await tx.stock_RentalCharge.deleteMany({ where: { rentalId, measurementId, kind: 'aluguel' } });
  await tx.stock_RentalCharge.updateMany({ where: { rentalId, measurementId }, data: { measurementId: null, financialRecordId: null } });
  if (rents.length) {
    const before = await tx.stock_RentalCharge.findFirst({ where: { rentalId, kind: 'aluguel' }, orderBy: { periodEnd: 'desc' } });
    await tx.stock_Rental.update({ where: { id: rentalId }, data: { billedUntil: before ? before.periodEnd : null } });
  }
}

/**
 * Lembretes no acompanhamento comercial: o fim do período em curso (faturar e
 * confirmar se continua) e a devolução prevista (combinar retirada ou
 * prorrogação). Um por data: mudou a data, o antigo é dado como resolvido;
 * a OL saiu de "ativa", todos os pendentes são resolvidos.
 */
export async function syncRentalReminders(tx: Tx, rentalId: number) {
  const row = await tx.stock_Rental.findUnique({ where: { id: rentalId } });
  if (!row) return;
  const pending = await tx.commercial_Activity.findMany({ where: { companyId: row.companyId, rentalId, autoKey: { not: null }, doneAt: null, inactiveAt: null } });
  const wanted: Array<{ key: string; dueDate: string; subject: string }> = [];
  if (row.status === 'ativa' && !row.inactiveAt) {
    const next = nextOpenPeriod(row);
    const contractedUnico = row.billing === 'unico' && !!row.expectedEnd && (!row.billedUntil || d(row.billedUntil)! < d(row.expectedEnd)!);
    if (next && !contractedUnico && (!row.expectedEnd || next.end < d(row.expectedEnd)!)) {
      wanted.push({ key: `ol:${row.id}:periodo:${next.end}`, dueDate: next.end, subject: `Fim do período da ${row.number} (${br(next.end)}): faturar e confirmar se o cliente continua` });
    }
    if (row.expectedEnd) {
      const end = d(row.expectedEnd)!;
      const due = addDays(end, -2) < today() ? end : addDays(end, -2);
      wanted.push({ key: `ol:${row.id}:devolucao:${end}`, dueDate: due, subject: `Devolução prevista da ${row.number} em ${br(end)}: combinar a retirada ou a prorrogação` });
    }
  }
  const keys = new Set(wanted.map((w) => w.key));
  const stale = pending.filter((p) => !keys.has(p.autoKey!));
  if (stale.length) {
    const result = row.status === 'ativa' ? 'Resolvido: a data mudou ou o período foi faturado' : `Resolvido: a locação está ${RENTAL_FLOW.labels[row.status as RentalStatus]?.toLowerCase() ?? row.status}`;
    await tx.commercial_Activity.updateMany({ where: { id: { in: stale.map((p) => p.id) } }, data: { doneAt: new Date(), result } });
  }
  if (!wanted.length) return;
  const contract = row.contractId ? await tx.commercial_Contract.findUnique({ where: { id: row.contractId }, select: { sellerId: true } }) : null;
  for (const w of wanted) {
    const exists = await tx.commercial_Activity.findUnique({ where: { companyId_autoKey: { companyId: row.companyId, autoKey: w.key } } });
    if (exists) continue;
    await tx.commercial_Activity.create({ data: {
      companyId: row.companyId, customerId: row.customerId, proposalId: row.proposalId, rentalId: row.id, autoKey: w.key, type: 'tarefa',
      subject: w.subject.slice(0, 200), dueDate: asDate(w.dueDate), userId: contract?.sellerId ?? row.createdByUserId ?? null,
    } });
  }
}

/** Caução da OL: recebida (conta a receber da entrega) e quanto já foi acertado (abatido ou devolvido). */
async function depositState(db: Tx | PrismaService, row: RentalWithLines) {
  const charge = row.charges.find((c) => c.kind === 'caucao') ?? null;
  if (!charge) return null;
  const value = num(charge.value);
  const abated = -row.charges.filter((c) => c.kind === 'abatimento').reduce((s, c) => s + num(c.value), 0);
  const payable = charge.payableId ? await db.financial_Payable.findUnique({ where: { id: charge.payableId }, select: { id: true, value: true, status: true } }) : null;
  const record = charge.financialRecordId ? await db.financialRecords.findUnique({ where: { id: charge.financialRecordId }, select: { id: true, status: true } }) : null;
  const returned = payable ? num(payable.value) : 0;
  return {
    chargeId: charge.id, value, financialRecordId: charge.financialRecordId, received: record?.status === 'received', abated: round2(abated), returned: round2(returned),
    payableId: payable?.id ?? null, settled: round2(abated + returned) >= value - 0.005, left: round2(Math.max(0, value - abated - returned)),
  };
}

async function createRental(tx: Tx, companyId: number, userId: number | null, body: Body, fromContract = false): Promise<Stock_Rental> {
  const customerId = idOf(body.customerId);
  if (!customerId || !(await tx.customer.count({ where: { id: customerId, companyId } }))) fail('Escolha o cliente');
  const startDate = dateOf(body.startDate, 'Início');
  const expectedEnd = blank(body.expectedEnd) ? null : dateOf(body.expectedEnd, 'Devolução prevista');
  if (expectedEnd && expectedEnd < startDate) fail('A devolução prevista é antes do início');
  const period = String(body.period ?? 'mes') in PERIODS ? String(body.period ?? 'mes') : fail('Período inválido');
  const billing = body.billing === 'unico' ? 'unico' : 'periodo';
  const raws: Body[] = Array.isArray(body.lines) ? body.lines : [];
  if (!raws.length) fail('Escolha o que será alugado');
  const lines: Prisma.Stock_RentalLineCreateManyRentalInput[] = [];
  for (const [index, raw] of raws.entries()) {
    const item = await tx.stock_Item.findFirst({ where: { id: Number(raw.itemId) || 0, companyId } });
    if (!item) fail(`Linha ${index + 1}: item não encontrado`);
    if (!item!.rentable && !fromContract) fail(`${item!.name} não está marcado como alugável`);
    const kit = await tx.stock_KitComponent.findMany({ where: { kitItemId: item!.id }, include: { component: true }, orderBy: [{ order: 'asc' }, { id: 'asc' }] });
    if (kit.length) {
      // kit não tem saldo: sai e volta peça a peça; o valor do período é repartido pelo valor de cada componente
      const quantity = positive(raw.quantity ?? 1, `Linha ${index + 1}`);
      const worth = kit.map((k) => num(k.quantity) * (num(k.component.replacementValue) || num(k.component.averageCost) || num(k.component.lastCost) || 1));
      const total = worth.reduce((sum, w) => sum + w, 0) || 1;
      const rate = Math.max(0, Number(raw.rate) || 0);
      let left = round2(rate * quantity);
      kit.forEach((k, i) => {
        const componentQuantity = round3(num(k.quantity) * quantity);
        const lineTotal = i === kit.length - 1 ? left : round2((rate * quantity * worth[i]) / total);
        left = round2(left - lineTotal);
        lines.push({ itemId: k.componentId, quantity: componentQuantity, rate: componentQuantity > 0 ? round2(lineTotal / componentQuantity) : 0, note: `Do kit ${item!.name}` });
      });
      continue;
    }
    const unitId = idOf(raw.unitId);
    if (unitId && !(await tx.stock_Unit.count({ where: { id: unitId, itemId: item!.id, status: { not: 'baixado' } } }))) fail(`Linha ${index + 1}: peça não encontrada`);
    lines.push({ itemId: item!.id, unitId, lotId: idOf(raw.lotId), quantity: unitId ? 1 : positive(raw.quantity ?? 1, `Linha ${index + 1}`), rate: round2(Math.max(0, Number(raw.rate) || 0)) });
  }
  await assertAvailable(tx, companyId, lines.filter((l) => l.unitId).map((l) => l.unitId!), startDate, expectedEnd, null);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(740126::int, ${companyId}::int)`;
  const year = Number(today().slice(0, 4));
  const last = await tx.stock_Rental.aggregate({ where: { companyId, year }, _max: { sequence: true } });
  const sequence = (last._max.sequence ?? 0) + 1;
  const rental = await tx.stock_Rental.create({ data: {
    companyId, number: `OL-${year}-${String(sequence).padStart(4, '0')}`, year, sequence, customerId: customerId!,
    contractId: idOf(body.contractId), proposalId: idOf(body.proposalId), serviceOrderId: idOf(body.serviceOrderId), status: 'reservada',
    startDate: new Date(`${startDate}T00:00:00.000Z`), expectedEnd: expectedEnd ? new Date(`${expectedEnd}T00:00:00.000Z`) : null, billing, period,
    periods: fromContract && Number(body.periods) >= 1 ? Math.round(Number(body.periods)) : null,
    deliveryAddress: clean(body.deliveryAddress, 300) || null, responsibleName: clean(body.responsibleName, 160) || null, terms: text(body.terms, 5000) || null,
    deposit: blank(body.deposit) ? null : round2(Number(body.deposit)), notes: text(body.notes, 1000) || null, createdByUserId: userId,
    lines: { createMany: { data: lines } },
  } });
  await recordFlowEvent(tx, RENTAL_FLOW.entity, { companyId, entityId: rental.id, type: 'criado', to: 'reservada', userId });
  return rental;
}

/** Peça já reservada ou alugada em outra locação no mesmo período? */
async function assertAvailable(tx: Tx | PrismaService, companyId: number, unitIds: number[], start: string, end: string | null, exceptRentalId: number | null) {
  if (!unitIds.length) return;
  const clash = await tx.stock_RentalLine.findMany({
    where: {
      unitId: { in: unitIds },
      rental: {
        companyId, status: { in: OPEN }, inactiveAt: null, ...(exceptRentalId ? { NOT: { id: exceptRentalId } } : {}),
        ...(end ? { startDate: { lte: new Date(`${end}T00:00:00.000Z`) } } : {}),
        OR: [{ expectedEnd: null }, { expectedEnd: { gte: new Date(`${start}T00:00:00.000Z`) } }],
      },
    },
    include: { rental: { select: { number: true } } },
  });
  const open = clash.filter((line) => num(line.returnedQuantity) < num(line.quantity));
  if (open.length) {
    const units = await tx.stock_Unit.findMany({ where: { id: { in: open.map((l) => l.unitId!) } }, select: { id: true, tag: true } });
    const tagOf = new Map(units.map((u) => [u.id, u.tag]));
    throw new ConflictException(`Peça já reservada no período: ${open.map((l) => `${tagOf.get(l.unitId!)} (${l.rental.number})`).join(', ')}`);
  }
}

@Injectable()
export class StockRentalService {
  constructor(private readonly prisma: PrismaService) {}

  private async byId(companyId: number, id: number) {
    const row = await this.prisma.stock_Rental.findFirst({ where: { id, companyId, inactiveAt: null }, include: { lines: { orderBy: { id: 'asc' } }, charges: { orderBy: { periodStart: 'asc' } } } });
    if (!row) throw new NotFoundException('Locação não encontrada');
    return row;
  }

  private late(row: Pick<Stock_Rental, 'status' | 'expectedEnd'>) {
    return row.status === 'ativa' && !!row.expectedEnd && d(row.expectedEnd)! < today();
  }

  /** Próximo período a cobrar (até hoje ou até a devolução). */
  private nextPeriod(row: Pick<Stock_Rental, 'billedUntil' | 'startDate' | 'period' | 'returnedAt' | 'status' | 'billing' | 'contractId'>) {
    if (row.contractId || row.status === 'reservada' || row.status === 'cancelada') return null;
    const start = row.billedUntil ? addDays(d(row.billedUntil)!, 1) : d(row.startDate)!;
    const limit = d(row.returnedAt) ?? today();
    if (start > limit) return null;
    if (row.billing === 'unico') return row.billedUntil ? null : { start, end: limit };
    const end = periodEnd(start, row.period);
    // período fechado, ou devolvida antes do fim do período (cobra até a devolução)
    if (end <= limit) return { start, end };
    if (row.returnedAt) return { start, end: limit };
    return null;
  }

  async list(actor: StockActor, query: Record<string, string>) {
    const term = clean(query.search, 80);
    const customerIds = term ? (await this.prisma.customer.findMany({ where: { companyId: actor.companyId, name: { contains: term, mode: 'insensitive' } }, select: { id: true }, take: 200 })).map((c) => c.id) : [];
    const stageFilter = query.stage && query.stage in RENTAL_STAGE_LABEL ? (query.stage as RentalStage) : null;
    const status = stageFilter ? ({ a_entregar: 'reservada', ativa: 'ativa', a_devolver: 'ativa', atrasada: 'ativa' } as Record<string, string>)[stageFilter] ?? stageFilter : query.status;
    const where: Prisma.Stock_RentalWhereInput = {
      companyId: actor.companyId, inactiveAt: null,
      ...(status && status in RENTAL_FLOW.labels ? { status } : status === 'todas' ? {} : { status: { not: 'cancelada' } }),
      ...(term ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { customerId: { in: customerIds } }] } : {}),
    };
    const found = await this.prisma.stock_Rental.findMany({ where, orderBy: { id: 'desc' }, take: Math.min(300, Number(query.limit) || 200), include: { lines: true, charges: true } });
    const rows = stageFilter ? found.filter((r) => rentalStage(r) === stageFilter) : found;
    const [customers, items, contracts] = await Promise.all([
      this.prisma.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId) } }, select: { id: true, name: true } }),
      this.prisma.stock_Item.findMany({ where: { id: { in: rows.flatMap((r) => r.lines.map((l) => l.itemId)) } }, select: { id: true, name: true } }),
      this.prisma.commercial_Contract.findMany({ where: { id: { in: rows.map((r) => r.contractId).filter((x): x is number => !!x) } }, select: { id: true, number: true } }),
    ]);
    const customerOf = new Map(customers.map((c) => [c.id, c.name])), itemOf = new Map(items.map((i) => [i.id, i.name])), contractOf = new Map(contracts.map((c) => [c.id, c.number]));
    // a esteira conta por etapa (que depende das datas), não pela situação gravada
    const open = await this.prisma.stock_Rental.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, select: { status: true, expectedEnd: true } });
    const summary: Record<string, number> = {};
    for (const r of open) { const stage = rentalStage(r); summary[stage] = (summary[stage] ?? 0) + 1; }
    return {
      summary,
      rows: rows.map((r) => {
        const pending = r.contractId ? pendingLines(r) : [];
        return {
          id: r.id, number: r.number, status: r.status, statusLabel: RENTAL_FLOW.labels[r.status as RentalStatus], stage: rentalStage(r), stageLabel: RENTAL_STAGE_LABEL[rentalStage(r)],
          customer: customerOf.get(r.customerId) ?? '', customerId: r.customerId, contract: r.contractId ? { id: r.contractId, number: contractOf.get(r.contractId) ?? '' } : null,
          startDate: d(r.startDate), expectedEnd: d(r.expectedEnd), returnedAt: d(r.returnedAt), period: r.period, billing: r.billing, late: this.late(r), fromContract: !!r.contractId,
          summary: r.lines.slice(0, 3).map((l) => `${round3(num(l.quantity))} ${itemOf.get(l.itemId) ?? ''}`).join(', ') + (r.lines.length > 3 ? ` e mais ${r.lines.length - 3}` : ''),
          ratePerPeriod: round2(r.lines.reduce((s, l) => s + num(l.rate) * num(l.quantity), 0)),
          billed: round2(r.charges.filter((c) => c.kind !== 'caucao' && (c.financialRecordId || c.measurementId)).reduce((s, c) => s + num(c.value), 0)),
          toBill: r.contractId ? pending.length > 0 : !!this.nextPeriod(r), pendingValue: round2(pending.reduce((s, l) => s + l.value, 0)),
          deposit: r.deposit === null ? null : num(r.deposit),
        };
      }),
    };
  }

  async get(actor: StockActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    const [customer, items, units, movements, events, contract, order, records, measurements, reminders] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: row.customerId }, select: { id: true, name: true } }),
      this.prisma.stock_Item.findMany({ where: { id: { in: row.lines.map((l) => l.itemId) } }, select: { id: true, code: true, name: true, unit: true, tracking: true, replacementValue: true } }),
      this.prisma.stock_Unit.findMany({ where: { id: { in: row.lines.map((l) => l.unitId).filter((x): x is number => !!x) } }, select: { id: true, tag: true, holderType: true, holderId: true, status: true } }),
      this.prisma.stock_Movement.findMany({ where: { companyId: actor.companyId, rentalId: id }, orderBy: { id: 'desc' }, select: { id: true, number: true, type: true, date: true, reversedById: true, signature: true } }),
      listFlowEvents(this.prisma, RENTAL_FLOW.entity, id),
      row.contractId ? this.prisma.commercial_Contract.findUnique({ where: { id: row.contractId }, select: { id: true, number: true, title: true, billingMode: true, status: true } }) : null,
      row.serviceOrderId ? this.prisma.service_Order.findUnique({ where: { id: row.serviceOrderId }, select: { id: true, number: true } }) : null,
      this.prisma.financialRecords.findMany({ where: { id: { in: row.charges.map((c) => c.financialRecordId).filter((x): x is number => !!x) } }, select: { id: true, status: true, dueDate: true } }),
      this.prisma.commercial_Measurement.findMany({ where: { rentalId: id, status: { not: 'cancelada' } }, orderBy: { number: 'asc' } }),
      this.prisma.commercial_Activity.findMany({ where: { companyId: actor.companyId, rentalId: id, doneAt: null, inactiveAt: null }, orderBy: { dueDate: 'asc' }, select: { id: true, subject: true, dueDate: true } }),
    ]);
    const itemOf = new Map(items.map((i) => [i.id, i])), unitOf = new Map(units.map((u) => [u.id, u])), recordOf = new Map(records.map((r) => [r.id, r]));
    const mRecords = await this.prisma.financialRecords.findMany({ where: { id: { in: measurements.map((m) => m.financialRecordId).filter((x): x is number => !!x) } }, select: { id: true, status: true, dueDate: true } });
    const mRecordOf = new Map(mRecords.map((r) => [r.id, r]));
    const names = await holderNames(this.prisma, actor.companyId, units.map((u) => ({ type: u.holderType as HolderType, id: u.holderId })));
    const userIds = events.map((e) => e.userId).filter((x): x is number => !!x);
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const userOf = new Map(users.map((u) => [u.id, u.name]));
    const next = this.nextPeriod(row);
    const pending = pendingLines(row);
    const stage = rentalStage(row);
    return {
      id: row.id, number: row.number, status: row.status, statusLabel: RENTAL_FLOW.labels[row.status as RentalStatus], nextStatuses: RENTAL_FLOW.moves[row.status as RentalStatus],
      stage, stageLabel: RENTAL_STAGE_LABEL[stage],
      customer, contract, serviceOrder: order, proposalId: row.proposalId, startDate: d(row.startDate), expectedEnd: d(row.expectedEnd), deliveredAt: d(row.deliveredAt), returnedAt: d(row.returnedAt),
      billing: row.billing, period: row.period, periodLabel: PERIODS[row.period as keyof typeof PERIODS], periods: row.periods, billedUntil: d(row.billedUntil), deliveryAddress: row.deliveryAddress,
      responsibleName: row.responsibleName, terms: row.terms, deposit: row.deposit === null ? null : num(row.deposit), notes: row.notes, statusNote: row.statusNote, late: this.late(row),
      lines: row.lines.map((l) => {
        const unit = l.unitId ? unitOf.get(l.unitId) : null;
        return {
          id: l.id, itemId: l.itemId, item: itemOf.get(l.itemId)?.name ?? '', code: itemOf.get(l.itemId)?.code ?? '', unit: itemOf.get(l.itemId)?.unit ?? '', tracking: itemOf.get(l.itemId)?.tracking ?? 'quantidade',
          unitId: l.unitId, tag: unit?.tag ?? null, where: unit ? (unit.holderType === 'externo' ? '—' : names.get(holderKey({ type: unit.holderType, id: unit.holderId })) ?? '—') : null,
          lotId: l.lotId, quantity: num(l.quantity), rate: num(l.rate), deliveredQuantity: num(l.deliveredQuantity), returnedQuantity: num(l.returnedQuantity),
          condition: l.condition, damageValue: l.damageValue === null ? null : num(l.damageValue), replacementValue: itemOf.get(l.itemId)?.replacementValue === null ? null : num(itemOf.get(l.itemId)?.replacementValue),
        };
      }),
      ratePerPeriod: round2(row.lines.reduce((s, l) => s + num(l.rate) * num(l.quantity), 0)),
      charges: row.charges.map((c) => ({
        id: c.id, kind: c.kind, kindLabel: CHARGE_LABEL[c.kind] ?? c.kind, periodStart: d(c.periodStart), periodEnd: d(c.periodEnd), value: num(c.value), description: c.description,
        financialRecordId: c.financialRecordId, measurementId: c.measurementId, recordStatus: c.financialRecordId ? recordOf.get(c.financialRecordId)?.status ?? null : null,
      })),
      nextPeriod: next, fromContract: !!row.contractId,
      // OL de contrato: o que a próxima medição leva, as medições feitas, a caução e o período que ainda vai fechar
      pending, pendingValue: round2(pending.reduce((s, l) => s + l.value, 0)), openPeriod: nextOpenPeriod(row),
      measurements: measurements.map((m) => ({
        id: m.id, number: m.number, label: `BM-${String(m.number).padStart(2, '0')}`, periodStart: d(m.periodStart), periodEnd: d(m.periodEnd), value: num(m.value), invoiceNumber: m.invoiceNumber,
        financialRecordId: m.financialRecordId, recordStatus: m.financialRecordId ? mRecordOf.get(m.financialRecordId)?.status ?? null : null, dueDate: m.financialRecordId ? d(mRecordOf.get(m.financialRecordId)?.dueDate ?? null) : null,
      })),
      depositState: await depositState(this.prisma, row),
      reminders: reminders.map((r) => ({ id: r.id, subject: r.subject, dueDate: d(r.dueDate) })),
      movements: movements.map((m) => ({ id: m.id, number: m.number, type: m.type, typeLabel: MOVEMENT_TYPES[m.type as MovementType] ?? m.type, date: d(m.date), reversed: !!m.reversedById, signed: !!(m.signature as Body | null)?.key, signedBy: (m.signature as Body | null)?.name ?? null })),
      events: events.map((e) => ({ id: e.id, type: e.type, from: e.fromStage, to: e.toStage, note: e.note, at: e.createdAt, user: e.userId ? userOf.get(e.userId) ?? null : null })),
    };
  }

  /** Locação nova só nasce de proposta aceita: a tela do estoque não cria mais (decisão do dono, 18/11). */
  async create(_actor: StockActor, _body: Body): Promise<never> {
    throw new ConflictException('Toda locação nasce de uma proposta de locação aceita: crie a proposta em Comercial → Propostas (tipo Locação). Ao ser aceita, ela abre a Ordem de Locação.');
  }

  /** Editar enquanto reservada (datas, linhas, condições). */
  async update(actor: StockActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    const data: Prisma.Stock_RentalUncheckedUpdateInput = {};
    if ('expectedEnd' in body) data.expectedEnd = blank(body.expectedEnd) ? null : new Date(`${dateOf(body.expectedEnd, 'Devolução prevista')}T00:00:00.000Z`);
    for (const key of ['deliveryAddress', 'responsibleName'] as const) if (key in body) data[key] = clean(body[key], key === 'deliveryAddress' ? 300 : 160) || null;
    if ('notes' in body) data.notes = text(body.notes, 1000) || null;
    if ('terms' in body) data.terms = text(body.terms, 5000) || null;
    if ('deposit' in body) data.deposit = blank(body.deposit) ? null : round2(Number(body.deposit));
    if (row.status === 'reservada') {
      if ('startDate' in body) data.startDate = new Date(`${dateOf(body.startDate, 'Início')}T00:00:00.000Z`);
      if ('period' in body) data.period = String(body.period) in PERIODS ? String(body.period) : fail('Período inválido');
      if ('billing' in body) data.billing = body.billing === 'unico' ? 'unico' : 'periodo';
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.stock_Rental.update({ where: { id }, data });
      if (row.status === 'reservada' && Array.isArray(body.lines)) {
        const fresh = await tx.stock_Rental.findUniqueOrThrow({ where: { id } });
        const lines: Prisma.Stock_RentalLineCreateManyInput[] = [];
        for (const [index, raw] of (body.lines as Body[]).entries()) {
          const item = await tx.stock_Item.findFirst({ where: { id: Number(raw.itemId) || 0, companyId: actor.companyId } });
          if (!item) fail(`Linha ${index + 1}: item não encontrado`);
          const unitId = idOf(raw.unitId);
          lines.push({ rentalId: id, itemId: item!.id, unitId, lotId: idOf(raw.lotId), quantity: unitId ? 1 : positive(raw.quantity ?? 1, `Linha ${index + 1}`), rate: round2(Math.max(0, Number(raw.rate) || 0)) });
        }
        if (!lines.length) fail('Escolha o que será alugado');
        await assertAvailable(tx, actor.companyId, lines.filter((l) => l.unitId).map((l) => l.unitId!), d(fresh.startDate)!, d(fresh.expectedEnd), id);
        await tx.stock_RentalLine.deleteMany({ where: { rentalId: id } });
        await tx.stock_RentalLine.createMany({ data: lines });
      }
      await syncRentalReminders(tx, id);
    });
    return this.get(actor, id);
  }

  /** Entregar ao cliente: as peças (e quantidades) saem do local para a locação. */
  async deliver(actor: StockActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    assertMove(RENTAL_FLOW, row.status as RentalStatus, 'ativa');
    if (row.status !== 'reservada') throw new ConflictException('Só locação reservada é entregue');
    const date = blank(body.date) ? today() : dateOf(body.date, 'Entrega');
    const locationId = idOf(body.locationId);
    const assign: Record<string, unknown> = body.units && typeof body.units === 'object' ? body.units : {};
    await this.prisma.$transaction(async (tx) => {
      const lines: LedgerLine[] = [];
      for (const line of row.lines) {
        const item = await tx.stock_Item.findUniqueOrThrow({ where: { id: line.itemId } });
        if (item.tracking === 'unidade') {
          const unitId = line.unitId ?? idOf(assign[String(line.id)]);
          if (!unitId) fail(`Escolha a peça de ${item.name}`);
          const unit = await tx.stock_Unit.findFirst({ where: { id: unitId!, itemId: item.id, companyId: actor.companyId } });
          if (!unit) fail(`Peça de ${item.name} não encontrada`);
          if (unit!.holderType !== 'local') throw new ConflictException(`${unit!.tag} não está no estoque`);
          const reason = unitBlockReason(unit!, item);
          if (reason) throw new ConflictException(reason);
          if (!line.unitId) await tx.stock_RentalLine.update({ where: { id: line.id }, data: { unitId } });
          lines.push({ itemId: item.id, unitId, quantity: 1, from: holder('local', unit!.holderId), to: holder('locacao', row.id) });
        } else {
          if (!locationId) fail('Escolha de qual local sai');
          lines.push({ itemId: item.id, lotId: line.lotId, quantity: num(line.quantity), from: holder('local', locationId), to: holder('locacao', row.id) });
        }
        await tx.stock_RentalLine.update({ where: { id: line.id }, data: { deliveredQuantity: line.quantity } });
      }
      await postMovement(tx, { companyId: actor.companyId, type: 'saida_locacao', date, userId: actor.userId, rentalId: row.id, serviceOrderId: row.serviceOrderId, note: text(body.note, 1000) || null, signature: signatureOf(body), lines });
      // OL de contrato: o período conta da entrega (a devolução prevista anda junto)
      const dates = row.contractId && !row.billedUntil
        ? { startDate: asDate(date), expectedEnd: row.periods ? asDate(periodsEnd(date, row.period, row.periods)) : row.expectedEnd }
        : {};
      const moved = await tx.stock_Rental.updateMany({ where: { id, status: 'reservada' }, data: { status: 'ativa', deliveredAt: new Date(`${date}T00:00:00.000Z`), ...dates } });
      if (!moved.count) throw new ConflictException('A locação já mudou de etapa: atualize a tela');
      await recordFlowEvent(tx, RENTAL_FLOW.entity, { companyId: actor.companyId, entityId: id, type: 'avancou', from: 'reservada', to: 'ativa', userId: actor.userId, note: text(body.note, 500) || null });
      // frete e avulsos da venda contam da entrega
      if (row.contractId) await tx.stock_RentalCharge.updateMany({ where: { rentalId: id, kind: { in: ['frete', 'avulso'] }, measurementId: null, financialRecordId: null }, data: { periodStart: asDate(date), periodEnd: asDate(date) } });
      // caução combinada: vira conta a receber na entrega (não é receita: fica fora da medição e da comissão)
      if (row.contractId && num(row.deposit) > 0 && !row.charges.some((c) => c.kind === 'caucao')) {
        const record = await tx.financialRecords.create({ data: {
          companyId: actor.companyId, customerId: row.customerId, description: `Caução da ${row.number}`, value: round2(num(row.deposit)),
          dueDate: new Date(`${date}T12:00:00.000Z`), accrualDate: date.slice(0, 7), gateway: 'manual', status: 'waiting', paymentMethod: 'pix',
          observations: `Caução da ${row.number} (devolvida ou abatida no fim da locação)`,
        } });
        await tx.stock_RentalCharge.create({ data: {
          companyId: actor.companyId, rentalId: id, periodStart: asDate(date), periodEnd: asDate(date), value: round2(num(row.deposit)), kind: 'caucao',
          description: `Caução da ${row.number}`, financialRecordId: record.id,
        } });
      }
      await syncRentalReminders(tx, id);
    });
    return this.get(actor, id);
  }

  /**
   * Receber de volta: por linha, quanto voltou e em que condição. Avaria e falta
   * viram cobrança. Tudo devolvido → "devolvida".
   */
  async receiveBack(actor: StockActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    if (row.status !== 'ativa') throw new ConflictException('Só locação ativa recebe devolução');
    const date = blank(body.date) ? today() : dateOf(body.date, 'Devolução');
    const locationId = idOf(body.locationId);
    if (!locationId) fail('Escolha para qual local volta');
    const raws: Body[] = Array.isArray(body.lines) ? body.lines : [];
    if (!raws.length) fail('Informe o que voltou');
    await this.prisma.$transaction(async (tx) => {
      const lines: LedgerLine[] = [];
      const damages: Array<{ value: number; description: string; kind: string }> = [];
      for (const raw of raws) {
        const line = row.lines.find((l) => l.id === Number(raw.lineId));
        if (!line) fail('Linha da locação não encontrada');
        const item = await tx.stock_Item.findUniqueOrThrow({ where: { id: line!.itemId } });
        const condition = ['ok', 'sujo', 'avariado', 'faltando'].includes(raw.condition) ? String(raw.condition) : 'ok';
        const pending = round3(num(line!.deliveredQuantity) - num(line!.returnedQuantity));
        const quantity = condition === 'faltando' ? 0 : line!.unitId ? 1 : Math.min(pending, positive(raw.quantity ?? pending, item.name));
        const damage = blank(raw.damageValue) ? (condition === 'faltando' ? num(item.replacementValue) * (line!.unitId ? 1 : pending) : 0) : round2(Number(raw.damageValue));
        if (damage > 0) damages.push({ value: damage, kind: condition === 'faltando' ? 'falta' : 'avaria', description: `${condition === 'faltando' ? 'Falta' : 'Avaria'}: ${item.name}${raw.note ? ` (${clean(raw.note, 120)})` : ''}` });
        if (quantity > 0) {
          lines.push({
            itemId: item.id, unitId: line!.unitId, lotId: line!.lotId, quantity, from: holder('locacao', row.id), to: holder('local', locationId), condition,
            unitStatus: condition === 'avariado' ? 'bloqueado' : item.requiresInspection ? 'em_inspecao' : 'disponivel',
          });
        }
        await tx.stock_RentalLine.update({ where: { id: line!.id }, data: {
          returnedQuantity: condition === 'faltando' ? line!.deliveredQuantity : round3(num(line!.returnedQuantity) + quantity), condition,
          damageValue: damage > 0 ? round2(num(line!.damageValue) + damage) : line!.damageValue, note: clean(raw.note, 500) || line!.note,
        } });
      }
      if (lines.length) await postMovement(tx, { companyId: actor.companyId, type: 'retorno_locacao', date, userId: actor.userId, rentalId: row.id, note: text(body.note, 1000) || null, lines, skipUsableCheck: true });
      for (const damage of damages) {
        // falta ou avaria: cobrança extra, no dia da devolução
        const periodStart = new Date(`${date}T00:00:00.000Z`);
        await tx.stock_RentalCharge.create({ data: { companyId: actor.companyId, rentalId: row.id, periodStart, periodEnd: periodStart, value: damage.value, kind: damage.kind, description: damage.description.slice(0, 255) } });
      }
      const fresh = await tx.stock_RentalLine.findMany({ where: { rentalId: id } });
      if (fresh.every((l) => num(l.returnedQuantity) >= num(l.quantity) - 0.0005)) {
        await tx.stock_Rental.update({ where: { id }, data: { status: 'devolvida', returnedAt: new Date(`${date}T00:00:00.000Z`) } });
        await recordFlowEvent(tx, RENTAL_FLOW.entity, { companyId: actor.companyId, entityId: id, type: 'avancou', from: 'ativa', to: 'devolvida', userId: actor.userId });
      }
      await syncRentalReminders(tx, id);
    });
    return this.get(actor, id);
  }

  /**
   * Faturar: gera a cobrança do próximo período (e as de avaria/falta ainda sem conta)
   * como contas a receber manuais. Locação da venda é cobrada pelas parcelas da venda.
   */
  async bill(actor: StockActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    if (row.contractId) throw new ConflictException('Locação da venda é cobrada pelas parcelas da venda (A Faturar)');
    const dueDate = blank(body.dueDate) ? addDays(today(), 7) : dateOf(body.dueDate, 'Vencimento');
    const method = ['boleto', 'pix', 'transferencia', 'cartaoCredito', 'dinheiro', 'outro'].includes(body.paymentMethod) ? String(body.paymentMethod) : 'boleto';
    const created = await this.prisma.$transaction(async (tx) => {
      const out: number[] = [];
      const record = async (value: number, description: string) => (await tx.financialRecords.create({ data: {
        companyId: actor.companyId, customerId: row.customerId, description: description.slice(0, 255), value, dueDate: new Date(`${dueDate}T12:00:00.000Z`), accrualDate: dueDate.slice(0, 7),
        gateway: 'manual', status: 'waiting', paymentMethod: method as never, observations: `Locação ${row.number}`,
      } })).id;
      const next = this.nextPeriod(row);
      if (next) {
        const fraction = row.billing === 'periodo' && next.end < periodEnd(next.start, row.period)
          ? (new Date(`${next.end}T00:00:00.000Z`).getTime() - new Date(`${next.start}T00:00:00.000Z`).getTime()) / 86400000 + 1 : null;
        const full = row.lines.reduce((s, l) => s + num(l.rate) * num(l.quantity), 0);
        const days = (new Date(`${periodEnd(next.start, row.period)}T00:00:00.000Z`).getTime() - new Date(`${next.start}T00:00:00.000Z`).getTime()) / 86400000 + 1;
        const value = round2(fraction ? (full * fraction) / days : full);
        if (value > 0) {
          const recordId = await record(value, `Locação ${row.number}: ${next.start.split('-').reverse().join('/')} a ${next.end.split('-').reverse().join('/')}`);
          await tx.stock_RentalCharge.create({ data: { companyId: actor.companyId, rentalId: id, periodStart: new Date(`${next.start}T00:00:00.000Z`), periodEnd: new Date(`${next.end}T00:00:00.000Z`), value, kind: 'aluguel', financialRecordId: recordId } });
          out.push(recordId);
        }
        await tx.stock_Rental.update({ where: { id }, data: { billedUntil: new Date(`${next.end}T00:00:00.000Z`) } });
      }
      for (const charge of row.charges.filter((c) => !c.financialRecordId && c.kind !== 'aluguel')) {
        const recordId = await record(num(charge.value), `Locação ${row.number}: ${charge.description ?? charge.kind}`);
        await tx.stock_RentalCharge.update({ where: { id: charge.id }, data: { financialRecordId: recordId } });
        out.push(recordId);
      }
      if (!out.length) fail('Não há período fechado nem cobrança pendente para faturar');
      return out;
    });
    return { created: created.length, rental: await this.get(actor, id) };
  }

  /** Passagens manuais: cancelar (reservada), encerrar (devolvida e tudo cobrado), reabrir. */
  async move(actor: StockActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    const from = row.status as RentalStatus;
    const target = String(body.status) as RentalStatus;
    if (!(target in RENTAL_FLOW.labels)) fail('Etapa inválida');
    if (target === 'ativa' && from === 'reservada') fail('Use "Entregar ao cliente"');
    if (target === 'devolvida' && from === 'ativa') fail('Use "Receber de volta"');
    assertMove(RENTAL_FLOW, from, target);
    const note = clean(body.note, 500) || null;
    if (target === 'cancelada' && !note) fail('Informe o motivo do cancelamento');
    if (target === 'encerrada' && this.nextPeriod(row) && !row.contractId) throw new ConflictException('Ainda há período a faturar');
    if (target === 'encerrada' && row.charges.some((c) => !c.financialRecordId && c.kind !== 'aluguel') && !row.contractId) throw new ConflictException('Há cobrança de avaria/falta sem faturar');
    if (target === 'encerrada' && row.contractId) {
      const pending = pendingLines(row);
      if (pending.length) throw new ConflictException(`Ainda há o que faturar (${pending.length} item(ns)): fature a medição no contrato (Financeiro → A Faturar) antes de encerrar`);
      const deposit = await depositState(this.prisma, row);
      if (deposit && !deposit.settled) throw new ConflictException('Acerte a caução antes de encerrar: abata das avarias ou devolva ao cliente');
    }
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.stock_Rental.updateMany({ where: { id, status: from }, data: { status: target, statusNote: note } });
      if (!moved.count) throw new ConflictException('A locação já mudou de etapa: atualize a tela');
      await recordFlowEvent(tx, RENTAL_FLOW.entity, { companyId: actor.companyId, entityId: id, type: target === 'cancelada' ? 'cancelado' : 'avancou', from, to: target, userId: actor.userId, note });
      await syncRentalReminders(tx, id);
    });
    return this.get(actor, id);
  }

  /**
   * Acertar a caução (OL devolvida): primeiro ela cobre as avarias e faltas
   * ainda sem faturar (vira um abatimento na próxima medição); o que sobrar é
   * devolvido ao cliente (conta a pagar) ou abatido da última fatura.
   */
  async settleDeposit(actor: StockActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    if (!row.contractId) throw new ConflictException('Só a Ordem de Locação de contrato tem caução cobrada pelo sistema');
    if (row.status !== 'devolvida') throw new ConflictException('A caução é acertada depois da devolução');
    const deposit = await depositState(this.prisma, row);
    if (!deposit) throw new ConflictException('Esta locação não tem caução');
    if (deposit.settled) throw new ConflictException('A caução já foi acertada');
    const mode = body.mode === 'abater' ? 'abater' : 'devolver';
    const pending = pendingLines(row);
    const damages = round2(pending.filter((l) => l.kind === 'avaria' || l.kind === 'falta').reduce((s, l) => s + l.value, 0));
    const covered = round2(Math.min(deposit.left, damages));
    const left = round2(deposit.left - covered);
    const pendingTotal = round2(pending.reduce((s, l) => s + l.value, 0));
    if (mode === 'abater' && left > pendingTotal - covered + 0.005) throw new ConflictException(`Não há fatura pendente que comporte o abatimento (${left.toFixed(2)}): devolva a caução ao cliente`);
    const date = today();
    await this.prisma.$transaction(async (tx) => {
      const day = asDate(date);
      if (covered > 0) await tx.stock_RentalCharge.create({ data: { companyId: actor.companyId, rentalId: id, periodStart: day, periodEnd: day, value: -covered, kind: 'abatimento', description: `Caução abatida das avarias e faltas (${row.number})` } });
      if (left > 0 && mode === 'abater') await tx.stock_RentalCharge.create({ data: { companyId: actor.companyId, rentalId: id, periodStart: day, periodEnd: day, value: -left, kind: 'abatimento', description: `Caução abatida da última fatura (${row.number})` } });
      if (left > 0 && mode === 'devolver') {
        const customer = await tx.customer.findUnique({ where: { id: row.customerId }, select: { name: true } });
        const payable = await tx.financial_Payable.create({ data: {
          companyId: actor.companyId, description: `Devolução da caução da ${row.number} — ${customer?.name ?? 'cliente'}`.slice(0, 255), value: left,
          dueDate: new Date(`${blank(body.dueDate) ? addDays(date, 5) : dateOf(body.dueDate, 'Vencimento')}T12:00:00.000Z`), accrualDate: date.slice(0, 7),
          origin: 'locacao', status: 'aberta', paymentMethod: 'pix',
        } });
        await tx.stock_RentalCharge.update({ where: { id: deposit.chargeId }, data: { payableId: payable.id } });
      }
      await recordFlowEvent(tx, RENTAL_FLOW.entity, { companyId: actor.companyId, entityId: id, type: 'avancou', from: 'devolvida', to: 'devolvida', userId: actor.userId,
        note: `Caução acertada: ${covered > 0 ? `${covered.toFixed(2)} abatido das avarias` : ''}${covered > 0 && left > 0 ? '; ' : ''}${left > 0 ? `${left.toFixed(2)} ${mode === 'abater' ? 'abatido da fatura' : 'devolvido ao cliente'}` : ''}` });
    });
    return this.get(actor, id);
  }

  /** Disponibilidade: por peça alugável, as barras de locação, obra e serviço no período. */
  async availability(actor: StockActor, query: Record<string, string>) {
    const from = blank(query.from) ? today() : dateOf(query.from, 'De');
    const to = blank(query.to) ? addDays(from, 60) : dateOf(query.to, 'Até');
    const units = await this.prisma.stock_Unit.findMany({ where: { companyId: actor.companyId, status: { not: 'baixado' }, item: { rentable: true }, ...(idOf(query.itemId) ? { itemId: idOf(query.itemId)! } : {}) }, include: { item: true }, orderBy: { tag: 'asc' } });
    const lines = await this.prisma.stock_RentalLine.findMany({
      where: { unitId: { in: units.map((u) => u.id) }, rental: { companyId: actor.companyId, status: { in: ['reservada', 'ativa'] }, inactiveAt: null, startDate: { lte: new Date(`${to}T00:00:00.000Z`) } } },
      include: { rental: { select: { id: true, number: true, status: true, startDate: true, expectedEnd: true, customerId: true } } },
    });
    const customers = await this.prisma.customer.findMany({ where: { id: { in: lines.map((l) => l.rental.customerId) } }, select: { id: true, name: true } });
    const customerOf = new Map(customers.map((c) => [c.id, c.name]));
    const names = await holderNames(this.prisma, actor.companyId, units.map((u) => ({ type: u.holderType as HolderType, id: u.holderId })));
    return {
      from, to,
      rows: units.map((u) => ({
        unitId: u.id, tag: u.tag, item: u.item.name, itemId: u.itemId, status: u.status,
        where: u.holderType === 'externo' ? '—' : names.get(holderKey({ type: u.holderType, id: u.holderId })) ?? '—',
        bars: [
          ...lines.filter((l) => l.unitId === u.id).map((l) => ({ kind: l.rental.status === 'ativa' ? 'locacao' : 'reserva', label: `${l.rental.number} · ${customerOf.get(l.rental.customerId) ?? ''}`, start: d(l.rental.startDate)!, end: d(l.rental.expectedEnd) ?? to, rentalId: l.rental.id })),
          ...(u.holderType === 'os' ? [{ kind: 'obra', label: names.get(holderKey({ type: 'os', id: u.holderId })) ?? 'Obra', start: from, end: to, rentalId: null }] : []),
          ...(['em_calibracao', 'em_manutencao'].includes(u.status) ? [{ kind: 'servico', label: u.status === 'em_calibracao' ? 'Calibração' : 'Manutenção', start: from, end: from, rentalId: null }] : []),
          ...(u.nextCalibrationAt && d(u.nextCalibrationAt)! <= to && u.item.requiresCalibration ? [{ kind: 'vencimento', label: 'Calibração vence', start: d(u.nextCalibrationAt)!, end: d(u.nextCalibrationAt)!, rentalId: null }] : []),
        ],
      })),
    };
  }

  async options(actor: StockActor) {
    const [customers, items, locations] = await Promise.all([
      this.prisma.customer.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true }, take: 2000 }),
      this.prisma.stock_Item.findMany({ where: { companyId: actor.companyId, inactiveAt: null, rentable: true }, orderBy: { name: 'asc' }, select: { id: true, code: true, name: true, tracking: true, unit: true, rentDaily: true, rentWeekly: true, rentMonthly: true } }),
      this.prisma.stock_Location.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    const units = await this.prisma.stock_Unit.findMany({ where: { companyId: actor.companyId, itemId: { in: items.map((i) => i.id) }, status: { not: 'baixado' } }, select: { id: true, tag: true, itemId: true, status: true, holderType: true }, orderBy: { tag: 'asc' } });
    return {
      customers, locations,
      items: items.map((i) => ({ id: i.id, name: `${i.code} — ${i.name}`, tracking: i.tracking, unit: i.unit, rent: { dia: i.rentDaily === null ? null : num(i.rentDaily), semana: i.rentWeekly === null ? null : num(i.rentWeekly), mes: i.rentMonthly === null ? null : num(i.rentMonthly) } })),
      units: units.map((u) => ({ id: u.id, name: u.tag, itemId: u.itemId, available: u.status === 'disponivel' && u.holderType === 'local' })),
      periods: Object.entries(PERIODS).map(([id, name]) => ({ id, name })),
    };
  }
}

/**
 * Disponibilidade de itens alugáveis num período (para a proposta de locação):
 * frota (peças ativas, ou saldo em estoque e em locação) menos o que já está
 * reservado ou alugado em OL que cruza o período, menos as peças paradas
 * (bloqueadas, em manutenção ou calibração) e as que estão em obra ou com
 * funcionário. Kit: quantos conjuntos completos os componentes formam.
 */
export async function rentalAvailability(db: Tx | PrismaService, companyId: number, requests: Array<{ itemId: number; quantity: number }>, start: string, end: string | null) {
  if (!requests.length) return [];
  const ids = [...new Set(requests.map((r) => r.itemId))];
  const kits = await db.stock_KitComponent.findMany({ where: { kitItemId: { in: ids } }, include: { component: { select: { id: true, name: true } } } });
  const all = [...new Set([...ids, ...kits.map((k) => k.componentId)])];
  const [items, units, balances, lines] = await Promise.all([
    db.stock_Item.findMany({ where: { companyId, id: { in: all } }, select: { id: true, name: true, tracking: true } }),
    db.stock_Unit.findMany({ where: { companyId, itemId: { in: all }, status: { not: 'baixado' } }, select: { itemId: true, status: true, holderType: true } }),
    db.stock_Balance.findMany({ where: { companyId, itemId: { in: all }, holderType: { in: ['local', 'locacao'] } }, select: { itemId: true, quantity: true } }),
    db.stock_RentalLine.findMany({
      where: {
        itemId: { in: all },
        rental: {
          companyId, status: { in: OPEN }, inactiveAt: null, ...(end ? { startDate: { lte: asDate(end) } } : {}),
          OR: [{ expectedEnd: null }, { expectedEnd: { gte: asDate(start) } }],
        },
      },
      select: { itemId: true, quantity: true, returnedQuantity: true },
    }),
  ]);
  const itemOf = new Map(items.map((i) => [i.id, i]));
  const free = (itemId: number) => {
    const item = itemOf.get(itemId);
    if (!item) return 0;
    const fleet = item.tracking === 'unidade'
      ? units.filter((u) => u.itemId === itemId && !['bloqueado', 'em_manutencao', 'em_calibracao'].includes(u.status) && !['os', 'funcionario', 'fornecedor'].includes(u.holderType)).length
      : balances.filter((b) => b.itemId === itemId).reduce((s, b) => s + num(b.quantity), 0);
    const reserved = lines.filter((l) => l.itemId === itemId).reduce((s, l) => s + Math.max(0, num(l.quantity) - num(l.returnedQuantity)), 0);
    return round3(Math.max(0, fleet - reserved));
  };
  // vários pedidos do mesmo item somam
  const asked = new Map<number, number>();
  for (const r of requests) asked.set(r.itemId, (asked.get(r.itemId) ?? 0) + r.quantity);
  return [...asked.entries()].map(([itemId, requested]) => {
    const parts = kits.filter((k) => k.kitItemId === itemId);
    if (parts.length) {
      const available = Math.floor(Math.min(...parts.map((k) => free(k.componentId) / Math.max(num(k.quantity), 0.001))));
      const short = parts.filter((k) => free(k.componentId) < num(k.quantity) * requested).map((k) => `${k.component.name}: ${free(k.componentId)} de ${round3(num(k.quantity) * requested)}`);
      return { itemId, name: itemOf.get(itemId)?.name ?? '', requested, available, ok: available >= requested, detail: short.length ? `Falta no kit — ${short.join('; ')}` : null };
    }
    const available = free(itemId);
    return { itemId, name: itemOf.get(itemId)?.name ?? '', requested, available, ok: available >= requested - 0.0005, detail: null as string | null };
  });
}
