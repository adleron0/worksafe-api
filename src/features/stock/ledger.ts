import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, Stock_Movement } from '@prisma/client';
import {
  HOLDERS, Holder, HolderType, IN_USE, MovementType, Tx, UnitStatus, addDays, addMonthsIso, d, fail, iso, num, round2, round3, round4, today,
} from './stock.rules';

/**
 * O livro-razão do estoque. Toda alteração de saldo passa por `postMovement`:
 * cada linha tira de uma posição e põe em outra, na mesma transação, com uma
 * trava por empresa (nada de duas saídas do mesmo item passarem juntas).
 *
 * - entrada de fora (externo → posição) com custo recalcula o custo médio;
 * - as demais linhas usam o custo médio do momento, salvo custo informado;
 * - saldo nunca fica negativo;
 * - peça por unidade anda junto: posição, situação e primeiro uso;
 * - peça que vai "em uso" (obra, funcionário, locação) precisa estar liberada.
 */
export interface LedgerLine {
  itemId: number;
  lotId?: number | null;
  unitId?: number | null;
  quantity: number;
  from: Holder;
  to: Holder;
  /** custo unitário informado (entrada, ou retorno pelo custo da saída); sem ele, o médio */
  unitCost?: number | null;
  chargedToOrder?: boolean;
  condition?: string | null;
  note?: string | null;
  /** situação da unidade ao chegar num local (padrão: disponível; em inspeção se exige inspeção) */
  unitStatus?: UnitStatus;
}
export interface LedgerInput {
  companyId: number;
  type: MovementType;
  date: string;
  userId?: number | null;
  note?: string | null;
  purchaseOrderId?: number | null;
  serviceOrderId?: number | null;
  employeeId?: number | null;
  rentalId?: number | null;
  supplierId?: number | null;
  countId?: number | null;
  costCenterId?: number | null;
  reversesId?: number | null;
  reason?: string | null;
  signature?: Prisma.InputJsonValue | null;
  attachments?: Prisma.InputJsonValue | null;
  lines: LedgerLine[];
  /** pula a conferência de peça liberada (devolução, estorno, baixa) */
  skipUsableCheck?: boolean;
}

const HOLDER_LABEL: Record<string, string> = { local: 'local', os: 'obra', funcionario: 'funcionário', locacao: 'locação', fornecedor: 'fornecedor' };
const internal = (type: HolderType) => (HOLDERS as readonly string[]).includes(type);

/** Nome legível de uma posição, para mensagens de erro e listas. */
export async function holderNames(tx: Tx | Prisma.TransactionClient, companyId: number, holders: Holder[]): Promise<Map<string, string>> {
  const ids = (type: HolderType) => [...new Set(holders.filter((h) => h.type === type && h.id).map((h) => h.id as number))];
  const [locations, orders, employees, rentals, suppliers] = await Promise.all([
    ids('local').length ? tx.stock_Location.findMany({ where: { id: { in: ids('local') }, companyId }, select: { id: true, name: true } }) : [],
    ids('os').length ? tx.service_Order.findMany({ where: { id: { in: ids('os') }, companyId }, select: { id: true, number: true } }) : [],
    ids('funcionario').length ? tx.hr_Employee.findMany({ where: { id: { in: ids('funcionario') }, companyId }, select: { id: true, name: true } }) : [],
    ids('locacao').length ? tx.stock_Rental.findMany({ where: { id: { in: ids('locacao') }, companyId }, select: { id: true, number: true } }) : [],
    ids('fornecedor').length ? tx.financial_Supplier.findMany({ where: { id: { in: ids('fornecedor') }, companyId }, select: { id: true, name: true } }) : [],
  ]);
  const map = new Map<string, string>();
  for (const l of locations) map.set(`local:${l.id}`, l.name);
  for (const o of orders) map.set(`os:${o.id}`, o.number);
  for (const e of employees) map.set(`funcionario:${e.id}`, e.name);
  for (const r of rentals) map.set(`locacao:${r.id}`, r.number);
  for (const s of suppliers) map.set(`fornecedor:${s.id}`, s.name);
  return map;
}
export const holderKey = (h: { type: string; id: number | null }) => `${h.type}:${h.id ?? ''}`;

