import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Stock_Rental } from '@prisma/client';
import { FlowDefinition, assertMove, listFlowEvents, recordFlowEvent } from 'src/common/flow/flow';
import { PrismaService } from 'src/prisma/prisma.service';
import { LedgerLine, holderKey, holderNames, postMovement, unitBlockReason } from './ledger';
import { signatureOf } from './movement.service';
import {
  Body, HolderType, MOVEMENT_TYPES, MovementType, StockActor, Tx, addDays, addMonthsIso, blank, clean, d, dateOf, fail, holder, idOf, num, positive, round2, round3, text, today,
} from './stock.rules';

/**
 * Locação de equipamento próprio a clientes: reserva, entrega, cobrança por
 * período, devolução com conferência (avaria e falta viram cobrança) e encerramento.
 * Locação nascida de uma venda é cobrada pelas parcelas da venda; a direta gera
 * contas a receber manuais pelo botão "faturar período".
 */
export type RentalStatus = 'reservada' | 'ativa' | 'devolvida' | 'encerrada' | 'cancelada';
export const RENTAL_FLOW: FlowDefinition<RentalStatus> = {
  entity: 'stock_rental',
  labels: { reservada: 'Reservada', ativa: 'Ativa', devolvida: 'Devolvida', encerrada: 'Encerrada', cancelada: 'Cancelada' },
  moves: { reservada: ['ativa', 'cancelada'], ativa: ['devolvida'], devolvida: ['encerrada', 'ativa'], encerrada: ['devolvida'], cancelada: ['reservada'] },
};
const PERIODS = { dia: 'dia', semana: 'semana', mes: 'mês' } as const;
const OPEN: RentalStatus[] = ['reservada', 'ativa'];

/** Fim do período que começa em `start`. */
export function periodEnd(start: string, period: string): string {
  if (period === 'dia') return start;
  if (period === 'semana') return addDays(start, 6);
  return addDays(addMonthsIso(start, 1), -1);
}

