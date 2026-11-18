import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Stock_Item } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { holderKey, holderNames } from './ledger';
import { DEFAULT_TEMPLATES } from './equipment.templates';
import { suggestedRentPrices } from '../commercial/rental.items';
import { RENTAL_PRESETS } from '../commercial/pricing/rental';
import {
  Body, Holder, HolderType, MOVEMENT_TYPES, PERM, StockActor, TRACKINGS, UNIT_STATUS, blank, can, clean, d, dueState, fail, idOf, num,
  optionalDate, optionalNumber, round2, round3, text, today,
} from './stock.rules';

/**
 * Cadastros do estoque: categorias, locais e itens (o catálogo), com os saldos
 * e o histórico de cada item. As movimentações ficam em `movement.service.ts`.
 */
export const LOCATION_KINDS = { almoxarifado: 'Almoxarifado', container: 'Container', veiculo: 'Veículo', ct: 'Centro de treinamento', outro: 'Outro' } as const;
/** Modelos que pré-marcam as opções do item (a tela escolhe um; depois ajusta). */
export const ITEM_PRESETS = {
  consumivel: { tracking: 'quantidade', returnable: false, requiresInspection: false, requiresCalibration: false, isPpe: false },
  reutilizavel: { tracking: 'unidade', returnable: true, requiresInspection: true, inspectionIntervalDays: 180, requiresCalibration: false, isPpe: false },
  calibravel: { tracking: 'unidade', returnable: true, requiresInspection: false, requiresCalibration: true, calibrationIntervalMonths: 12, isPpe: false },
  epi: { tracking: 'quantidade', returnable: false, requiresInspection: false, requiresCalibration: false, isPpe: true },
  ferramenta: { tracking: 'quantidade', returnable: true, requiresInspection: false, requiresCalibration: false, isPpe: false },
} as const;
/**
 * Categorias com que a empresa começa (trabalho em altura, espaço confinado, resgate e
 * treinamentos). `kind` é o tipo de item que a tela sugere ao escolher a categoria; `template`,
 * o roteiro de inspeção que o item novo já recebe. A empresa edita, inativa e cria as suas.
 */
export const DEFAULT_CATEGORIES: Array<{ name: string; prefix: string; kind: string; template?: string; children?: Array<{ name: string; prefix: string; kind: string; template?: string }> }> = [
  { name: 'Trabalho em altura', prefix: 'ALT', kind: 'reutilizavel', children: [
    { name: 'Cordas', prefix: 'CRD', kind: 'reutilizavel', template: 'Corda' },
    { name: 'Cinturões e talabartes', prefix: 'CIN', kind: 'reutilizavel', template: 'Cinturão' },
    { name: 'Trava-quedas e descensores', prefix: 'TQD', kind: 'reutilizavel', template: 'Trava-quedas' },
    { name: 'Mosquetões e conectores', prefix: 'MOS', kind: 'reutilizavel', template: 'Mosquetão' },
    { name: 'Polias e bloqueadores', prefix: 'POL', kind: 'reutilizavel', template: 'Polia' },
    { name: 'Ancoragens e fitas', prefix: 'ANC', kind: 'reutilizavel' },
  ] },
  { name: 'Espaço confinado e resgate', prefix: 'RES', kind: 'reutilizavel', children: [
    { name: 'Tripés e guinchos', prefix: 'TRI', kind: 'reutilizavel', template: 'Tripé' },
    { name: 'Macas e imobilização', prefix: 'MAC', kind: 'reutilizavel' },
    { name: 'Ventilação e exaustão', prefix: 'VEN', kind: 'ferramenta' },
    { name: 'Proteção respiratória autônoma', prefix: 'AUT', kind: 'calibravel' },
  ] },
  { name: 'Detecção de gases e medição', prefix: 'GAS', kind: 'calibravel', template: 'Detector' },
  { name: 'EPI', prefix: 'EPI', kind: 'epi', children: [
    { name: 'Capacetes', prefix: 'CAP', kind: 'epi' },
    { name: 'Luvas', prefix: 'LUV', kind: 'epi' },
    { name: 'Proteção visual e auditiva', prefix: 'OLH', kind: 'epi' },
    { name: 'Proteção respiratória', prefix: 'RSP', kind: 'epi' },
    { name: 'Vestimentas e calçados', prefix: 'VES', kind: 'epi' },
  ] },
  { name: 'Sinalização e isolamento', prefix: 'SIN', kind: 'consumivel' },
  { name: 'Consumíveis de obra', prefix: 'CSM', kind: 'consumivel' },
  { name: 'Ferramentas', prefix: 'FER', kind: 'ferramenta' },
  { name: 'Iluminação e rádios', prefix: 'ILU', kind: 'ferramenta' },
  { name: 'Treinamento (CT)', prefix: 'TRE', kind: 'ferramenta' },
];

const BOOL_FIELDS = ['returnable', 'requiresInspection', 'inspectionBeforeUse', 'requiresCalibration', 'isPpe', 'rentable'] as const;