/** Confere que a posição existe na empresa e pode receber (local ativo, OS aberta...). */
async function assertHolders(tx: Tx, companyId: number, holders: Holder[]) {
  const seen = new Set<string>();
  for (const h of holders) {
    if (h.type === 'externo') continue;
    if (!internal(h.type) || !h.id) fail('Posição de estoque inválida');
    const key = holderKey(h);
    if (seen.has(key)) continue;
    seen.add(key);
    const exists = h.type === 'local' ? await tx.stock_Location.count({ where: { id: h.id!, companyId } })
      : h.type === 'os' ? await tx.service_Order.count({ where: { id: h.id!, companyId, inactiveAt: null } })
        : h.type === 'funcionario' ? await tx.hr_Employee.count({ where: { id: h.id!, companyId } })
          : h.type === 'locacao' ? await tx.stock_Rental.count({ where: { id: h.id!, companyId } })
            : await tx.financial_Supplier.count({ where: { id: h.id!, companyId } });
    if (!exists) fail(`${HOLDER_LABEL[h.type]} não encontrado`);
  }
}

/** Peça (ou lote) pode ir para uso? Devolve o motivo quando não pode. */
export function unitBlockReason(unit: {
  status: string; needsInspection: boolean; nextInspectionAt: Date | null; nextCalibrationAt: Date | null; lifeEndsAt: Date | null; tag: string;
}, item: { requiresInspection: boolean; requiresCalibration: boolean }, now = today()): string | null {
  if (unit.status === 'baixado') return `${unit.tag} foi baixada`;
  if (unit.status === 'bloqueado') return `${unit.tag} está bloqueada`;
  if (unit.status === 'em_inspecao') return `${unit.tag} está esperando inspeção`;
  if (unit.status === 'em_calibracao' || unit.status === 'em_manutencao') return `${unit.tag} está ${unit.status === 'em_calibracao' ? 'em calibração' : 'em manutenção'}`;
  if (unit.needsInspection) return `${unit.tag} precisa de inspeção extraordinária`;
  if (item.requiresInspection && (!unit.nextInspectionAt || d(unit.nextInspectionAt)! < now)) return `${unit.tag} está com a inspeção vencida`;
  if (item.requiresCalibration && (!unit.nextCalibrationAt || d(unit.nextCalibrationAt)! < now)) return `${unit.tag} está com a calibração vencida`;
  if (unit.lifeEndsAt && d(unit.lifeEndsAt)! < now) return `${unit.tag} passou do fim da vida útil`;
  return null;
}

/** Fim da vida útil: da fabricação ou do primeiro uso, conforme o item. */
export function lifeEnd(item: { lifeMonths: number | null; lifeFrom: string }, unit: { manufacturedAt: Date | null; firstUseAt: Date | null }): Date | null {
  if (!item.lifeMonths) return null;
  const base = item.lifeFrom === 'primeiro_uso' ? d(unit.firstUseAt) : d(unit.manufacturedAt);
  return base ? new Date(`${addMonthsIso(base, item.lifeMonths)}T00:00:00.000Z`) : null;
}

/** Saldo de um item numa posição (com ou sem lote). */
export async function balanceOf(tx: Tx, itemId: number, lotId: number | null | undefined, h: Holder): Promise<number> {
  if (!internal(h.type)) return 0;
  const row = await tx.stock_Balance.findUnique({ where: { itemId_lotId_holderType_holderId: { itemId, lotId: lotId ?? 0, holderType: h.type, holderId: h.id! } } });
  return num(row?.quantity);
}