/** Venda aceita com itens "locação a cliente": nasce a locação reservada (chamado dentro da transação da venda). */
export async function rentalsFromContract(tx: Tx, contractId: number) {
  const contract = await tx.commercial_Contract.findUnique({ where: { id: contractId }, select: { id: true, companyId: true, proposalId: true, customerId: true, startDate: true, acceptedAt: true } });
  if (!contract) return null;
  if (await tx.stock_Rental.count({ where: { contractId } })) return null;
  const items = await tx.commercial_ProposalItem.findMany({ where: { proposalId: contract.proposalId, type: 'locacao_cliente', stockItemId: { not: null } }, orderBy: [{ order: 'asc' }, { id: 'asc' }] });
  if (!items.length) return null;
  const extra = (items[0].extra ?? {}) as Body;
  const period = String(extra.period ?? 'mes') in PERIODS ? String(extra.period ?? 'mes') : 'mes';
  const periods = Math.max(1, Number(extra.periods ?? 1));
  const start = d(contract.startDate) ?? d(contract.acceptedAt) ?? today();
  let end = start;
  for (let i = 0; i < periods; i++) end = periodEnd(i === 0 ? start : addDays(end, 1), period);
  return createRental(tx, contract.companyId, null, {
    customerId: contract.customerId, contractId: contract.id, proposalId: contract.proposalId, startDate: start, expectedEnd: end, period, billing: 'periodo',
    // valor de cada período por peça: o valor da linha na proposta (já com desconto e preparação) ÷ peças ÷ períodos
    lines: items.map((item) => {
      const periodsOf = Math.max(1, Number((item.extra as Body | null)?.periods ?? 1));
      const quantity = Number(item.quantity) || 1;
      // linha antiga sem valor gravado: vale o valor do período digitado
      const rate = Number(item.value) > 0 ? round2(Number(item.value) / quantity / periodsOf) : Number((item.extra as Body | null)?.rate ?? 0);
      return { itemId: item.stockItemId, quantity, rate };
    }),
    notes: 'Criada pela venda',
  }, true);
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
    companyId, number: `LOC-${year}-${String(sequence).padStart(4, '0')}`, year, sequence, customerId: customerId!,
    contractId: idOf(body.contractId), proposalId: idOf(body.proposalId), serviceOrderId: idOf(body.serviceOrderId), status: 'reservada',
    startDate: new Date(`${startDate}T00:00:00.000Z`), expectedEnd: expectedEnd ? new Date(`${expectedEnd}T00:00:00.000Z`) : null, billing, period,
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
    const where: Prisma.Stock_RentalWhereInput = {
      companyId: actor.companyId, inactiveAt: null,
      ...(query.status && query.status in RENTAL_FLOW.labels ? { status: query.status } : query.status === 'todas' ? {} : { status: { not: 'cancelada' } }),
      ...(term ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { customerId: { in: customerIds } }] } : {}),
    };
    const rows = await this.prisma.stock_Rental.findMany({ where, orderBy: { id: 'desc' }, take: Math.min(300, Number(query.limit) || 200), include: { lines: true, charges: true } });
    const customers = await this.prisma.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId) } }, select: { id: true, name: true } });
    const items = await this.prisma.stock_Item.findMany({ where: { id: { in: rows.flatMap((r) => r.lines.map((l) => l.itemId)) } }, select: { id: true, name: true } });
    const customerOf = new Map(customers.map((c) => [c.id, c.name])), itemOf = new Map(items.map((i) => [i.id, i.name]));
    const counts = await this.prisma.stock_Rental.groupBy({ by: ['status'], where: { companyId: actor.companyId, inactiveAt: null }, _count: { _all: true } });
    return {
      summary: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      rows: rows.map((r) => ({
        id: r.id, number: r.number, status: r.status, statusLabel: RENTAL_FLOW.labels[r.status as RentalStatus], customer: customerOf.get(r.customerId) ?? '', customerId: r.customerId,
        startDate: d(r.startDate), expectedEnd: d(r.expectedEnd), returnedAt: d(r.returnedAt), period: r.period, late: this.late(r), fromContract: !!r.contractId,
        summary: r.lines.slice(0, 3).map((l) => `${round3(num(l.quantity))} ${itemOf.get(l.itemId) ?? ''}`).join(', ') + (r.lines.length > 3 ? ` e mais ${r.lines.length - 3}` : ''),
        ratePerPeriod: round2(r.lines.reduce((s, l) => s + num(l.rate) * num(l.quantity), 0)), billed: round2(r.charges.reduce((s, c) => s + num(c.value), 0)),
        toBill: !!this.nextPeriod(r),
      })),
    };
  }

  async get(actor: StockActor, id: number) {
    const row = await this.byId(actor.companyId, id);
    const [customer, items, units, movements, events, contract, order, records] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: row.customerId }, select: { id: true, name: true } }),
      this.prisma.stock_Item.findMany({ where: { id: { in: row.lines.map((l) => l.itemId) } }, select: { id: true, code: true, name: true, unit: true, tracking: true, replacementValue: true } }),
      this.prisma.stock_Unit.findMany({ where: { id: { in: row.lines.map((l) => l.unitId).filter((x): x is number => !!x) } }, select: { id: true, tag: true, holderType: true, holderId: true, status: true } }),
      this.prisma.stock_Movement.findMany({ where: { companyId: actor.companyId, rentalId: id }, orderBy: { id: 'desc' }, select: { id: true, number: true, type: true, date: true, reversedById: true, signature: true } }),
      listFlowEvents(this.prisma, RENTAL_FLOW.entity, id),
      row.contractId ? this.prisma.commercial_Contract.findUnique({ where: { id: row.contractId }, select: { id: true, number: true } }) : null,
      row.serviceOrderId ? this.prisma.service_Order.findUnique({ where: { id: row.serviceOrderId }, select: { id: true, number: true } }) : null,
      this.prisma.financialRecords.findMany({ where: { id: { in: row.charges.map((c) => c.financialRecordId).filter((x): x is number => !!x) } }, select: { id: true, status: true, dueDate: true } }),
    ]);
    const itemOf = new Map(items.map((i) => [i.id, i])), unitOf = new Map(units.map((u) => [u.id, u])), recordOf = new Map(records.map((r) => [r.id, r]));
    const names = await holderNames(this.prisma, actor.companyId, units.map((u) => ({ type: u.holderType as HolderType, id: u.holderId })));
    const userIds = events.map((e) => e.userId).filter((x): x is number => !!x);
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const userOf = new Map(users.map((u) => [u.id, u.name]));
    const next = this.nextPeriod(row);
    return {
      id: row.id, number: row.number, status: row.status, statusLabel: RENTAL_FLOW.labels[row.status as RentalStatus], nextStatuses: RENTAL_FLOW.moves[row.status as RentalStatus],
      customer, contract, serviceOrder: order, proposalId: row.proposalId, startDate: d(row.startDate), expectedEnd: d(row.expectedEnd), deliveredAt: d(row.deliveredAt), returnedAt: d(row.returnedAt),
      billing: row.billing, period: row.period, periodLabel: PERIODS[row.period as keyof typeof PERIODS], billedUntil: d(row.billedUntil), deliveryAddress: row.deliveryAddress,
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
      charges: row.charges.map((c) => ({ id: c.id, kind: c.kind, periodStart: d(c.periodStart), periodEnd: d(c.periodEnd), value: num(c.value), description: c.description, financialRecordId: c.financialRecordId, recordStatus: c.financialRecordId ? recordOf.get(c.financialRecordId)?.status ?? null : null })),
      nextPeriod: next, fromContract: !!row.contractId,
      movements: movements.map((m) => ({ id: m.id, number: m.number, type: m.type, typeLabel: MOVEMENT_TYPES[m.type as MovementType] ?? m.type, date: d(m.date), reversed: !!m.reversedById, signed: !!(m.signature as Body | null)?.key, signedBy: (m.signature as Body | null)?.name ?? null })),
      events: events.map((e) => ({ id: e.id, type: e.type, from: e.fromStage, to: e.toStage, note: e.note, at: e.createdAt, user: e.userId ? userOf.get(e.userId) ?? null : null })),
    };
  }

  async create(actor: StockActor, body: Body) {
    const rental = await this.prisma.$transaction((tx) => createRental(tx, actor.companyId, actor.userId, body));
    return this.get(actor, rental.id);
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
      const moved = await tx.stock_Rental.updateMany({ where: { id, status: 'reservada' }, data: { status: 'ativa', deliveredAt: new Date(`${date}T00:00:00.000Z`) } });
      if (!moved.count) throw new ConflictException('A locação já mudou de etapa: atualize a tela');
      await recordFlowEvent(tx, RENTAL_FLOW.entity, { companyId: actor.companyId, entityId: id, type: 'avancou', from: 'reservada', to: 'ativa', userId: actor.userId, note: text(body.note, 500) || null });
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
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.stock_Rental.updateMany({ where: { id, status: from }, data: { status: target, statusNote: note } });
      if (!moved.count) throw new ConflictException('A locação já mudou de etapa: atualize a tela');
      await recordFlowEvent(tx, RENTAL_FLOW.entity, { companyId: actor.companyId, entityId: id, type: target === 'cancelada' ? 'cancelado' : 'avancou', from, to: target, userId: actor.userId, note });
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