@Injectable()
export class StockCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ categorias

  /** Empresa que nunca teve categoria começa com as padrão (e não ganha de novo se inativar todas). */
  async ensureCategories(companyId: number) {
    if (await this.prisma.stock_Category.count({ where: { companyId } })) return;
    await this.ensureTemplates(companyId);
    const templates = await this.prisma.stock_InspectionTemplate.findMany({ where: { companyId }, select: { id: true, name: true } });
    const templateOf = (start?: string) => (start ? templates.find((t) => t.name.toLowerCase().startsWith(start.toLowerCase()))?.id ?? null : null);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(740127::int, ${companyId}::int)`;
      if (await tx.stock_Category.count({ where: { companyId } })) return;
      for (const [index, category] of DEFAULT_CATEGORIES.entries()) {
        const parent = await tx.stock_Category.create({ data: {
          companyId, name: category.name, prefix: category.prefix, order: index * 10, defaults: { kind: category.kind }, inspectionTemplateId: templateOf(category.template),
        } });
        for (const [childIndex, child] of (category.children ?? []).entries()) {
          await tx.stock_Category.create({ data: {
            companyId, name: child.name, prefix: child.prefix, parentId: parent.id, order: index * 10 + childIndex + 1, defaults: { kind: child.kind }, inspectionTemplateId: templateOf(child.template),
          } });
        }
      }
    });
  }

  async categories(actor: StockActor, query: Record<string, string> = {}) {
    await this.ensureCategories(actor.companyId);
    const rows = await this.prisma.stock_Category.findMany({
      where: { companyId: actor.companyId, ...(query.all === '1' ? {} : { inactiveAt: null }) }, orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });
    const counts = await this.prisma.stock_Item.groupBy({ by: ['categoryId'], where: { companyId: actor.companyId, inactiveAt: null }, _count: { _all: true } });
    const countOf = new Map(counts.map((c) => [c.categoryId, c._count._all]));
    const nameOf = new Map(rows.map((r) => [r.id, r.name]));
    return rows.map((row) => ({
      id: row.id, name: row.name, parentId: row.parentId, parent: row.parentId ? nameOf.get(row.parentId) ?? null : null,
      fullName: row.parentId ? `${nameOf.get(row.parentId) ?? ''} › ${row.name}` : row.name,
      prefix: row.prefix, defaults: row.defaults, inspectionTemplateId: row.inspectionTemplateId, order: row.order,
      items: countOf.get(row.id) ?? 0, active: !row.inactiveAt,
    }));
  }

  private async categoryData(actor: StockActor, body: Body, currentId?: number): Promise<Prisma.Stock_CategoryUncheckedUpdateInput> {
    const data: Prisma.Stock_CategoryUncheckedUpdateInput = {};
    if ('name' in body || !currentId) {
      data.name = clean(body.name, 100);
      if (String(data.name).length < 2) fail('Informe o nome da categoria');
    }
    if ('parentId' in body) {
      const parentId = idOf(body.parentId);
      if (parentId) {
        if (parentId === currentId) fail('A categoria não pode ser filha dela mesma');
        const parent = await this.prisma.stock_Category.findFirst({ where: { id: parentId, companyId: actor.companyId } });
        if (!parent) fail('Categoria de cima não encontrada');
        if (parent!.parentId) fail('Só um nível de subcategoria');
      }
      data.parentId = parentId;
    }
    if ('prefix' in body) data.prefix = clean(body.prefix, 8).toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
    if ('defaults' in body) data.defaults = body.defaults && typeof body.defaults === 'object' ? (body.defaults as Prisma.InputJsonValue) : Prisma.JsonNull;
    if ('inspectionTemplateId' in body) data.inspectionTemplateId = idOf(body.inspectionTemplateId);
    if ('order' in body) data.order = Number(body.order) || 0;
    return data;
  }

  async createCategory(actor: StockActor, body: Body) {
    const data = await this.categoryData(actor, body);
    const row = await this.prisma.stock_Category.create({ data: { ...(data as Prisma.Stock_CategoryUncheckedCreateInput), companyId: actor.companyId } });
    return (await this.categories(actor, { all: '1' })).find((c) => c.id === row.id);
  }

  async updateCategory(actor: StockActor, id: number, body: Body) {
    await this.byCategory(actor, id);
    await this.prisma.stock_Category.update({ where: { id }, data: await this.categoryData(actor, body, id) });
    return (await this.categories(actor, { all: '1' })).find((c) => c.id === id);
  }

  async setCategoryActive(actor: StockActor, id: number, active: boolean) {
    await this.byCategory(actor, id);
    await this.prisma.stock_Category.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } });
    return { ok: true };
  }

  private async byCategory(actor: StockActor, id: number) {
    const row = await this.prisma.stock_Category.findFirst({ where: { id, companyId: actor.companyId } });
    if (!row) throw new NotFoundException('Categoria não encontrada');
    return row;
  }

  // ------------------------------------------------------------------ locais

  /** Empresa nova nasce com um almoxarifado, para nada travar. */
  async ensureLocation(companyId: number) {
    const any = await this.prisma.stock_Location.count({ where: { companyId } });
    if (!any) await this.prisma.stock_Location.create({ data: { companyId, name: 'Almoxarifado', kind: 'almoxarifado' } });
  }

  async locations(actor: StockActor, query: Record<string, string> = {}) {
    await this.ensureLocation(actor.companyId);
    const rows = await this.prisma.stock_Location.findMany({
      where: { companyId: actor.companyId, ...(query.all === '1' ? {} : { inactiveAt: null }) }, orderBy: { name: 'asc' },
    });
    const [balances, places, users] = await Promise.all([
      this.prisma.stock_Balance.groupBy({ by: ['holderId'], where: { companyId: actor.companyId, holderType: 'local', quantity: { gt: 0 } }, _count: { _all: true } }),
      this.prisma.company_Place.findMany({ where: { companyId: actor.companyId, id: { in: rows.map((r) => r.placeId).filter((x): x is number => !!x) } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.responsibleUserId).filter((x): x is number => !!x) } }, select: { id: true, name: true } }),
    ]);
    const itemsAt = new Map(balances.map((b) => [b.holderId, b._count._all]));
    const placeOf = new Map(places.map((p) => [p.id, p.name])), userOf = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((row) => ({
      id: row.id, name: row.name, kind: row.kind, kindLabel: LOCATION_KINDS[row.kind as keyof typeof LOCATION_KINDS] ?? row.kind,
      placeId: row.placeId, place: row.placeId ? placeOf.get(row.placeId) ?? null : null,
      responsibleUserId: row.responsibleUserId, responsible: row.responsibleUserId ? userOf.get(row.responsibleUserId) ?? null : null,
      sellsOnline: row.sellsOnline, notes: row.notes, items: itemsAt.get(row.id) ?? 0, active: !row.inactiveAt,
    }));
  }

  private async locationData(actor: StockActor, body: Body, isNew: boolean): Promise<Prisma.Stock_LocationUncheckedUpdateInput> {
    const data: Prisma.Stock_LocationUncheckedUpdateInput = {};
    if ('name' in body || isNew) {
      data.name = clean(body.name, 120);
      if (String(data.name).length < 2) fail('Informe o nome do local');
    }
    if ('kind' in body) {
      if (!(String(body.kind) in LOCATION_KINDS)) fail('Tipo de local inválido');
      data.kind = String(body.kind);
    }
    if ('placeId' in body) {
      const placeId = idOf(body.placeId);
      if (placeId && !(await this.prisma.company_Place.count({ where: { id: placeId, companyId: actor.companyId } }))) fail('Lugar não encontrado');
      data.placeId = placeId;
    }
    if ('responsibleUserId' in body) data.responsibleUserId = idOf(body.responsibleUserId);
    if ('sellsOnline' in body) data.sellsOnline = body.sellsOnline === true || body.sellsOnline === 'true';
    if ('notes' in body) data.notes = text(body.notes, 500) || null;
    return data;
  }

  async createLocation(actor: StockActor, body: Body) {
    const row = await this.prisma.stock_Location.create({ data: { ...((await this.locationData(actor, body, true)) as Prisma.Stock_LocationUncheckedCreateInput), companyId: actor.companyId } });
    return (await this.locations(actor, { all: '1' })).find((l) => l.id === row.id);
  }

  async updateLocation(actor: StockActor, id: number, body: Body) {
    await this.byLocation(actor, id);
    await this.prisma.stock_Location.update({ where: { id }, data: await this.locationData(actor, body, false) });
    return (await this.locations(actor, { all: '1' })).find((l) => l.id === id);
  }

  async setLocationActive(actor: StockActor, id: number, active: boolean) {
    await this.byLocation(actor, id);
    if (!active) {
      const left = await this.prisma.stock_Balance.count({ where: { companyId: actor.companyId, holderType: 'local', holderId: id, quantity: { gt: 0 } } });
      if (left) throw new ConflictException(`O local ainda tem ${left} item(ns) com saldo: transfira antes de inativar`);
    }
    await this.prisma.stock_Location.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } });
    return { ok: true };
  }

  private async byLocation(actor: StockActor, id: number) {
    const row = await this.prisma.stock_Location.findFirst({ where: { id, companyId: actor.companyId } });
    if (!row) throw new NotFoundException('Local não encontrado');
    return row;
  }

  // ------------------------------------------------------------------ itens

  async byItem(companyId: number, id: number): Promise<Stock_Item> {
    const row = await this.prisma.stock_Item.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException('Item não encontrado');
    return row;
  }

  /** Saldo total, em estoque (locais) e fora (obra, funcionário, locação, fornecedor), por item. */
  async totals(companyId: number, itemIds?: number[]) {
    const rows = await this.prisma.stock_Balance.groupBy({
      by: ['itemId', 'holderType'], where: { companyId, quantity: { not: 0 }, ...(itemIds ? { itemId: { in: itemIds } } : {}) }, _sum: { quantity: true },
    });
    const map = new Map<number, { inStock: number; out: number }>();
    for (const row of rows) {
      const entry = map.get(row.itemId) ?? { inStock: 0, out: 0 };
      if (row.holderType === 'local') entry.inStock = round3(entry.inStock + num(row._sum.quantity));
      else entry.out = round3(entry.out + num(row._sum.quantity));
      map.set(row.itemId, entry);
    }
    return map;
  }

  /** Disponível em local: em item por unidade, só peças disponíveis contam. */
  async available(companyId: number, itemIds: number[]) {
    const units = await this.prisma.stock_Unit.groupBy({ by: ['itemId'], where: { companyId, itemId: { in: itemIds }, holderType: 'local', status: 'disponivel' }, _count: { _all: true } });
    return new Map(units.map((u) => [u.itemId, u._count._all]));
  }

  present(item: Stock_Item, actor: StockActor, extra: Record<string, unknown> = {}) {
    const costs = can(actor, PERM.costs);
    return {
      id: item.id, code: item.code, name: item.name, description: item.description, categoryId: item.categoryId,
      manufacturer: item.manufacturer, model: item.model, photoUrl: item.photoUrl, unit: item.unit,
      purchaseUnit: item.purchaseUnit, purchaseFactor: item.purchaseFactor === null ? null : num(item.purchaseFactor),
      tracking: item.tracking, returnable: item.returnable,
      minQuantity: item.minQuantity === null ? null : num(item.minQuantity), reorderQuantity: item.reorderQuantity === null ? null : num(item.reorderQuantity),
      requiresInspection: item.requiresInspection, inspectionIntervalDays: item.inspectionIntervalDays, inspectionBeforeUse: item.inspectionBeforeUse,
      inspectionTemplateId: item.inspectionTemplateId, lifeMonths: item.lifeMonths, lifeFrom: item.lifeFrom, warnDays: item.warnDays,
      requiresCalibration: item.requiresCalibration, calibrationIntervalMonths: item.calibrationIntervalMonths,
      isPpe: item.isPpe, caNumber: item.caNumber, caExpiry: d(item.caExpiry), caState: dueState(d(item.caExpiry), item.warnDays), replaceEveryDays: item.replaceEveryDays,
      rentable: item.rentable, rentDaily: item.rentDaily === null ? null : num(item.rentDaily), rentWeekly: item.rentWeekly === null ? null : num(item.rentWeekly),
      rentMonthly: item.rentMonthly === null ? null : num(item.rentMonthly), replacementValue: item.replacementValue === null ? null : num(item.replacementValue),
      rentPriceMode: item.rentPriceMode, rentMode: item.rentMode, minRentPeriod: item.minRentPeriod, economicLifeMonths: item.economicLifeMonths,
      residualRate: item.residualRate === null ? null : num(item.residualRate), maintenanceRate: item.maintenanceRate === null ? null : num(item.maintenanceRate),
      inspectionCost: costs && item.inspectionCost !== null ? num(item.inspectionCost) : null, calibrationCost: costs && item.calibrationCost !== null ? num(item.calibrationCost) : null,
      lossRate: item.lossRate === null ? null : num(item.lossRate), handlingCost: costs && item.handlingCost !== null ? num(item.handlingCost) : null,
      occupancy: item.occupancy === null ? null : num(item.occupancy),
      siteProductId: item.siteProductId, notes: item.notes, active: !item.inactiveAt,
      averageCost: costs ? num(item.averageCost) : null, lastCost: costs && item.lastCost !== null ? num(item.lastCost) : null,
      lastPurchaseAt: d(item.lastPurchaseAt),
      ...extra,
    };
  }

  async items(actor: StockActor, query: Record<string, string>) {
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 30));
    const term = clean(query.search, 80);
    const categoryId = idOf(query.categoryId);
    const childIds = categoryId ? (await this.prisma.stock_Category.findMany({ where: { companyId: actor.companyId, parentId: categoryId }, select: { id: true } })).map((c) => c.id) : [];
    const where: Prisma.Stock_ItemWhereInput = {
      companyId: actor.companyId,
      ...(query.status === 'inativos' ? { inactiveAt: { not: null } } : query.status === 'todos' ? {} : { inactiveAt: null }),
      ...(term ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { code: { contains: term, mode: 'insensitive' } }, { manufacturer: { contains: term, mode: 'insensitive' } }] } : {}),
      ...(categoryId ? { categoryId: { in: [categoryId, ...childIds] } } : {}),
      ...((TRACKINGS as readonly string[]).includes(query.tracking) ? { tracking: query.tracking } : {}),
      ...(query.flag === 'epi' ? { isPpe: true } : query.flag === 'inspecao' ? { requiresInspection: true } : query.flag === 'calibracao' ? { requiresCalibration: true }
        : query.flag === 'alugavel' ? { rentable: true } : query.flag === 'loja' ? { siteProductId: { not: null } } : {}),
    };
    let rows = await this.prisma.stock_Item.findMany({ where, orderBy: [{ name: 'asc' }] });
    const totals = await this.totals(actor.companyId, rows.map((r) => r.id));
    const units = await this.available(actor.companyId, rows.filter((r) => r.tracking === 'unidade').map((r) => r.id));
    const availableOf = (item: Stock_Item) => (item.tracking === 'unidade' ? units.get(item.id) ?? 0 : totals.get(item.id)?.inStock ?? 0);
    const low = (item: Stock_Item) => item.minQuantity !== null && availableOf(item) < num(item.minQuantity);
    if (query.low === '1') rows = rows.filter(low);
    const categories = await this.prisma.stock_Category.findMany({ where: { companyId: actor.companyId }, select: { id: true, name: true } });
    const categoryOf = new Map(categories.map((c) => [c.id, c.name]));
    const costs = can(actor, PERM.costs);
    const lowCount = (await this.prisma.stock_Item.findMany({ where: { companyId: actor.companyId, inactiveAt: null, minQuantity: { not: null } } })).filter(low).length;
    const value = costs ? round2(rows.reduce((sum, item) => sum + ((totals.get(item.id)?.inStock ?? 0) + (totals.get(item.id)?.out ?? 0)) * num(item.averageCost), 0)) : null;
    return {
      total: rows.length, lowCount, value,
      rows: rows.slice(page * limit, page * limit + limit).map((item) => this.present(item, actor, {
        category: item.categoryId ? categoryOf.get(item.categoryId) ?? null : null,
        inStock: totals.get(item.id)?.inStock ?? 0, out: totals.get(item.id)?.out ?? 0, available: availableOf(item), low: low(item),
      })),
    };
  }

  /** Lista enxuta para escolher item (romaneio, pedido de compra, entrega): sem custo. */
  async itemOptions(actor: StockActor, query: Record<string, string>) {
    const locationId = idOf(query.locationId);
    const rows = await this.prisma.stock_Item.findMany({
      where: {
        companyId: actor.companyId, inactiveAt: null,
        ...(query.flag === 'epi' ? { isPpe: true } : query.flag === 'alugavel' ? { rentable: true } : query.flag === 'retornavel' ? { returnable: true } : {}),
      },
      orderBy: { name: 'asc' }, select: { id: true, code: true, name: true, unit: true, tracking: true, returnable: true, isPpe: true, rentable: true, lastCost: true, rentDaily: true, rentWeekly: true, rentMonthly: true, averageCost: true, rentPriceMode: true, rentMode: true, minRentPeriod: true, _count: { select: { components: true } } },
    });
    const balances = await this.prisma.stock_Balance.groupBy({
      by: ['itemId'], where: { companyId: actor.companyId, holderType: 'local', quantity: { gt: 0 }, ...(locationId ? { holderId: locationId } : {}) }, _sum: { quantity: true },
    });
    const has = new Map(balances.map((b) => [b.itemId, round3(num(b._sum.quantity))]));
    const costs = can(actor, PERM.costs);
    return rows.map((row) => ({
      id: row.id, code: row.code, name: `${row.code} — ${row.name}`, label: row.name, unit: row.unit, tracking: row.tracking, returnable: row.returnable,
      isPpe: row.isPpe, rentable: row.rentable, available: has.get(row.id) ?? 0,
      lastCost: row.lastCost === null ? null : num(row.lastCost), averageCost: costs ? num(row.averageCost) : null,
      rent: { dia: row.rentDaily === null ? null : num(row.rentDaily), semana: row.rentWeekly === null ? null : num(row.rentWeekly), mes: row.rentMonthly === null ? null : num(row.rentMonthly) },
      rentPriceMode: row.rentPriceMode, rentMode: row.rentMode, minRentPeriod: row.minRentPeriod, isKit: row._count.components > 0,
    }));
  }

  /** Código sugerido pelo prefixo da categoria (ou IT): CRD-0001. */
  private async nextCode(companyId: number, categoryId: number | null) {
    const category = categoryId ? await this.prisma.stock_Category.findFirst({ where: { id: categoryId, companyId } }) : null;
    const prefix = category?.prefix || 'IT';
    const codes = await this.prisma.stock_Item.findMany({ where: { companyId, code: { startsWith: `${prefix}-` } }, select: { code: true } });
    const max = codes.reduce((m, c) => Math.max(m, Number(/-(\d+)$/.exec(c.code)?.[1] ?? 0)), 0);
    return `${prefix}-${String(max + 1).padStart(4, '0')}`;
  }

  private async itemData(actor: StockActor, body: Body, current: Stock_Item | null): Promise<Prisma.Stock_ItemUncheckedUpdateInput> {
    let presetKey = String(body.preset ?? '');
    if (!current && !presetKey && body.categoryId) {
      // sem tipo escolhido: vale o que a categoria sugere
      const category = await this.prisma.stock_Category.findFirst({ where: { id: Number(body.categoryId) || 0, companyId: actor.companyId }, select: { defaults: true } });
      presetKey = String((category?.defaults as Body | null)?.kind ?? '');
    }
    const preset = current ? null : ITEM_PRESETS[presetKey as keyof typeof ITEM_PRESETS] ?? null;
    const input: Body = { ...(preset ?? {}), ...body };
    const data: Prisma.Stock_ItemUncheckedUpdateInput = {};
    if ('name' in input || !current) {
      data.name = clean(input.name, 200);
      if (String(data.name).length < 2) fail('Informe o nome do item');
    }
    if ('categoryId' in input) {
      const categoryId = idOf(input.categoryId);
      if (categoryId && !(await this.prisma.stock_Category.count({ where: { id: categoryId, companyId: actor.companyId } }))) fail('Categoria não encontrada');
      data.categoryId = categoryId;
    }
    if ('code' in input && !blank(input.code)) {
      data.code = clean(input.code, 30).toUpperCase();
      const clash = await this.prisma.stock_Item.findFirst({ where: { companyId: actor.companyId, code: String(data.code), NOT: current ? { id: current.id } : undefined } });
      if (clash) throw new ConflictException(`O código ${data.code} já é do item ${clash.name}`);
    }
    for (const key of ['description', 'notes'] as const) if (key in input) data[key] = text(input[key], key === 'description' ? 2000 : 1000) || null;
    for (const key of ['manufacturer', 'model'] as const) if (key in input) data[key] = clean(input[key], 120) || null;
    if ('photoUrl' in input) data.photoUrl = clean(input.photoUrl, 500) || null;
    if ('unit' in input) data.unit = clean(input.unit, 20) || 'un';
    if ('purchaseUnit' in input) data.purchaseUnit = clean(input.purchaseUnit, 20) || null;
    if ('purchaseFactor' in input) data.purchaseFactor = optionalNumber(input.purchaseFactor, 'Fator de compra', { min: 0.0001 });
    if ('tracking' in input) {
      if (!(TRACKINGS as readonly string[]).includes(String(input.tracking))) fail('Forma de controle inválida');
      if (current && current.tracking !== input.tracking) {
        const moved = await this.prisma.stock_MovementLine.count({ where: { itemId: current.id } });
        if (moved) throw new ConflictException('O item já tem movimentações: a forma de controle não muda mais');
      }
      data.tracking = String(input.tracking);
    }
    for (const key of BOOL_FIELDS) if (key in input) data[key] = input[key] === true || input[key] === 'true';
    if ('minQuantity' in input) data.minQuantity = optionalNumber(input.minQuantity, 'Estoque mínimo');
    if ('reorderQuantity' in input) data.reorderQuantity = optionalNumber(input.reorderQuantity, 'Quantidade de reposição');
    if ('inspectionIntervalDays' in input) data.inspectionIntervalDays = optionalNumber(input.inspectionIntervalDays, 'Intervalo de inspeção', { min: 1, max: 3650, int: true });
    if ('inspectionTemplateId' in input) data.inspectionTemplateId = idOf(input.inspectionTemplateId);
    if ('lifeMonths' in input) data.lifeMonths = optionalNumber(input.lifeMonths, 'Vida útil', { min: 1, max: 600, int: true });
    if ('lifeFrom' in input) data.lifeFrom = input.lifeFrom === 'primeiro_uso' ? 'primeiro_uso' : 'fabricacao';
    if ('warnDays' in input) data.warnDays = optionalNumber(input.warnDays, 'Dias de aviso', { min: 0, max: 365, int: true }) ?? 30;
    if ('calibrationIntervalMonths' in input) data.calibrationIntervalMonths = optionalNumber(input.calibrationIntervalMonths, 'Intervalo de calibração', { min: 1, max: 120, int: true });
    if ('caNumber' in input) data.caNumber = clean(input.caNumber, 30) || null;
    if ('caExpiry' in input) data.caExpiry = optionalDate(input.caExpiry, 'Validade do CA');
    if ('replaceEveryDays' in input) data.replaceEveryDays = optionalNumber(input.replaceEveryDays, 'Troca a cada', { min: 1, max: 3650, int: true });
    for (const key of ['rentDaily', 'rentWeekly', 'rentMonthly', 'replacementValue'] as const) if (key in input) data[key] = optionalNumber(input[key], 'Valor');
    // base de cálculo da locação (plano 09): vazio = padrão da categoria e da base
    if ('rentPriceMode' in input) data.rentPriceMode = input.rentPriceMode === 'manual' ? 'manual' : 'calculado';
    if ('rentMode' in input) data.rentMode = ['locacao', 'com_operador'].includes(String(input.rentMode)) ? String(input.rentMode) : 'ambos';
    if ('minRentPeriod' in input) data.minRentPeriod = ['dia', 'semana', 'mes'].includes(String(input.minRentPeriod)) ? String(input.minRentPeriod) : null;
    if ('economicLifeMonths' in input) data.economicLifeMonths = optionalNumber(input.economicLifeMonths, 'Vida econômica', { min: 1, max: 600, int: true });
    if ('residualRate' in input) data.residualRate = optionalNumber(input.residualRate, 'Valor residual', { min: 0, max: 1 });
    if ('maintenanceRate' in input) data.maintenanceRate = optionalNumber(input.maintenanceRate, 'Manutenção ao ano', { min: 0, max: 2 });
    if ('inspectionCost' in input) data.inspectionCost = optionalNumber(input.inspectionCost, 'Custo da inspeção');
    if ('calibrationCost' in input) data.calibrationCost = optionalNumber(input.calibrationCost, 'Custo da calibração');
    if ('lossRate' in input) data.lossRate = optionalNumber(input.lossRate, 'Perdas por mês alugado', { min: 0, max: 1 });
    if ('handlingCost' in input) data.handlingCost = optionalNumber(input.handlingCost, 'Preparação por locação');
    if ('occupancy' in input) data.occupancy = optionalNumber(input.occupancy, 'Ocupação', { min: 0.01, max: 1 });
    if ('siteProductId' in input) {
      const productId = idOf(input.siteProductId);
      if (productId) {
        if (!(await this.prisma.site_Products.count({ where: { id: productId, companyId: actor.companyId } }))) fail('Produto da loja não encontrado');
        const clash = await this.prisma.stock_Item.findFirst({ where: { siteProductId: productId, NOT: current ? { id: current.id } : undefined } });
        if (clash) throw new ConflictException(`Esse produto da loja já está ligado ao item ${clash.name}`);
      }
      data.siteProductId = productId;
    }
    // um item que volta não é consumível; calibração e inspeção pedem item que volta
    const tracking = String(data.tracking ?? current?.tracking ?? 'quantidade');
    const returnable = Boolean(data.returnable ?? current?.returnable);
    if (tracking === 'unidade' && data.returnable === undefined && !current) data.returnable = true;
    if ((data.requiresCalibration ?? current?.requiresCalibration) && tracking !== 'unidade') fail('Item com calibração precisa ser controlado por unidade');
    if ((data.rentable ?? current?.rentable) && !(returnable || tracking === 'unidade' || data.returnable)) fail('Item alugável precisa voltar (marque "volta depois de sair")');
    return data;
  }

  async createItem(actor: StockActor, body: Body) {
    const data = await this.itemData(actor, body, null);
    const code = (data.code as string | undefined) ?? (await this.nextCode(actor.companyId, (data.categoryId as number | null) ?? null));
    // item que exige inspeção nasce com um roteiro: o da categoria, ou o que começa pela mesma palavra do nome
    if (data.requiresInspection && !data.inspectionTemplateId) {
      await this.ensureTemplates(actor.companyId);
      const category = data.categoryId ? await this.prisma.stock_Category.findUnique({ where: { id: Number(data.categoryId) }, select: { inspectionTemplateId: true } }) : null;
      const word = String(data.name ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      const byName = word.length >= 3 ? (await this.prisma.stock_InspectionTemplate.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, select: { id: true, name: true } })).find((t) => t.name.toLowerCase().startsWith(word)) : null;
      data.inspectionTemplateId = category?.inspectionTemplateId ?? byName?.id ?? null;
    }
    const row = await this.prisma.stock_Item.create({ data: { ...(data as Prisma.Stock_ItemUncheckedCreateInput), code, companyId: actor.companyId } });
    if ('components' in body) await this.saveComponents(actor.companyId, row.id, body.components);
    await this.refreshRentPrices(actor.companyId, row.id);
    return this.item(actor, row.id);
  }

  /** Componentes do kit (substitui a lista). Um kit não entra em outro kit. */
  private async saveComponents(companyId: number, kitId: number, raw: unknown) {
    const list: Body[] = Array.isArray(raw) ? raw : [];
    if (list.length > 60) fail('Componentes demais no kit');
    const seen = new Set<number>();
    const rows: Array<{ componentId: number; quantity: number }> = [];
    for (const [index, entry] of list.entries()) {
      const componentId = idOf(entry.itemId ?? entry.componentId);
      if (!componentId) fail(`Componente ${index + 1}: escolha o item`);
      if (componentId === kitId) fail('O kit não pode ser componente dele mesmo');
      if (seen.has(componentId!)) fail('Componente repetido no kit');
      seen.add(componentId!);
      const component = await this.prisma.stock_Item.findFirst({ where: { id: componentId!, companyId }, select: { id: true, name: true, _count: { select: { components: true } } } });
      if (!component) fail(`Componente ${index + 1}: item não encontrado`);
      if (component!._count.components) fail(`${component!.name} já é um kit: kit não entra em outro kit`);
      const quantity = optionalNumber(entry.quantity ?? 1, `Quantidade de ${component!.name}`, { min: 0.001 }) ?? 1;
      rows.push({ componentId: componentId!, quantity });
    }
    if (rows.length && (await this.prisma.stock_KitComponent.count({ where: { componentId: kitId } }))) fail('Este item é componente de um kit: ele não pode ser um kit também');
    await this.prisma.$transaction([
      this.prisma.stock_KitComponent.deleteMany({ where: { kitItemId: kitId } }),
      this.prisma.stock_KitComponent.createMany({ data: rows.map((r, order) => ({ ...r, companyId, kitItemId: kitId, order })) }),
    ]);
  }

  /** Modo "calculado": grava dia, semana e mês sugeridos pela base (a loja e a locação avulsa leem daqui). */
  private async refreshRentPrices(companyId: number, id: number) {
    const item = await this.prisma.stock_Item.findUnique({ where: { id }, select: { rentable: true, rentPriceMode: true } });
    if (!item?.rentable || item.rentPriceMode !== 'calculado') return;
    const prices = await suggestedRentPrices(this.prisma, companyId, id);
    if (!prices || prices.error || !('month' in prices)) return;
    await this.prisma.stock_Item.update({ where: { id }, data: { rentDaily: prices.day, rentWeekly: prices.week, rentMonthly: prices.month } });
  }

  /** Recalcula os preços de todos os itens alugáveis no modo calculado (depois de mudar a base). */
  async refreshAllRentPrices(actor: StockActor) {
    const rows = await this.prisma.stock_Item.findMany({ where: { companyId: actor.companyId, rentable: true, rentPriceMode: 'calculado', inactiveAt: null }, select: { id: true } });
    for (const row of rows) await this.refreshRentPrices(actor.companyId, row.id);
    return { updated: rows.length };
  }

  /** Valores de pesquisa (plano 09) para preencher item ou categoria. */
  rentalPresets() {
    return Object.entries(RENTAL_PRESETS).map(([key, preset]) => ({ key, ...preset }));
  }

  async updateItem(actor: StockActor, id: number, body: Body) {
    const current = await this.byItem(actor.companyId, id);
    await this.prisma.stock_Item.update({ where: { id }, data: await this.itemData(actor, body, current) });
    if ('components' in body) await this.saveComponents(actor.companyId, id, body.components);
    await this.refreshRentPrices(actor.companyId, id);
    return this.item(actor, id);
  }

  async setItemActive(actor: StockActor, id: number, active: boolean) {
    await this.byItem(actor.companyId, id);
    if (!active) {
      const left = await this.prisma.stock_Balance.aggregate({ where: { itemId: id }, _sum: { quantity: true } });
      if (num(left._sum.quantity) > 0) throw new ConflictException('O item ainda tem saldo: dê baixa ou ajuste antes de inativar');
    }
    await this.prisma.stock_Item.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } });
    return { ok: true };
  }

  /** Ficha do item: dados, saldos por posição e lote, unidades e compras. */
  async item(actor: StockActor, id: number) {
    const item = await this.byItem(actor.companyId, id);
    const [balances, lots, category, product] = await Promise.all([
      this.prisma.stock_Balance.findMany({ where: { itemId: id, quantity: { not: 0 } } }),
      this.prisma.stock_Lot.findMany({ where: { itemId: id }, orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }] }),
      item.categoryId ? this.prisma.stock_Category.findUnique({ where: { id: item.categoryId }, select: { name: true } }) : null,
      item.siteProductId ? this.prisma.site_Products.findUnique({ where: { id: item.siteProductId }, select: { id: true, name: true, active: true } }) : null,
    ]);
    const holders: Holder[] = balances.map((b) => ({ type: b.holderType as HolderType, id: b.holderId }));
    const names = await holderNames(this.prisma, actor.companyId, holders);
    const lotOf = new Map(lots.map((l) => [l.id, l]));
    const totals = (await this.totals(actor.companyId, [id])).get(id) ?? { inStock: 0, out: 0 };
    const available = item.tracking === 'unidade' ? (await this.available(actor.companyId, [id])).get(id) ?? 0 : totals.inStock;
    const components = await this.prisma.stock_KitComponent.findMany({ where: { kitItemId: id }, include: { component: { select: { id: true, code: true, name: true } } }, orderBy: [{ order: 'asc' }, { id: 'asc' }] });
    const partOf = await this.prisma.stock_KitComponent.findMany({ where: { componentId: id }, include: { kit: { select: { id: true, code: true, name: true } } } });
    return this.present(item, actor, {
      components: components.map((c) => ({ itemId: c.componentId, code: c.component.code, name: c.component.name, quantity: num(c.quantity) })),
      partOf: partOf.map((p) => ({ id: p.kit.id, code: p.kit.code, name: p.kit.name })),
      rentalPrice: item.rentable && can(actor, PERM.costs) ? await suggestedRentPrices(this.prisma, actor.companyId, id) : null,
      category: category?.name ?? null, inStock: totals.inStock, out: totals.out, available,
      low: item.minQuantity !== null && available < num(item.minQuantity),
      product, balances: balances.map((b) => ({
        holderType: b.holderType, holderId: b.holderId, holder: names.get(holderKey({ type: b.holderType, id: b.holderId })) ?? '—',
        lotId: b.lotId || null, lot: b.lotId ? lotOf.get(b.lotId)?.number ?? null : null, quantity: num(b.quantity),
      })).sort((a, b) => (a.holderType === 'local' ? 0 : 1) - (b.holderType === 'local' ? 0 : 1) || a.holder.localeCompare(b.holder)),
      lots: lots.map((l) => ({
        id: l.id, number: l.number, manufacturedAt: d(l.manufacturedAt), expiresAt: d(l.expiresAt), expiryState: dueState(d(l.expiresAt), item.warnDays),
        status: l.status, nextInspectionAt: d(l.nextInspectionAt), inspectionState: item.requiresInspection ? dueState(d(l.nextInspectionAt), item.warnDays) ?? 'vencido' : null,
        quantity: round3(balances.filter((b) => b.lotId === l.id).reduce((s, b) => s + num(b.quantity), 0)),
      })),
    });
  }

  /** Kardex do item: cada linha com o saldo do item depois dela (em todas as posições internas). */
  async kardex(actor: StockActor, id: number, query: Record<string, string>) {
    await this.byItem(actor.companyId, id);
    const lines = await this.prisma.stock_MovementLine.findMany({
      where: { itemId: id, companyId: actor.companyId }, orderBy: { id: 'asc' },
      include: { movement: { select: { id: true, number: true, type: true, date: true, userId: true, serviceOrderId: true, purchaseOrderId: true, note: true } } },
    });
    const names = await holderNames(this.prisma, actor.companyId, lines.flatMap((l) => [{ type: l.fromType as HolderType, id: l.fromId }, { type: l.toType as HolderType, id: l.toId }]));
    const unitIds = [...new Set(lines.map((l) => l.unitId).filter((x): x is number => !!x))];
    const units = unitIds.length ? await this.prisma.stock_Unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, tag: true } }) : [];
    const tagOf = new Map(units.map((u) => [u.id, u.tag]));
    let inStock = 0;
    const costs = can(actor, PERM.costs);
    const rows = lines.map((line) => {
      const q = num(line.quantity);
      if (line.toType === 'local') inStock += q;
      if (line.fromType === 'local') inStock -= q;
      const name = (type: string, hid: number | null) => (type === 'externo' ? '—' : names.get(holderKey({ type, id: hid })) ?? type);
      return {
        id: line.id, movementId: line.movement.id, number: line.movement.number, type: line.movement.type,
        typeLabel: MOVEMENT_TYPES[line.movement.type as keyof typeof MOVEMENT_TYPES] ?? line.movement.type, date: d(line.movement.date),
        from: name(line.fromType, line.fromId), fromType: line.fromType, to: name(line.toType, line.toId), toType: line.toType,
        quantity: q, unit: line.unitId ? tagOf.get(line.unitId) ?? null : null,
        unitCost: costs ? num(line.unitCost) : null, totalCost: costs ? num(line.totalCost) : null, inStockAfter: round3(inStock),
      };
    }).reverse();
    const limit = Math.min(500, Number(query.limit) || 200);
    return { rows: rows.slice(0, limit), total: rows.length };
  }

  /** Compras em que o item apareceu (pelo `itemId` na linha do pedido). */
  async purchases(actor: StockActor, id: number) {
    await this.byItem(actor.companyId, id);
    const orders = await this.prisma.$queryRaw<Array<{ id: number; number: string; status: string; supplierId: number | null; purchasedAt: Date | null; createdAt: Date; item: any }>>`
      SELECT p."id", p."number", p."status", p."supplierId", p."purchasedAt", p."createdAt", line AS item
      FROM "Purchase_Order" p, jsonb_array_elements(p."items"::jsonb) AS line
      WHERE p."companyId" = ${actor.companyId} AND p."inactiveAt" IS NULL AND (line->>'itemId')::int = ${id}
      ORDER BY p."id" DESC LIMIT 100`;
    const suppliers = await this.prisma.financial_Supplier.findMany({ where: { id: { in: orders.map((o) => o.supplierId).filter((x): x is number => !!x) } }, select: { id: true, name: true } });
    const supplierOf = new Map(suppliers.map((s) => [s.id, s.name]));
    const costs = can(actor, PERM.costs) || can(actor, 'list_pedidos_de_compra');
    return orders.map((o) => ({
      id: o.id, number: o.number, status: o.status, supplier: o.supplierId ? supplierOf.get(o.supplierId) ?? null : null,
      date: d(o.purchasedAt) ?? d(o.createdAt), quantity: num(o.item?.quantity), unit: o.item?.unit ?? null,
      unitPrice: costs ? num(o.item?.unitPrice) : null, received: num(o.item?.receivedQuantity),
    }));
  }

  /** Opções dos formulários do estoque. */
  async options(actor: StockActor) {
    await this.ensureLocation(actor.companyId);
    const [categories, locations, templates, costCenters, users, places] = await Promise.all([
      this.categories(actor),
      this.prisma.stock_Location.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, kind: true } }),
      this.prisma.stock_InspectionTemplate.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      this.prisma.financial_CostCenter.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true }, take: 500 }),
      this.prisma.company_Place.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    return {
      categories: categories.map((c) => ({ id: c.id, name: c.fullName, parentId: c.parentId, defaults: c.defaults, inspectionTemplateId: c.inspectionTemplateId })),
      locations, templates, costCenters, users, places,
      locationKinds: Object.entries(LOCATION_KINDS).map(([id, name]) => ({ id, name })),
      unitStatuses: Object.entries(UNIT_STATUS).map(([id, name]) => ({ id, name })),
      movementTypes: Object.entries(MOVEMENT_TYPES).map(([id, name]) => ({ id, name })),
      presets: ITEM_PRESETS,
      canSeeCosts: can(actor, PERM.costs),
    };
  }

  /** Os roteiros iniciais nascem na primeira vez que a empresa precisa de um. */
  async ensureTemplates(companyId: number) {
    if (await this.prisma.stock_InspectionTemplate.count({ where: { companyId } })) return;
    await this.prisma.stock_InspectionTemplate.createMany({ data: DEFAULT_TEMPLATES.map((t) => ({ companyId, name: t.name, items: t.items as Prisma.InputJsonValue })), skipDuplicates: true });
  }

  /** Roteiro de cada item: o definido, ou o que começa pela mesma palavra do nome. */
  async templatesFor(companyId: number, items: Array<{ id: number; name: string; inspectionTemplateId: number | null }>) {
    const map = new Map<number, number | null>();
    if (!items.length) return map;
    await this.ensureTemplates(companyId);
    const templates = await this.prisma.stock_InspectionTemplate.findMany({ where: { companyId, inactiveAt: null }, select: { id: true, name: true } });
    for (const item of items) {
      const word = item.name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      map.set(item.id, item.inspectionTemplateId ?? (word.length >= 3 ? templates.find((t) => t.name.toLowerCase().startsWith(word))?.id ?? null : null));
    }
    return map;
  }

  async unitOptions(actor: StockActor, query: Record<string, string>) {
    const itemId = idOf(query.itemId);
    const units = await this.prisma.stock_Unit.findMany({
      where: {
        companyId: actor.companyId, status: { not: 'baixado' }, ...(itemId ? { itemId } : {}),
        ...(query.holderType ? { holderType: query.holderType, ...(idOf(query.holderId) ? { holderId: idOf(query.holderId) } : {}) } : {}),
        ...(query.available === '1' ? { status: 'disponivel', holderType: 'local' } : {}),
      },
      orderBy: { tag: 'asc' }, take: 1000, include: { item: { select: { id: true, name: true, requiresInspection: true, requiresCalibration: true, inspectionTemplateId: true } } },
    });
    const templateOf = await this.templatesFor(actor.companyId, [...new Map(units.map((u) => [u.item.id, u.item])).values()]);
    const names = await holderNames(this.prisma, actor.companyId, units.map((u) => ({ type: u.holderType as HolderType, id: u.holderId })));
    const now = today();
    return units.map((u) => {
      const br = (value: Date | null) => (value ? d(value)!.split('-').reverse().join('/') : '');
      // o motivo em palavras, para a tela mostrar com o atalho certo (inspecionar, calibrar)
      const reason = u.status === 'baixado' ? 'baixada'
        : u.status === 'bloqueado' ? 'bloqueada'
          : u.status === 'em_inspecao' ? 'esperando inspeção'
            : u.status === 'em_calibracao' ? 'em calibração'
              : u.status === 'em_manutencao' ? 'em manutenção'
                : u.status === 'em_uso' ? `em uso (${u.holderType === 'externo' ? 'fora' : names.get(holderKey({ type: u.holderType, id: u.holderId })) ?? 'fora'})`
                  : u.needsInspection ? 'precisa de inspeção extraordinária'
                    : u.item.requiresInspection && !u.nextInspectionAt ? 'sem inspeção registrada'
                      : u.item.requiresInspection && d(u.nextInspectionAt)! < now ? `inspeção venceu em ${br(u.nextInspectionAt)}`
                        : u.item.requiresCalibration && !u.nextCalibrationAt ? 'sem calibração registrada'
                          : u.item.requiresCalibration && d(u.nextCalibrationAt)! < now ? `calibração venceu em ${br(u.nextCalibrationAt)}`
                            : u.lifeEndsAt && d(u.lifeEndsAt)! < now ? `vida útil acabou em ${br(u.lifeEndsAt)}` : null;
      const fix = reason === null ? null
        : /inspeç/.test(reason) ? 'inspecionar' : /calibraç/.test(reason) && u.status !== 'em_calibracao' ? 'calibrar' : null;
      const blocked = reason !== null;
      return {
        id: u.id, name: `${u.tag}${u.serialNumber ? ` · ${u.serialNumber}` : ''}`, tag: u.tag, itemId: u.itemId, item: u.item.name, status: u.status,
        holderType: u.holderType, holderId: u.holderId, where: u.holderType === 'externo' ? '—' : names.get(holderKey({ type: u.holderType, id: u.holderId })) ?? '—',
        usable: !blocked, reason, fix, templateId: templateOf.get(u.itemId) ?? null,
      };
    });
  }

  async lotOptions(actor: StockActor, query: Record<string, string>) {
    const itemId = idOf(query.itemId);
    if (!itemId) return [];
    const lots = await this.prisma.stock_Lot.findMany({ where: { companyId: actor.companyId, itemId, status: { not: 'baixado' } }, orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }] });
    const balances = await this.prisma.stock_Balance.groupBy({
      by: ['lotId'], where: { itemId, lotId: { in: lots.map((l) => l.id) }, holderType: query.holderType || 'local', quantity: { gt: 0 }, ...(idOf(query.locationId ?? query.holderId) ? { holderId: idOf(query.locationId ?? query.holderId)! } : {}) },
      _sum: { quantity: true },
    });
    const has = new Map(balances.map((b) => [b.lotId, round3(num(b._sum.quantity))]));
    return lots.filter((l) => query.all === '1' || (has.get(l.id) ?? 0) > 0).map((l) => ({
      id: l.id, name: `${l.number}${l.expiresAt ? ` · validade ${d(l.expiresAt)!.split('-').reverse().join('/')}` : ''}`, number: l.number,
      expiresAt: d(l.expiresAt), status: l.status, available: has.get(l.id) ?? 0,
    }));
  }

  async suppliers(actor: StockActor, query: Record<string, string>) {
    const term = clean(query.search, 80);
    const rows = await this.prisma.financial_Supplier.findMany({
      where: { companyId: actor.companyId, ...(query.all === '1' ? {} : { inactiveAt: null }), ...(term ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { supplies: { contains: term, mode: 'insensitive' } }] } : {}) },
      orderBy: { name: 'asc' }, take: 1000,
      select: { id: true, name: true, legalName: true, document: true, supplies: true, contactName: true, email: true, phone: true, inactiveAt: true },
    });
    return rows.map(({ inactiveAt, ...row }) => ({ ...row, active: !inactiveAt }));
  }
}