async function addBalance(tx: Tx, companyId: number, itemId: number, lotId: number, h: Holder, delta: number, label: () => Promise<string>) {
  const where = { itemId_lotId_holderType_holderId: { itemId, lotId, holderType: h.type, holderId: h.id! } };
  if (delta < 0) {
    const current = await tx.stock_Balance.findUnique({ where });
    const has = num(current?.quantity);
    if (has + delta < -0.0005) throw new ConflictException(await label().then((name) => `Saldo insuficiente: ${name} tem ${round3(has)}`));
    await tx.stock_Balance.update({ where, data: { quantity: round3(has + delta) } });
    return;
  }
  await tx.stock_Balance.upsert({
    where, create: { companyId, itemId, lotId, holderType: h.type, holderId: h.id!, quantity: round3(delta) },
    update: { quantity: { increment: round3(delta) } },
  });
}

/** Próximo número MOV-AAAA-00001 (chamar dentro da trava). */
async function nextNumber(tx: Tx, companyId: number) {
  const year = Number(today().slice(0, 4));
  const last = await tx.stock_Movement.aggregate({ where: { companyId, year }, _max: { sequence: true } });
  const sequence = (last._max.sequence ?? 0) + 1;
  return { year, sequence, number: `MOV-${year}-${String(sequence).padStart(5, '0')}` };
}

/** Trava do estoque da empresa: serializa as movimentações (volume baixo, sem risco de deadlock). */
export const lockStock = (tx: Tx, companyId: number) => tx.$executeRaw`SELECT pg_advisory_xact_lock(740125::int, ${companyId}::int)`;

