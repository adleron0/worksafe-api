import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Stock_Item } from '@prisma/client';
import { ALL_ORDERS_PERMISSION, ordersVisibleTo } from 'src/features/operations/service-order.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { StockCatalogService } from './catalog.service';
import { LedgerLine, holderKey, holderNames, lifeEnd, postMovement, reverseMovement } from './ledger';
import {
  Body, EXTERNAL, Holder, HolderType, MOVEMENT_TYPES, MovementType, PERM, StockActor, Tx, blank, can, clean, d, dateOf, fail, holder, idOf, num,
  optionalDate, positive, round2, round3, round4, text, today,
} from './stock.rules';

/** Tipos que se lançam à mão na tela de Movimentações. */
const MANUAL: Partial<Record<MovementType, { from: HolderType; to: HolderType; permission: string }>> = {
  saldo_inicial: { from: 'externo', to: 'local', permission: PERM.adjust },
  entrada_avulsa: { from: 'externo', to: 'local', permission: PERM.move },
  transferencia: { from: 'local', to: 'local', permission: PERM.move },
  consumo_interno: { from: 'local', to: 'externo', permission: PERM.move },
  ajuste: { from: 'local', to: 'externo', permission: PERM.adjust },
  venda: { from: 'local', to: 'externo', permission: PERM.move },
};
export interface NewUnit { tag?: string | null; serialNumber?: string | null; manufacturedAt?: string | null; length?: number | null }

@Injectable()
export class StockMovementService {
  constructor(private readonly prisma: PrismaService, private readonly catalog: StockCatalogService) {}

  // ------------------------------------------------------------------ peças e lotes novos

  /** Etiqueta sugerida: código do item + sequência (CRD-0001-007). */
  async nextTags(tx: Tx, companyId: number, item: Stock_Item, count: number): Promise<string[]> {
    const existing = await tx.stock_Unit.findMany({ where: { companyId, tag: { startsWith: `${item.code}-` } }, select: { tag: true } });
    let max = existing.reduce((m, u) => Math.max(m, Number(/-(\d+)$/.exec(u.tag)?.[1] ?? 0)), 0);
    return Array.from({ length: count }, () => `${item.code}-${String(++max).padStart(3, '0')}`);
  }

  /** Cria as peças (ainda sem posição: a entrada é que põe no local). */
  async createUnits(tx: Tx, companyId: number, item: Stock_Item, units: NewUnit[], origin: { lotId?: number | null; supplierId?: number | null; purchaseOrderId?: number | null; cost?: number | null; acquiredAt: string }) {
    if (!units.length) fail(`${item.name}: informe as peças (uma linha por peça)`);
    if (units.length > 200) fail('No máximo 200 peças de uma vez');
    const tags = await this.nextTags(tx, companyId, item, units.length);
    const created = [];
    for (const [index, unit] of units.entries()) {
      const tag = clean(unit.tag, 40).toUpperCase() || tags[index];
      if (await tx.stock_Unit.count({ where: { companyId, tag } })) throw new ConflictException(`A etiqueta ${tag} já existe`);
      const manufacturedAt = optionalDate(unit.manufacturedAt, `Fabricação da peça ${index + 1}`);
      created.push(await tx.stock_Unit.create({ data: {
        companyId, itemId: item.id, lotId: origin.lotId ?? null, tag, serialNumber: clean(unit.serialNumber, 80) || null, manufacturedAt,
        acquiredAt: new Date(`${origin.acquiredAt}T00:00:00.000Z`), supplierId: origin.supplierId ?? null, purchaseOrderId: origin.purchaseOrderId ?? null,
        acquisitionCost: origin.cost ?? null, length: unit.length ?? null,
        // fora do estoque até a entrada; exige inspeção → nasce esperando a de recebimento
        status: item.requiresInspection ? 'em_inspecao' : 'disponivel', holderType: 'externo', holderId: null,
        lifeEndsAt: lifeEnd(item, { manufacturedAt, firstUseAt: null }),
      } }));
    }
    return created;
  }

  /** Acha ou cria o lote pelo número. */
  async lotFor(tx: Tx, companyId: number, item: Stock_Item, raw: Body, origin: { supplierId?: number | null; purchaseOrderId?: number | null; cost?: number | null }) {
    if (idOf(raw.lotId)) return idOf(raw.lotId);
    const number = clean(raw.lotNumber, 60);
    if (!number) fail(`${item.name}: informe o número do lote`);
    const found = await tx.stock_Lot.findUnique({ where: { itemId_number: { itemId: item.id, number } } });
    if (found) return found.id;
    const lot = await tx.stock_Lot.create({ data: {
      companyId, itemId: item.id, number, manufacturedAt: optionalDate(raw.manufacturedAt, 'Fabricação do lote'), expiresAt: optionalDate(raw.expiresAt, 'Validade do lote'),
      supplierId: origin.supplierId ?? null, purchaseOrderId: origin.purchaseOrderId ?? null, unitCost: origin.cost ?? null,
    } });
    return lot.id;
  }