export async function postMovement(tx: Tx, input: LedgerInput): Promise<Stock_Movement> {
  if (!input.lines.length) throw new BadRequestException('Informe pelo menos um item');
  if (input.lines.length > 500) throw new BadRequestException('Itens demais numa movimentação');
  await lockStock(tx, input.companyId);
  await assertHolders(tx, input.companyId, input.lines.flatMap((line) => [line.from, line.to]));

  const itemIds = [...new Set(input.lines.map((line) => line.itemId))];
  const items = await tx.stock_Item.findMany({ where: { id: { in: itemIds }, companyId: input.companyId } });
  const itemOf = new Map(items.map((item) => [item.id, item]));
  if (items.length !== itemIds.length) fail('Item do estoque não encontrado');
  const names = await holderNames(tx, input.companyId, input.lines.flatMap((line) => [line.from, line.to]));
  const now = today();

  const prepared: Prisma.Stock_MovementLineCreateManyMovementInput[] = [];
  for (const [index, line] of input.lines.entries()) {
    const item = itemOf.get(line.itemId)!;
    const label = `Linha ${index + 1} (${item.name})`;
    if (line.from.type === 'externo' && line.to.type === 'externo') fail(`${label}: de onde e para onde`);
    if (line.from.type === line.to.type && line.from.id === line.to.id) fail(`${label}: a origem e o destino são o mesmo`);
    const quantity = round3(line.quantity);
    if (!(quantity > 0)) fail(`${label}: informe a quantidade`);
    if (item.inactiveAt && line.to.type !== 'externo') fail(`${item.name} está inativo`);

    // lote
    let lotId: number | null = line.lotId ?? null;
    if (item.tracking === 'lote' && !lotId && !line.unitId) fail(`${label}: escolha o lote`);
    if (item.tracking === 'quantidade') lotId = null;
    if (lotId) {
      const lot = await tx.stock_Lot.findFirst({ where: { id: lotId, itemId: item.id } });
      if (!lot) fail(`${label}: lote não encontrado`);
      if (IN_USE.includes(line.to.type) && !input.skipUsableCheck) {
        if (lot!.status !== 'liberado') fail(`${label}: o lote ${lot!.number} está ${lot!.status}`);
        if (lot!.expiresAt && d(lot!.expiresAt)! < now) fail(`${label}: o lote ${lot!.number} está vencido`);
        if (item.requiresInspection && lot!.nextInspectionAt && d(lot!.nextInspectionAt)! < now) fail(`${label}: o lote ${lot!.number} está com a inspeção vencida`);
      }
    }

    // unidade
    if (item.tracking === 'unidade') {
      if (!line.unitId) fail(`${label}: escolha a peça (etiqueta)`);
      if (quantity !== 1) fail(`${label}: peça rastreada anda uma de cada vez`);
    }
    if (line.unitId) {
      const unit = await tx.stock_Unit.findFirst({ where: { id: line.unitId, itemId: item.id, companyId: input.companyId } });
      if (!unit) fail(`${label}: peça não encontrada`);
      lotId = unit!.lotId ?? lotId;
      const at = { type: unit!.holderType as HolderType, id: unit!.holderId };
      if (line.from.type !== 'externo' && (at.type !== line.from.type || at.id !== line.from.id)) {
        throw new ConflictException(`${unit!.tag} não está em ${names.get(holderKey(line.from)) ?? 'onde a tela mostrou'}: atualize a tela`);
      }
      if (line.from.type === 'externo' && unit!.status !== 'baixado' && (await tx.stock_MovementLine.count({ where: { unitId: unit!.id } })) > 0) {
        throw new ConflictException(`${unit!.tag} já está no estoque`);
      }
      if (IN_USE.includes(line.to.type) && !input.skipUsableCheck) {
        const reason = unitBlockReason(unit!, item, now);
        if (reason) throw new ConflictException(reason);
        if (item.inspectionBeforeUse) {
          const todays = await tx.stock_Inspection.count({ where: { unitId: unit!.id, date: new Date(`${now}T00:00:00.000Z`), result: { not: 'reprovado' } } });
          if (!todays) throw new ConflictException(`${unit!.tag} pede a inspeção antes do uso: registre a de hoje`);
        }
      }
    }

    // custo
    const entering = line.from.type === 'externo' && internal(line.to.type);
    let unitCost = line.unitCost ?? null;
    if (entering && unitCost !== null && unitCost > 0) {
      const all = await tx.stock_Balance.aggregate({ where: { itemId: item.id }, _sum: { quantity: true } });
      const onHand = Math.max(0, num(all._sum.quantity));
      const average = onHand + quantity > 0 ? (onHand * num(item.averageCost) + quantity * unitCost) / (onHand + quantity) : unitCost;
      item.averageCost = new Prisma.Decimal(round4(average));
      await tx.stock_Item.update({ where: { id: item.id }, data: { averageCost: round4(average), lastCost: round4(unitCost) } });
    }
    if (unitCost === null) unitCost = num(item.averageCost);

    // saldos
    const lotKey = lotId ?? 0;
    const describe = async () => `${item.name} em ${names.get(holderKey(line.from)) ?? HOLDER_LABEL[line.from.type] ?? line.from.type}`;
    if (internal(line.from.type)) await addBalance(tx, input.companyId, item.id, lotKey, line.from, -quantity, describe);
    if (internal(line.to.type)) await addBalance(tx, input.companyId, item.id, lotKey, line.to, quantity, describe);

    // a peça anda junto
    if (line.unitId) {
      const unit = (await tx.stock_Unit.findUnique({ where: { id: line.unitId } }))!;
      const data: Prisma.Stock_UnitUncheckedUpdateInput = { holderType: line.to.type, holderId: line.to.id };
      if (line.to.type === 'externo') data.status = 'baixado';
      else if (IN_USE.includes(line.to.type)) {
        data.status = 'em_uso';
        if (!unit.firstUseAt) {
          data.firstUseAt = new Date(`${input.date}T00:00:00.000Z`);
          data.lifeEndsAt = lifeEnd(item, { manufacturedAt: unit.manufacturedAt, firstUseAt: data.firstUseAt as Date });
        }
      } else if (line.to.type === 'fornecedor') data.status = line.unitStatus ?? 'em_manutencao';
      else data.status = line.unitStatus ?? (unit.status === 'baixado' || unit.status === 'em_uso' || unit.status === 'em_calibracao' || unit.status === 'em_manutencao' ? 'disponivel' : unit.status);
      await tx.stock_Unit.update({ where: { id: unit.id }, data });
    }

    prepared.push({
      companyId: input.companyId, itemId: item.id, lotId, unitId: line.unitId ?? null, quantity,
      fromType: line.from.type, fromId: line.from.id, toType: line.to.type, toId: line.to.id,
      unitCost: round4(unitCost), totalCost: round2(quantity * unitCost), chargedToOrder: !!line.chargedToOrder,
      condition: line.condition ?? null, note: line.note ? String(line.note).slice(0, 500) : null,
    });
  }

  const numbering = await nextNumber(tx, input.companyId);
  return tx.stock_Movement.create({
    data: {
      companyId: input.companyId, ...numbering, type: input.type, date: new Date(`${input.date}T00:00:00.000Z`), userId: input.userId || null,
      note: input.note ? String(input.note).slice(0, 1000) : null,
      purchaseOrderId: input.purchaseOrderId ?? null, serviceOrderId: input.serviceOrderId ?? null, employeeId: input.employeeId ?? null,
      rentalId: input.rentalId ?? null, supplierId: input.supplierId ?? null, countId: input.countId ?? null, costCenterId: input.costCenterId ?? null,
      reversesId: input.reversesId ?? null, reason: input.reason ?? null,
      signature: input.signature ?? undefined, attachments: input.attachments ?? undefined,
      lines: { createMany: { data: prepared } },
    },
  });
}

/** Estorno: o caminho inverso de cada linha, ligado à original. */
export async function reverseMovement(tx: Tx, companyId: number, id: number, userId: number, note: string | null) {
  const original = await tx.stock_Movement.findFirst({ where: { id, companyId }, include: { lines: true } });
  if (!original) fail('Movimentação não encontrada');
  if (original!.reversedById) throw new ConflictException(`${original!.number} já foi estornada`);
  if (original!.type === 'estorno') throw new ConflictException('Estorno não se estorna: lance a movimentação de novo');
  const reversal = await postMovement(tx, {
    companyId, type: 'estorno', date: today(), userId, note: note ?? `Estorno de ${original!.number}`, reversesId: original!.id,
    purchaseOrderId: original!.purchaseOrderId, serviceOrderId: original!.serviceOrderId, employeeId: original!.employeeId, rentalId: original!.rentalId,
    skipUsableCheck: true,
    lines: original!.lines.map((line) => ({
      itemId: line.itemId, lotId: line.lotId, unitId: line.unitId, quantity: num(line.quantity),
      from: { type: line.toType as HolderType, id: line.toId }, to: { type: line.fromType as HolderType, id: line.fromId },
      unitCost: num(line.unitCost), chargedToOrder: line.chargedToOrder,
    })),
  });
  await tx.stock_Movement.update({ where: { id: original!.id }, data: { reversedById: reversal.id } });
  // estorno de entrada com custo: o médio volta a ser recalculado pelo que ficou
  for (const itemId of new Set(original!.lines.filter((line) => line.fromType === 'externo').map((line) => line.itemId))) await recomputeAverage(tx, itemId);
  return reversal;
}

/** Recalcula o custo médio de um item a partir das entradas com custo (usado no estorno). */
export async function recomputeAverage(tx: Tx, itemId: number) {
  const lines = await tx.stock_MovementLine.findMany({ where: { itemId, movement: { reversedById: null, type: { not: 'estorno' } } }, orderBy: { id: 'asc' }, select: { fromType: true, toType: true, quantity: true, unitCost: true } });
  let qty = 0, avg = 0;
  for (const line of lines) {
    const q = num(line.quantity);
    const inFrom = line.fromType !== 'externo', inTo = line.toType !== 'externo';
    if (!inFrom && inTo) {
      const c = num(line.unitCost);
      avg = qty + q > 0 && c > 0 ? (qty * avg + q * c) / (qty + q) : avg;
      qty += q;
    } else if (inFrom && !inTo) qty = Math.max(0, qty - q);
  }
  await tx.stock_Item.update({ where: { id: itemId }, data: { averageCost: round4(avg) } });
}

/** Próximo vencimento a partir de uma data, em dias ou meses. */
export const nextDue = (date: string, days?: number | null, months?: number | null) =>
  months ? addMonthsIso(date, months) : days ? addDays(date, days) : null;

export { iso };