  /**
   * Linhas de entrada (de fora para uma posição): cria lote e peças quando o item pede.
   * `raw`: { itemId, quantity, unitCost?, lotId?, lotNumber?, expiresAt?, manufacturedAt?, units?: NewUnit[] }
   */
  async entryLines(tx: Tx, companyId: number, raws: Body[], to: Holder, origin: { supplierId?: number | null; purchaseOrderId?: number | null; date: string; chargedToOrder?: boolean }): Promise<LedgerLine[]> {
    const lines: LedgerLine[] = [];
    for (const [index, raw] of raws.entries()) {
      const item = await tx.stock_Item.findFirst({ where: { id: Number(raw.itemId) || 0, companyId } });
      if (!item) throw new NotFoundException('Item não encontrado');
      const unitCost = blank(raw.unitCost) ? null : Math.max(0, Number(raw.unitCost));
      if (unitCost !== null && Number.isNaN(unitCost)) fail(`Linha ${index + 1}: custo inválido`);
      if (item.tracking === 'unidade') {
        const units = Array.isArray(raw.units) ? (raw.units as NewUnit[]) : [];
        const count = units.length || Math.round(Number(raw.quantity) || 0);
        const lotId = blank(raw.lotNumber) && !idOf(raw.lotId) ? null : await this.lotFor(tx, companyId, item, raw, { ...origin, cost: unitCost });
        const created = await this.createUnits(tx, companyId, item, units.length ? units : Array.from({ length: count }, () => ({})), { lotId, ...origin, cost: unitCost, acquiredAt: origin.date });
        for (const unit of created) lines.push({ itemId: item.id, unitId: unit.id, lotId, quantity: 1, from: EXTERNAL, to, unitCost, chargedToOrder: origin.chargedToOrder, unitStatus: unit.status as any });
        continue;
      }
      const quantity = positive(raw.quantity, `Linha ${index + 1} (${item.name})`);
      const lotId = item.tracking === 'lote' ? await this.lotFor(tx, companyId, item, raw, { ...origin, cost: unitCost }) : null;
      lines.push({ itemId: item.id, lotId, quantity, from: EXTERNAL, to, unitCost, chargedToOrder: origin.chargedToOrder });
    }
    return lines;
  }

  // ------------------------------------------------------------------ lançamentos à mão

  async create(actor: StockActor, body: Body) {
    const type = String(body.type) as MovementType;
    const rule = MANUAL[type];
    if (!rule) fail('Tipo de movimentação inválido');
    if (!can(actor, rule!.permission)) throw new ForbiddenException('Você não tem permissão para este lançamento');
    const date = blank(body.date) ? today() : dateOf(body.date, 'Data');
    if (date > today()) fail('A data não pode ser no futuro');
    const note = text(body.note, 1000) || null;
    if (type === 'ajuste' && !note) fail('Informe o motivo do ajuste');
    const raws: Body[] = Array.isArray(body.lines) ? body.lines : [];
    if (!raws.length) fail('Informe pelo menos um item');
    const locationId = idOf(body.locationId);
    if (!locationId) fail('Escolha o local');
    const costCenterId = idOf(body.costCenterId);

    const movement = await this.prisma.$transaction(async (tx) => {
      let lines: LedgerLine[];
      const here = holder('local', locationId);
      if (rule!.from === 'externo') {
        lines = await this.entryLines(tx, actor.companyId, raws, here, { date });
      } else if (type === 'ajuste') {
        // ajuste: quantidade com sinal (+ entra, − sai)
        lines = [];
        for (const [index, raw] of raws.entries()) {
          const delta = Number(raw.quantity);
          if (!delta || Number.isNaN(delta)) fail(`Linha ${index + 1}: informe a diferença (+ ou −)`);
          const item = await this.catalog.byItem(actor.companyId, Number(raw.itemId));
          if (item.tracking === 'unidade') fail(`${item.name}: peça rastreada não se ajusta por quantidade (use baixa ou entrada)`);
          const lotId = item.tracking === 'lote' ? (delta > 0 ? await this.lotFor(tx, actor.companyId, item, raw, {}) : idOf(raw.lotId)) : null;
          const quantity = round3(Math.abs(delta));
          lines.push(delta > 0 ? { itemId: item.id, lotId, quantity, from: EXTERNAL, to: here, unitCost: null } : { itemId: item.id, lotId, quantity, from: here, to: EXTERNAL });
        }
      } else {
        const to = type === 'transferencia' ? holder('local', idOf(body.toLocationId)) : EXTERNAL;
        if (type === 'transferencia' && !to.id) fail('Escolha o local de destino');
        lines = raws.map((raw, index) => ({
          itemId: Number(raw.itemId), lotId: idOf(raw.lotId), unitId: idOf(raw.unitId),
          quantity: idOf(raw.unitId) ? 1 : positive(raw.quantity, `Linha ${index + 1}`), from: here, to, note: clean(raw.note, 500) || null,
        }));
      }
      return postMovement(tx, { companyId: actor.companyId, type, date, userId: actor.userId, note, costCenterId, lines, skipUsableCheck: true });
    });
    return this.get(actor, movement.id);
  }

  async reverse(actor: StockActor, id: number, body: Body) {
    const reversal = await this.prisma.$transaction((tx) => reverseMovement(tx, actor.companyId, id, actor.userId, text(body.note, 1000) || null));
    return this.get(actor, reversal.id);
  }

  // ------------------------------------------------------------------ leitura

  async list(actor: StockActor, query: Record<string, string>) {
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 30));
    const term = clean(query.search, 80);
    const itemId = idOf(query.itemId);
    const where: Prisma.Stock_MovementWhereInput = {
      companyId: actor.companyId,
      ...(query.type && query.type in MOVEMENT_TYPES ? { type: query.type } : {}),
      ...(idOf(query.serviceOrderId) ? { serviceOrderId: idOf(query.serviceOrderId) } : {}),
      ...(idOf(query.employeeId) ? { employeeId: idOf(query.employeeId) } : {}),
      ...(idOf(query.purchaseOrderId) ? { purchaseOrderId: idOf(query.purchaseOrderId) } : {}),
      ...(itemId ? { lines: { some: { itemId } } } : {}),
      ...(query.from || query.to ? { date: { ...(query.from ? { gte: new Date(`${dateOf(query.from, 'De')}T00:00:00.000Z`) } : {}), ...(query.to ? { lte: new Date(`${dateOf(query.to, 'Até')}T00:00:00.000Z`) } : {}) } } : {}),
      ...(term ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { note: { contains: term, mode: 'insensitive' } }, { lines: { some: { itemId: { in: (await this.prisma.stock_Item.findMany({ where: { companyId: actor.companyId, name: { contains: term, mode: 'insensitive' } }, select: { id: true }, take: 100 })).map((i) => i.id) } } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stock_Movement.findMany({ where, orderBy: { id: 'desc' }, skip: page * limit, take: limit, include: { lines: { select: { itemId: true, quantity: true, totalCost: true, fromType: true, fromId: true, toType: true, toId: true } } } }),
      this.prisma.stock_Movement.count({ where }),
    ]);
    const itemIds = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.itemId)))];
    const [items, users] = await Promise.all([
      this.prisma.stock_Item.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, unit: true } }),
      this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId).filter((x): x is number => !!x) } }, select: { id: true, name: true } }),
    ]);
    const names = await holderNames(this.prisma, actor.companyId, rows.flatMap((r) => r.lines.flatMap((l) => [{ type: l.fromType as HolderType, id: l.fromId }, { type: l.toType as HolderType, id: l.toId }])));
    const itemOf = new Map(items.map((i) => [i.id, i])), userOf = new Map(users.map((u) => [u.id, u.name]));
    const costs = can(actor, PERM.costs);
    const where2 = (type: string, id: number | null) => (type === 'externo' ? null : names.get(holderKey({ type, id })) ?? null);
    return {
      total,
      rows: rows.map((row) => {
        const first = row.lines[0];
        return {
          id: row.id, number: row.number, type: row.type, typeLabel: MOVEMENT_TYPES[row.type as MovementType] ?? row.type, date: d(row.date),
          user: row.userId ? userOf.get(row.userId) ?? null : null, note: row.note, reversed: !!row.reversedById, reverses: !!row.reversesId,
          from: first ? where2(first.fromType, first.fromId) : null, to: first ? where2(first.toType, first.toId) : null,
          summary: row.lines.slice(0, 3).map((l) => `${round3(num(l.quantity))} ${itemOf.get(l.itemId)?.unit ?? ''} ${itemOf.get(l.itemId)?.name ?? ''}`.trim()).join(', ') + (row.lines.length > 3 ? ` e mais ${row.lines.length - 3}` : ''),
          lines: row.lines.length, total: costs ? round2(row.lines.reduce((s, l) => s + num(l.totalCost), 0)) : null,
        };
      }),
    };
  }

  async get(actor: StockActor, id: number) {
    const row = await this.prisma.stock_Movement.findFirst({ where: { id, companyId: actor.companyId }, include: { lines: { orderBy: { id: 'asc' } } } });
    if (!row) throw new NotFoundException('Movimentação não encontrada');
    const [items, units, lots, user, order, purchase, employee, reverses, reversedBy] = await Promise.all([
      this.prisma.stock_Item.findMany({ where: { id: { in: row.lines.map((l) => l.itemId) } }, select: { id: true, code: true, name: true, unit: true } }),
      this.prisma.stock_Unit.findMany({ where: { id: { in: row.lines.map((l) => l.unitId).filter((x): x is number => !!x) } }, select: { id: true, tag: true } }),
      this.prisma.stock_Lot.findMany({ where: { id: { in: row.lines.map((l) => l.lotId).filter((x): x is number => !!x) } }, select: { id: true, number: true } }),
      row.userId ? this.prisma.user.findUnique({ where: { id: row.userId }, select: { name: true } }) : null,
      row.serviceOrderId ? this.prisma.service_Order.findUnique({ where: { id: row.serviceOrderId }, select: { id: true, number: true, title: true } }) : null,
      row.purchaseOrderId ? this.prisma.purchase_Order.findUnique({ where: { id: row.purchaseOrderId }, select: { id: true, number: true } }) : null,
      row.employeeId ? this.prisma.hr_Employee.findUnique({ where: { id: row.employeeId }, select: { id: true, name: true } }) : null,
      row.reversesId ? this.prisma.stock_Movement.findUnique({ where: { id: row.reversesId }, select: { id: true, number: true } }) : null,
      row.reversedById ? this.prisma.stock_Movement.findUnique({ where: { id: row.reversedById }, select: { id: true, number: true } }) : null,
    ]);
    const names = await holderNames(this.prisma, actor.companyId, row.lines.flatMap((l) => [{ type: l.fromType as HolderType, id: l.fromId }, { type: l.toType as HolderType, id: l.toId }]));
    const itemOf = new Map(items.map((i) => [i.id, i])), tagOf = new Map(units.map((u) => [u.id, u.tag])), lotOf = new Map(lots.map((l) => [l.id, l.number]));
    const costs = can(actor, PERM.costs);
    const where2 = (type: string, id: number | null) => (type === 'externo' ? '—' : names.get(holderKey({ type, id })) ?? type);
    const signature = row.signature as Body | null;
    return {
      id: row.id, number: row.number, type: row.type, typeLabel: MOVEMENT_TYPES[row.type as MovementType] ?? row.type, date: d(row.date), note: row.note,
      user: user?.name ?? null, serviceOrder: order, purchaseOrder: purchase, employee, reason: row.reason, reverses, reversedBy,
      signature: signature ? { name: signature.name ?? null, document: signature.document ?? null, at: signature.at ?? null, hasImage: !!signature.key } : null,
      canReverse: !row.reversedById && row.type !== 'estorno' && can(actor, PERM.adjust),
      lines: row.lines.map((l) => ({
        id: l.id, itemId: l.itemId, item: itemOf.get(l.itemId)?.name ?? '', code: itemOf.get(l.itemId)?.code ?? '', unit: itemOf.get(l.itemId)?.unit ?? '',
        lot: l.lotId ? lotOf.get(l.lotId) ?? null : null, tag: l.unitId ? tagOf.get(l.unitId) ?? null : null, unitId: l.unitId,
        quantity: num(l.quantity), from: where2(l.fromType, l.fromId), to: where2(l.toType, l.toId), condition: l.condition, note: l.note,
        unitCost: costs ? num(l.unitCost) : null, totalCost: costs ? num(l.totalCost) : null, chargedToOrder: l.chargedToOrder,
      })),
      total: costs ? round2(row.lines.reduce((s, l) => s + num(l.totalCost), 0)) : null,
    };
  }

  /** Saldos: item × posição, com filtros. */
  async balances(actor: StockActor, query: Record<string, string>) {
    const holderType = ['local', 'os', 'funcionario', 'locacao', 'fornecedor'].includes(query.holderType) ? query.holderType : query.outside === '1' ? undefined : 'local';
    const rows = await this.prisma.stock_Balance.findMany({
      where: {
        companyId: actor.companyId, quantity: { not: 0 },
        ...(holderType ? { holderType } : {}), ...(idOf(query.holderId) ? { holderId: idOf(query.holderId)! } : {}),
        ...(idOf(query.itemId) ? { itemId: idOf(query.itemId)! } : {}),
      },
    });
    const items = await this.prisma.stock_Item.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.itemId))] }, ...(idOf(query.categoryId) ? { categoryId: idOf(query.categoryId) } : {}), ...(query.search ? { OR: [{ name: { contains: clean(query.search, 80), mode: 'insensitive' } }, { code: { contains: clean(query.search, 80), mode: 'insensitive' } }] } : {}) },
      select: { id: true, code: true, name: true, unit: true, averageCost: true, tracking: true },
    });
    const itemOf = new Map(items.map((i) => [i.id, i]));
    const lots = await this.prisma.stock_Lot.findMany({ where: { id: { in: rows.map((r) => r.lotId).filter((x) => x > 0) } }, select: { id: true, number: true, expiresAt: true } });
    const lotOf = new Map(lots.map((l) => [l.id, l]));
    const names = await holderNames(this.prisma, actor.companyId, rows.map((r) => ({ type: r.holderType as HolderType, id: r.holderId })));
    const costs = can(actor, PERM.costs);
    const list = rows.filter((r) => itemOf.has(r.itemId)).map((r) => {
      const item = itemOf.get(r.itemId)!;
      return {
        itemId: r.itemId, code: item.code, item: item.name, unit: item.unit, tracking: item.tracking,
        holderType: r.holderType, holderId: r.holderId, holder: names.get(holderKey({ type: r.holderType, id: r.holderId })) ?? '—',
        lotId: r.lotId || null, lot: r.lotId ? lotOf.get(r.lotId)?.number ?? null : null, expiresAt: r.lotId ? d(lotOf.get(r.lotId)?.expiresAt) : null,
        quantity: num(r.quantity), value: costs ? round2(num(r.quantity) * num(item.averageCost)) : null,
      };
    }).sort((a, b) => a.item.localeCompare(b.item) || a.holder.localeCompare(b.holder));
    return { rows: list, value: costs ? round2(list.reduce((s, r) => s + (r.value ?? 0), 0)) : null };
  }

  /** Itens abaixo do mínimo, com a sugestão de reposição. */
  async reorder(actor: StockActor) {
    const items = await this.prisma.stock_Item.findMany({ where: { companyId: actor.companyId, inactiveAt: null, minQuantity: { not: null } }, orderBy: { name: 'asc' } });
    const totals = await this.catalog.totals(actor.companyId, items.map((i) => i.id));
    const units = await this.catalog.available(actor.companyId, items.filter((i) => i.tracking === 'unidade').map((i) => i.id));
    const suppliers = await this.prisma.financial_Supplier.findMany({ where: { id: { in: items.map((i) => i.lastSupplierId).filter((x): x is number => !!x) } }, select: { id: true, name: true } });
    const supplierOf = new Map(suppliers.map((s) => [s.id, s.name]));
    return items.map((item) => {
      const available = item.tracking === 'unidade' ? units.get(item.id) ?? 0 : totals.get(item.id)?.inStock ?? 0;
      const min = num(item.minQuantity);
      return {
        id: item.id, code: item.code, name: item.name, unit: item.unit, available, min,
        suggested: round3(item.reorderQuantity !== null ? num(item.reorderQuantity) : Math.max(min * 2 - available, min - available)),
        lastCost: item.lastCost === null || !(can(actor, PERM.costs) || can(actor, 'create_pedidos_de_compra')) ? null : num(item.lastCost), lastSupplierId: item.lastSupplierId, lastSupplier: item.lastSupplierId ? supplierOf.get(item.lastSupplierId) ?? null : null,
      };
    }).filter((row) => row.available < row.min);
  }

  // ------------------------------------------------------------------ carga inicial por planilha

  /**
   * Planilha CSV (separador ; ou ,): código; nome; categoria; unidade; controle; quantidade; local; custo; série; fabricação; lote; validade.
   * Cria o que não existe (categoria, local, item) e lança o saldo inicial numa movimentação só por local.
   */
  async importCsv(actor: StockActor, body: Body) {
    const raw = String(body.csv ?? '').replace(/^﻿/, '');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) fail('A planilha precisa do cabeçalho e de pelo menos uma linha');
    const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
    const split = (line: string) => line.split(sep).map((cell) => cell.trim().replace(/^"|"$/g, ''));
    const header = split(lines[0]).map((h) => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
    const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h.startsWith(n)));
    const idx = {
      code: col('codigo', 'code'), name: col('nome', 'name', 'item'), category: col('categoria'), unit: col('unidade', 'un'), tracking: col('controle'),
      quantity: col('quantidade', 'qtd', 'saldo'), location: col('local'), cost: col('custo', 'valor'), serial: col('serie', 'numero de serie'),
      manufactured: col('fabricacao'), lot: col('lote'), expires: col('validade'),
    };
    if (idx.name < 0) fail('A planilha precisa da coluna "nome"');
    if (lines.length > 3001) fail('No máximo 3.000 linhas por planilha');
    const brNumber = (value: string) => (value ? Number(value.replace(/\./g, '').replace(',', '.')) : NaN);
    const brDate = (value: string) => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : value || null;
    };
    const date = today();
    const result = { items: 0, categories: 0, locations: 0, lines: 0, errors: [] as string[] };
    await this.catalog.ensureLocation(actor.companyId);
    await this.catalog.ensureCategories(actor.companyId);
    const defaultLocation = (await this.prisma.stock_Location.findFirst({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { id: 'asc' } }))!;

    await this.prisma.$transaction(async (tx) => {
      const byLocation = new Map<number, LedgerLine[]>();
      for (const [n, line] of lines.slice(1).entries()) {
        const cells = split(line);
        const get = (i: number) => (i >= 0 ? cells[i] ?? '' : '');
        const name = clean(get(idx.name), 200);
        if (!name) { result.errors.push(`Linha ${n + 2}: sem nome`); continue; }
        // categoria
        let categoryId: number | null = null;
        const categoryName = clean(get(idx.category), 100);
        if (categoryName) {
          const found = await tx.stock_Category.findFirst({ where: { companyId: actor.companyId, name: { equals: categoryName, mode: 'insensitive' } }, orderBy: { parentId: { sort: 'desc', nulls: 'last' } } });
          categoryId = found?.id ?? (await tx.stock_Category.create({ data: { companyId: actor.companyId, name: categoryName } })).id;
          if (!found) result.categories++;
        }
        // local
        let locationId = defaultLocation.id;
        const locationName = clean(get(idx.location), 120);
        if (locationName) {
          const found = await tx.stock_Location.findFirst({ where: { companyId: actor.companyId, name: { equals: locationName, mode: 'insensitive' } } });
          locationId = found?.id ?? (await tx.stock_Location.create({ data: { companyId: actor.companyId, name: locationName } })).id;
          if (!found) result.locations++;
        }
        // item
        const code = clean(get(idx.code), 30).toUpperCase();
        let item = code ? await tx.stock_Item.findFirst({ where: { companyId: actor.companyId, code } }) : await tx.stock_Item.findFirst({ where: { companyId: actor.companyId, name: { equals: name, mode: 'insensitive' } } });
        if (!item) {
          const trackingRaw = get(idx.tracking).toLowerCase();
          const tracking = trackingRaw.startsWith('uni') || trackingRaw.startsWith('ser') ? 'unidade' : trackingRaw.startsWith('lot') ? 'lote' : 'quantidade';
          const finalCode = code || `IT-${String((await tx.stock_Item.count({ where: { companyId: actor.companyId } })) + 1).padStart(4, '0')}`;
          item = await tx.stock_Item.create({ data: { companyId: actor.companyId, code: finalCode, name, categoryId, unit: clean(get(idx.unit), 20) || 'un', tracking, returnable: tracking === 'unidade' } });
          result.items++;
        }
        const quantity = brNumber(get(idx.quantity));
        const serial = clean(get(idx.serial), 80);
        if (!(quantity > 0) && !(item.tracking === 'unidade' && serial)) continue;
        const cost = brNumber(get(idx.cost));
        const rawLine: Body = { itemId: item.id, quantity: item.tracking === 'unidade' ? 1 : quantity, unitCost: Number.isNaN(cost) ? null : cost, lotNumber: get(idx.lot) || (item.tracking === 'lote' ? 'SEM-LOTE' : ''), expiresAt: brDate(get(idx.expires)), manufacturedAt: brDate(get(idx.manufactured)) };
        if (item.tracking === 'unidade') rawLine.units = Array.from({ length: serial ? 1 : Math.round(quantity) }, () => ({ serialNumber: serial || null, manufacturedAt: brDate(get(idx.manufactured)) }));
        try {
          const ledger = await this.entryLines(tx, actor.companyId, [rawLine], holder('local', locationId), { date });
          byLocation.set(locationId, [...(byLocation.get(locationId) ?? []), ...ledger]);
          result.lines++;
        } catch (error) {
          result.errors.push(`Linha ${n + 2}: ${(error as Error).message}`);
        }
      }
      for (const [, ledger] of byLocation) await postMovement(tx, { companyId: actor.companyId, type: 'saldo_inicial', date, userId: actor.userId, note: 'Carga inicial por planilha', lines: ledger, skipUsableCheck: true });
    }, { timeout: 120000 });
    return result;
  }

  // ------------------------------------------------------------------ obra (OS)

  private async orderFor(actor: StockActor, orderId: number) {
    const order = await this.prisma.service_Order.findFirst({
      where: { id: orderId, companyId: actor.companyId, inactiveAt: null, AND: [await ordersVisibleTo(this.prisma, { userId: actor.userId, companyId: actor.companyId, seesAll: can(actor, ALL_ORDERS_PERMISSION) })] },
    });
    if (!order) throw new NotFoundException('Ordem de serviço não encontrada');
    return order;
  }

  /** O que está na obra agora, as movimentações dela e o custo de material do estoque. */
  async ofOrder(actor: StockActor, orderId: number) {
    const order = await this.orderFor(actor, orderId);
    const here = holder('os', order.id);
    const [balances, units, movements] = await Promise.all([
      this.prisma.stock_Balance.findMany({ where: { companyId: actor.companyId, holderType: 'os', holderId: order.id, quantity: { gt: 0 } } }),
      this.prisma.stock_Unit.findMany({ where: { companyId: actor.companyId, holderType: 'os', holderId: order.id }, orderBy: { tag: 'asc' } }),
      this.prisma.stock_Movement.findMany({ where: { companyId: actor.companyId, serviceOrderId: order.id }, orderBy: { id: 'desc' }, take: 100, include: { lines: { select: { itemId: true, quantity: true } } } }),
    ]);
    const items = await this.prisma.stock_Item.findMany({ where: { id: { in: [...new Set([...balances.map((b) => b.itemId), ...movements.flatMap((m) => m.lines.map((l) => l.itemId))])] } } });
    const itemOf = new Map(items.map((i) => [i.id, i]));
    const lots = await this.prisma.stock_Lot.findMany({ where: { id: { in: balances.map((b) => b.lotId).filter((x) => x > 0) } }, select: { id: true, number: true } });
    const lotOf = new Map(lots.map((l) => [l.id, l.number]));
    const cost = await stockCostOfOrder(this.prisma, order.id);
    const costs = can(actor, PERM.costs) || can(actor, 'view_custos_comercial');
    const now = today();
    return {
      order: { id: order.id, number: order.number, status: order.status, plannedEnd: d(order.plannedEnd) },
      atOrder: balances.filter((b) => itemOf.get(b.itemId)?.tracking !== 'unidade').map((b) => {
        const item = itemOf.get(b.itemId)!;
        return { itemId: b.itemId, code: item.code, item: item.name, unit: item.unit, returnable: item.returnable, lotId: b.lotId || null, lot: b.lotId ? lotOf.get(b.lotId) ?? null : null, quantity: num(b.quantity) };
      }),
      units: units.map((u) => {
        const item = itemOf.get(u.itemId);
        const end = d(order.plannedEnd);
        const expiring = !!end && [d(u.nextInspectionAt), d(u.nextCalibrationAt), d(u.lifeEndsAt)].some((due) => !!due && due >= now && due < end);
        return { id: u.id, tag: u.tag, itemId: u.itemId, item: item?.name ?? '', status: u.status, nextInspectionAt: d(u.nextInspectionAt), nextCalibrationAt: d(u.nextCalibrationAt), expiringBeforeEnd: expiring };
      }),
      movements: movements.map((m) => ({
        id: m.id, number: m.number, type: m.type, typeLabel: MOVEMENT_TYPES[m.type as MovementType] ?? m.type, date: d(m.date), reversed: !!m.reversedById,
        summary: m.lines.slice(0, 3).map((l) => `${round3(num(l.quantity))} ${itemOf.get(l.itemId)?.name ?? ''}`).join(', ') + (m.lines.length > 3 ? ` e mais ${m.lines.length - 3}` : ''),
      })),
      cost: costs ? cost : null,
      canMove: can(actor, PERM.move), here: holderKey(here),
    };
  }

  /** Romaneio: saída do local para a obra. Consumível conta no custo da obra; equipamento que volta, não. */
  async dispatch(actor: StockActor, orderId: number, body: Body) {
    if (!can(actor, PERM.move)) throw new ForbiddenException('Você não tem permissão para movimentar o estoque');
    const order = await this.orderFor(actor, orderId);
    if (['cancelada', 'encerrada'].includes(order.status)) throw new ConflictException(`A ${order.number} está ${order.status}: não recebe material`);
    const locationId = idOf(body.locationId);
    if (!locationId) fail('Escolha de qual local sai');
    const raws: Body[] = Array.isArray(body.lines) ? body.lines : [];
    const date = blank(body.date) ? today() : dateOf(body.date, 'Data');
    const movement = await this.prisma.$transaction(async (tx) => {
      const items = await tx.stock_Item.findMany({ where: { companyId: actor.companyId, id: { in: raws.map((r) => Number(r.itemId)) } } });
      const itemOf = new Map(items.map((i) => [i.id, i]));
      const lines: LedgerLine[] = raws.map((raw, index) => {
        const item = itemOf.get(Number(raw.itemId));
        if (!item) fail(`Linha ${index + 1}: item não encontrado`);
        const unitId = idOf(raw.unitId);
        return {
          itemId: item!.id, lotId: idOf(raw.lotId), unitId, quantity: unitId ? 1 : positive(raw.quantity, `Linha ${index + 1} (${item!.name})`),
          from: holder('local', locationId), to: holder('os', order.id), chargedToOrder: !item!.returnable && item!.tracking !== 'unidade',
        };
      });
      const created = await postMovement(tx, { companyId: actor.companyId, type: 'saida_os', date, userId: actor.userId, note: text(body.note, 1000) || null, serviceOrderId: order.id, signature: signatureOf(body), lines });
      await this.tickChecklist(tx, order.id, actor.userId);
      return created;
    });
    return this.get(actor, movement.id);
  }

  /** Marca "materiais separados" no checklist da mobilização, se houver um item com esse título. */
  private async tickChecklist(tx: Tx, orderId: number, userId: number) {
    const order = await tx.service_Order.findUnique({ where: { id: orderId }, select: { checklist: true } });
    const list = Array.isArray(order?.checklist) ? (order!.checklist as Body[]) : [];
    let changed = false;
    const next = list.map((entry) => {
      if (!entry.done && /materia/i.test(String(entry.title ?? '')) && /separ|mobiliz|carreg/i.test(String(entry.title ?? ''))) {
        changed = true;
        return { ...entry, done: true, doneAt: new Date().toISOString(), doneBy: `romaneio (usuário ${userId})` };
      }
      return entry;
    });
    if (changed) await tx.service_Order.update({ where: { id: orderId }, data: { checklist: next as Prisma.InputJsonValue } });
  }

  /**
   * Retorno da obra: sobra de consumível volta pelo custo médio do que está na obra (abate da obra);
   * peça volta para o local (em inspeção, se exige; bloqueada, se avariada). "faltando" não anda.
   */
  async returnFromOrder(actor: StockActor, orderId: number, body: Body) {
    if (!can(actor, PERM.move)) throw new ForbiddenException('Você não tem permissão para movimentar o estoque');
    const order = await this.orderFor(actor, orderId);
    const locationId = idOf(body.locationId);
    if (!locationId) fail('Escolha para qual local volta');
    const date = blank(body.date) ? today() : dateOf(body.date, 'Data');
    const raws: Body[] = (Array.isArray(body.lines) ? body.lines : []).filter((raw: Body) => raw.condition !== 'faltando');
    if (!raws.length) fail('Informe o que voltou');
    const movement = await this.prisma.$transaction(async (tx) => {
      const lines: LedgerLine[] = [];
      for (const [index, raw] of raws.entries()) {
        const item = await this.catalog.byItem(actor.companyId, Number(raw.itemId));
        const unitId = idOf(raw.unitId);
        const condition = ['ok', 'sujo', 'avariado'].includes(raw.condition) ? String(raw.condition) : 'ok';
        if (unitId || item.tracking === 'unidade') {
          lines.push({
            itemId: item.id, unitId, quantity: 1, from: holder('os', order.id), to: holder('local', locationId), condition,
            unitStatus: condition === 'avariado' ? 'bloqueado' : item.requiresInspection ? 'em_inspecao' : 'disponivel',
          });
          continue;
        }
        const quantity = positive(raw.quantity, `Linha ${index + 1} (${item.name})`);
        const consumable = !item.returnable;
        lines.push({
          itemId: item.id, lotId: idOf(raw.lotId), quantity, from: holder('os', order.id), to: holder('local', locationId), condition,
          unitCost: consumable ? await averageAtOrder(tx, order.id, item.id) : null, chargedToOrder: consumable,
        });
      }
      return postMovement(tx, { companyId: actor.companyId, type: 'retorno_os', date, userId: actor.userId, note: text(body.note, 1000) || null, serviceOrderId: order.id, lines, skipUsableCheck: true });
    });
    return this.get(actor, movement.id);
  }

  /** Dá como consumido o consumível que ficou na obra (o custo já contou na saída). */
  async consumeAtOrder(actor: StockActor, orderId: number, body: Body) {
    if (!can(actor, PERM.move)) throw new ForbiddenException('Você não tem permissão para movimentar o estoque');
    const order = await this.orderFor(actor, orderId);
    const movement = await this.prisma.$transaction(async (tx) => {
      const balances = await tx.stock_Balance.findMany({ where: { companyId: actor.companyId, holderType: 'os', holderId: order.id, quantity: { gt: 0 } } });
      const items = await tx.stock_Item.findMany({ where: { id: { in: balances.map((b) => b.itemId) } } });
      const consumables = new Set(items.filter((i) => !i.returnable && i.tracking !== 'unidade').map((i) => i.id));
      const wanted: Body[] | null = Array.isArray(body.lines) && body.lines.length ? body.lines : null;
      const lines: LedgerLine[] = [];
      for (const balance of balances.filter((b) => consumables.has(b.itemId))) {
        const pick = wanted ? wanted.find((w) => Number(w.itemId) === balance.itemId && (idOf(w.lotId) ?? 0) === balance.lotId) : null;
        if (wanted && !pick) continue;
        const quantity = pick ? Math.min(positive(pick.quantity, 'Quantidade'), num(balance.quantity)) : num(balance.quantity);
        lines.push({ itemId: balance.itemId, lotId: balance.lotId || null, quantity, from: holder('os', order.id), to: EXTERNAL, unitCost: await averageAtOrder(tx, order.id, balance.itemId) });
      }
      if (!lines.length) fail('Não há consumível na obra para dar como consumido');
      return postMovement(tx, { companyId: actor.companyId, type: 'consumo_os', date: today(), userId: actor.userId, note: text(body.note, 1000) || null, serviceOrderId: order.id, lines, skipUsableCheck: true });
    });
    return this.get(actor, movement.id);
  }

  // ------------------------------------------------------------------ recebimento do pedido de compra

  /**
   * Recebe linhas de um pedido de compra (chamado pelo pedido, dentro da transação dele).
   * Pedido com OS entra direto na posição da obra, sem contar de novo (o pedido já conta).
   * `lines`: [{ index, quantity, locationId?, lotNumber?, expiresAt?, manufacturedAt?, units? }]
   */
  async receivePurchase(tx: Tx, purchase: { id: number; companyId: number; supplierId: number | null; serviceOrderId: number | null; items: Body[] }, raws: Body[], date: string, userId: number) {
    const items = purchase.items.map((line) => ({ ...line }));
    const ledger: LedgerLine[] = [];
    await this.catalog.ensureLocation(purchase.companyId);
    const fallback = (await tx.stock_Location.findFirst({ where: { companyId: purchase.companyId, inactiveAt: null }, orderBy: { id: 'asc' } }))!;
    for (const raw of raws) {
      const index = Number(raw.index);
      const line = items[index];
      if (!line || !line.itemId) fail(`Linha ${index + 1} do pedido não é de item do estoque`);
      const item = await this.catalog.byItem(purchase.companyId, Number(line.itemId));
      const factor = item.purchaseFactor && item.purchaseUnit && clean(line.unit, 20).toLowerCase() === item.purchaseUnit.toLowerCase() ? num(item.purchaseFactor) : 1;
      const pending = round3(num(line.quantity) - num(line.receivedQuantity));
      const unitsGiven = Array.isArray(raw.units) ? raw.units : [];
      const received = item.tracking === 'unidade' && unitsGiven.length ? round3(unitsGiven.length / factor) : positive(raw.quantity, `Linha ${index + 1}`);
      if (received > pending + 0.0005) throw new ConflictException(`${item.name}: chegou mais do que falta receber (${pending})`);
      const to = purchase.serviceOrderId ? holder('os', purchase.serviceOrderId) : holder('local', idOf(raw.locationId) ?? fallback.id);
      const lines = await this.entryLines(tx, purchase.companyId, [{
        itemId: item.id, quantity: round3(received * factor), unitCost: round4(num(line.unitPrice) / factor),
        lotNumber: raw.lotNumber, lotId: raw.lotId, expiresAt: raw.expiresAt, manufacturedAt: raw.manufacturedAt, units: unitsGiven,
      }], to, { supplierId: purchase.supplierId, purchaseOrderId: purchase.id, date, chargedToOrder: false });
      ledger.push(...lines);
      line.receivedQuantity = round3(num(line.receivedQuantity) + received);
      await tx.stock_Item.update({ where: { id: item.id }, data: { lastSupplierId: purchase.supplierId ?? undefined, lastPurchaseAt: new Date(`${date}T00:00:00.000Z`) } });
    }
    if (!ledger.length) fail('Informe o que chegou');
    const movement = await postMovement(tx, {
      companyId: purchase.companyId, type: 'entrada_compra', date, userId, purchaseOrderId: purchase.id, serviceOrderId: purchase.serviceOrderId,
      supplierId: purchase.supplierId, lines: ledger, skipUsableCheck: true,
    });
    return { items, movement };
  }

  /** Desfaz as entradas de um pedido (voltar de recebido para comprado). Falha se algo já saiu. */
  async undoPurchase(tx: Tx, companyId: number, purchaseOrderId: number, userId: number) {
    const entries = await tx.stock_Movement.findMany({ where: { companyId, purchaseOrderId, type: 'entrada_compra', reversedById: null } });
    for (const entry of entries) {
      try {
        await reverseMovement(tx, companyId, entry.id, userId, 'Recebimento do pedido desfeito');
      } catch (error) {
        throw new ConflictException(`Não dá para desfazer o recebimento: parte do que entrou já saiu (${(error as Error).message}). Estorne as saídas antes.`);
      }
    }
    return entries.length;
  }

  async orderOptions(actor: StockActor) {
    const rows = await this.prisma.service_Order.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, status: { notIn: ['cancelada', 'encerrada'] }, AND: [await ordersVisibleTo(this.prisma, { userId: actor.userId, companyId: actor.companyId, seesAll: can(actor, ALL_ORDERS_PERMISSION) })] },
      orderBy: { id: 'desc' }, take: 300, select: { id: true, number: true, title: true },
    });
    return rows.map((row) => ({ id: row.id, name: `${row.number} — ${row.title}` }));
  }

  async employeeOptions(actor: StockActor) {
    const rows = await this.prisma.hr_Employee.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, OR: [{ terminationDate: null }, { terminationDate: { gt: new Date(`${today()}T00:00:00.000Z`) } }] },
      orderBy: { name: 'asc' }, take: 1000, select: { id: true, name: true, userId: true },
    });
    return rows;
  }

  // ------------------------------------------------------------------ visão geral

  async overview(actor: StockActor) {
    const now = today();
    const soon = new Date(`${now}T00:00:00.000Z`);
    soon.setUTCDate(soon.getUTCDate() + 30);
    const nowDate = new Date(`${now}T00:00:00.000Z`);
    const [items, atOrders, inspections, calibrations, rentals, receipts, outside] = await Promise.all([
      this.catalog.items(actor, { limit: '1' }),
      this.prisma.stock_Balance.groupBy({ by: ['holderId'], where: { companyId: actor.companyId, holderType: 'os', quantity: { gt: 0 } } }),
      this.prisma.stock_Unit.groupBy({ by: ['status'], where: { companyId: actor.companyId, status: { not: 'baixado' }, item: { requiresInspection: true }, OR: [{ nextInspectionAt: null }, { nextInspectionAt: { lte: soon } }] }, _count: { _all: true } }),
      this.prisma.stock_Unit.count({ where: { companyId: actor.companyId, status: { not: 'baixado' }, item: { requiresCalibration: true }, OR: [{ nextCalibrationAt: null }, { nextCalibrationAt: { lte: soon } }] } }),
      this.prisma.stock_Rental.findMany({ where: { companyId: actor.companyId, inactiveAt: null, status: 'ativa' }, select: { expectedEnd: true } }),
      this.prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "Purchase_Order" p WHERE p."companyId" = ${actor.companyId} AND p."inactiveAt" IS NULL AND p."status" = 'comprado' AND EXISTS (SELECT 1 FROM jsonb_array_elements(p."items"::jsonb) l WHERE (l->>'itemId') IS NOT NULL)`,
      this.prisma.stock_Unit.count({ where: { companyId: actor.companyId, status: { not: 'baixado' }, holderType: { in: ['funcionario', 'locacao', 'fornecedor'] } } }),
    ]);
    return {
      low: items.lowCount, value: items.value, atOrders: atOrders.length,
      inspections: inspections.reduce((s, g) => s + g._count._all, 0), calibrations, outside,
      rentalsActive: rentals.length, rentalsLate: rentals.filter((r) => r.expectedEnd && r.expectedEnd < nowDate).length,
      pendingReceipts: Number(receipts[0]?.count ?? 0),
    };
  }
}

/** Assinatura de quem recebeu (nome e documento; a imagem vai pelo envio próprio). */
export function signatureOf(body: Body): Prisma.InputJsonValue | null {
  const name = clean(body.receivedBy ?? body.signatureName, 160);
  if (!name && !body.signatureKey) return null;
  return { name: name || null, document: clean(body.receivedByDocument, 30) || null, key: body.signatureKey ?? null, at: new Date().toISOString() };
}

/** Custo médio do que entrou na obra para um item (saídas e compras diretas), para o retorno e o consumo. */
export async function averageAtOrder(tx: Tx | PrismaService, orderId: number, itemId: number): Promise<number> {
  const lines = await tx.stock_MovementLine.findMany({ where: { itemId, OR: [{ toType: 'os', toId: orderId }, { fromType: 'os', fromId: orderId }] }, select: { toType: true, quantity: true, totalCost: true } });
  let qty = 0, cost = 0;
  for (const line of lines) {
    const sign = line.toType === 'os' ? 1 : -1;
    qty += sign * num(line.quantity);
    cost += sign * num(line.totalCost);
  }
  if (qty > 0.0005 && cost > 0) return round4(cost / qty);
  const item = await tx.stock_Item.findUnique({ where: { id: itemId }, select: { averageCost: true } });
  return num(item?.averageCost);
}

/** Custo de material do estoque na obra: saídas cobradas − sobras devolvidas (e baixas cobradas). */
export async function stockCostOfOrder(prisma: PrismaService | Tx, orderId: number) {
  const lines = await prisma.stock_MovementLine.findMany({
    where: { chargedToOrder: true, OR: [{ toType: 'os', toId: orderId }, { fromType: 'os', fromId: orderId }, { movement: { serviceOrderId: orderId } }] },
    select: { fromType: true, fromId: true, toType: true, toId: true, totalCost: true, movement: { select: { type: true, reversesId: true } } },
  });
  const originals = await prisma.stock_Movement.findMany({ where: { id: { in: lines.map((l) => l.movement.reversesId).filter((x): x is number => !!x) } }, select: { id: true, type: true } });
  const typeOf = new Map(originals.map((m) => [m.id, m.type]));
  const totals = { sent: 0, returned: 0, lost: 0, ppe: 0 };
  for (const line of lines) {
    const reversal = line.movement.type === 'estorno';
    const type = reversal ? typeOf.get(line.movement.reversesId ?? 0) ?? '' : line.movement.type;
    const value = num(line.totalCost) * (reversal ? -1 : 1);
    if (type === 'baixa') totals.lost += value;
    else if (type === 'entrega_epi') totals.ppe += value;
    else if (type === 'retorno_os') totals.returned += value;
    else if (type === 'saida_os' || type === 'entrada_compra') totals.sent += value;
  }
  return { sent: round2(totals.sent), returned: round2(totals.returned), lost: round2(totals.lost), ppe: round2(totals.ppe), total: round2(totals.sent - totals.returned + totals.lost + totals.ppe) };
}
