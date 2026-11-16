import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { LedgerLine, postMovement } from './ledger';
import { Body, EXTERNAL, PERM, StockActor, addDays, blank, can, clean, d, dateOf, fail, holder, idOf, num, round2, round3, text, today } from './stock.rules';

/**
 * Inventário (contagem por local, às cegas ou não, fechando num ajuste único),
 * relatórios do estoque, a ligação com a loja do site e os blocos da Minha esteira.
 */
@Injectable()
export class StockInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ contagens

  async counts(actor: StockActor) {
    const rows = await this.prisma.stock_Count.findMany({ where: { companyId: actor.companyId }, orderBy: { id: 'desc' }, take: 100, include: { lines: { select: { counted: true, expected: true } } } });
    const locations = await this.prisma.stock_Location.findMany({ where: { id: { in: rows.map((r) => r.locationId) } }, select: { id: true, name: true } });
    const locationOf = new Map(locations.map((l) => [l.id, l.name]));
    return rows.map((r) => ({
      id: r.id, location: locationOf.get(r.locationId) ?? '', locationId: r.locationId, status: r.status, blindCount: r.blindCount, openedAt: r.openedAt, closedAt: r.closedAt,
      lines: r.lines.length, counted: r.lines.filter((l) => l.counted !== null).length, differences: r.lines.filter((l) => l.counted !== null && Math.abs(num(l.counted) - num(l.expected)) > 0.0005).length,
    }));
  }

  /** Abre a contagem: uma linha por item/lote com saldo no local e uma por peça que está lá. */
  async open(actor: StockActor, body: Body) {
    const locationId = idOf(body.locationId);
    if (!locationId || !(await this.prisma.stock_Location.count({ where: { id: locationId, companyId: actor.companyId } }))) fail('Escolha o local');
    if (await this.prisma.stock_Count.count({ where: { companyId: actor.companyId, locationId: locationId!, status: 'aberta' } })) throw new ConflictException('Já existe uma contagem aberta neste local');
    const categoryId = idOf(body.categoryId);
    const itemFilter: Prisma.Stock_ItemWhereInput = categoryId ? { categoryId } : {};
    const [balances, units] = await Promise.all([
      this.prisma.stock_Balance.findMany({ where: { companyId: actor.companyId, holderType: 'local', holderId: locationId!, quantity: { not: 0 } } }),
      this.prisma.stock_Unit.findMany({ where: { companyId: actor.companyId, holderType: 'local', holderId: locationId!, item: itemFilter }, select: { id: true, itemId: true, lotId: true } }),
    ]);
    const items = await this.prisma.stock_Item.findMany({ where: { id: { in: balances.map((b) => b.itemId) }, ...itemFilter }, select: { id: true, tracking: true } });
    const quantityItems = new Set(items.filter((i) => i.tracking !== 'unidade').map((i) => i.id));
    const count = await this.prisma.stock_Count.create({ data: {
      companyId: actor.companyId, locationId: locationId!, blindCount: body.blindCount === true || body.blindCount === 'true', note: text(body.note, 500) || null, openedByUserId: actor.userId || null,
      lines: { createMany: { data: [
        ...balances.filter((b) => quantityItems.has(b.itemId)).map((b) => ({ itemId: b.itemId, lotId: b.lotId, expected: b.quantity })),
        ...units.map((u) => ({ itemId: u.itemId, lotId: u.lotId ?? 0, unitId: u.id, expected: 1 })),
      ] } },
    } });
    return this.get(actor, count.id);
  }

  async get(actor: StockActor, id: number) {
    const row = await this.prisma.stock_Count.findFirst({ where: { id, companyId: actor.companyId }, include: { lines: { orderBy: { id: 'asc' } } } });
    if (!row) throw new NotFoundException('Contagem não encontrada');
    const [items, units, lots, location] = await Promise.all([
      this.prisma.stock_Item.findMany({ where: { id: { in: row.lines.map((l) => l.itemId) } }, select: { id: true, code: true, name: true, unit: true, averageCost: true } }),
      this.prisma.stock_Unit.findMany({ where: { id: { in: row.lines.map((l) => l.unitId).filter((x): x is number => !!x) } }, select: { id: true, tag: true } }),
      this.prisma.stock_Lot.findMany({ where: { id: { in: row.lines.map((l) => l.lotId).filter((x) => x > 0) } }, select: { id: true, number: true } }),
      this.prisma.stock_Location.findUnique({ where: { id: row.locationId }, select: { id: true, name: true } }),
    ]);
    const itemOf = new Map(items.map((i) => [i.id, i])), tagOf = new Map(units.map((u) => [u.id, u.tag])), lotOf = new Map(lots.map((l) => [l.id, l.number]));
    const hide = row.blindCount && row.status === 'aberta';
    const costs = can(actor, PERM.costs);
    const lines = row.lines.map((l) => {
      const item = itemOf.get(l.itemId);
      const diff = l.counted === null ? null : round3(num(l.counted) - num(l.expected));
      return {
        id: l.id, itemId: l.itemId, code: item?.code ?? '', item: item?.name ?? '', unit: item?.unit ?? '', lot: l.lotId ? lotOf.get(l.lotId) ?? null : null, tag: l.unitId ? tagOf.get(l.unitId) ?? null : null,
        unitId: l.unitId, expected: hide ? null : num(l.expected), counted: l.counted === null ? null : num(l.counted), difference: hide ? null : diff,
        value: !hide && costs && diff !== null && !l.unitId ? round2(diff * num(item?.averageCost)) : null, note: l.note,
      };
    });
    return {
      id: row.id, status: row.status, blindCount: row.blindCount, location, note: row.note, openedAt: row.openedAt, closedAt: row.closedAt, movementId: row.movementId,
      lines, totalValue: !hide && costs ? round2(lines.reduce((s, l) => s + (l.value ?? 0), 0)) : null,
    };
  }

  /** Grava o contado (por linha). Peça: 1 = achou, 0 = não achou. Aceita também ler a etiqueta. */
  async record(actor: StockActor, id: number, body: Body) {
    const row = await this.prisma.stock_Count.findFirst({ where: { id, companyId: actor.companyId } });
    if (!row) throw new NotFoundException('Contagem não encontrada');
    if (row.status !== 'aberta') throw new ConflictException('A contagem já foi fechada');
    const entries: Body[] = Array.isArray(body.lines) ? body.lines : [];
    if (body.tag) {
      const unit = await this.prisma.stock_Unit.findFirst({ where: { companyId: actor.companyId, tag: clean(body.tag, 40).toUpperCase() } });
      if (!unit) fail('Etiqueta não encontrada');
      const line = await this.prisma.stock_CountLine.findFirst({ where: { countId: id, unitId: unit!.id } });
      if (!line) throw new ConflictException(`${unit!.tag} não estava registrada neste local`);
      entries.push({ id: line.id, counted: 1 });
    }
    for (const entry of entries) {
      const counted = blank(entry.counted) ? null : Number(entry.counted);
      if (counted !== null && (Number.isNaN(counted) || counted < 0)) fail('Quantidade contada inválida');
      await this.prisma.stock_CountLine.updateMany({ where: { id: Number(entry.id), countId: id }, data: { counted: counted === null ? null : round3(counted), ...('note' in entry ? { note: clean(entry.note, 300) || null } : {}) } });
    }
    return this.get(actor, id);
  }

  /** Fecha: as diferenças viram um ajuste só. Peça não achada fica "não localizada" (bloqueada com nota), não é baixada. */
  async close(actor: StockActor, id: number, body: Body) {
    const row = await this.prisma.stock_Count.findFirst({ where: { id, companyId: actor.companyId }, include: { lines: true } });
    if (!row) throw new NotFoundException('Contagem não encontrada');
    if (row.status !== 'aberta') throw new ConflictException('A contagem já foi fechada');
    if (body.cancel) {
      await this.prisma.stock_Count.update({ where: { id }, data: { status: 'cancelada', closedAt: new Date(), closedByUserId: actor.userId || null } });
      return this.get(actor, id);
    }
    const missing = row.lines.filter((l) => l.counted === null && !l.unitId);
    if (missing.length && !body.zeroMissing) throw new ConflictException(`${missing.length} item(ns) sem contagem: conte ou confirme "considerar zero"`);
    await this.prisma.$transaction(async (tx) => {
      const here = holder('local', row.locationId);
      const lines: LedgerLine[] = [];
      for (const l of row.lines.filter((x) => !x.unitId)) {
        const counted = l.counted === null ? 0 : num(l.counted);
        const current = num((await tx.stock_Balance.findUnique({ where: { itemId_lotId_holderType_holderId: { itemId: l.itemId, lotId: l.lotId, holderType: 'local', holderId: row.locationId } } }))?.quantity);
        const diff = round3(counted - current);
        if (Math.abs(diff) < 0.0005) continue;
        lines.push(diff > 0 ? { itemId: l.itemId, lotId: l.lotId || null, quantity: diff, from: EXTERNAL, to: here } : { itemId: l.itemId, lotId: l.lotId || null, quantity: -diff, from: here, to: EXTERNAL });
      }
      let movementId: number | null = null;
      if (lines.length) movementId = (await postMovement(tx, { companyId: actor.companyId, type: 'ajuste', date: today(), userId: actor.userId, countId: id, note: `Inventário #${id}`, lines, skipUsableCheck: true })).id;
      const notFound = row.lines.filter((l) => l.unitId && num(l.counted) < 1);
      for (const l of notFound) await tx.stock_Unit.update({ where: { id: l.unitId! }, data: { status: 'bloqueado', notes: `Não localizada no inventário #${id} (${today().split('-').reverse().join('/')})` } });
      await tx.stock_Count.update({ where: { id }, data: { status: 'fechada', closedAt: new Date(), closedByUserId: actor.userId || null, movementId } });
    });
    return this.get(actor, id);
  }

  // ------------------------------------------------------------------ relatórios

  async report(actor: StockActor, query: Record<string, string>) {
    const to = blank(query.to) ? today() : dateOf(query.to, 'Até');
    const from = blank(query.from) ? addDays(to, -30) : dateOf(query.from, 'De');
    const range = { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) };
    const costs = can(actor, PERM.costs);
    const [balances, items, categories, lines, centers] = await Promise.all([
      this.prisma.stock_Balance.findMany({ where: { companyId: actor.companyId, quantity: { gt: 0 } } }),
      this.prisma.stock_Item.findMany({ where: { companyId: actor.companyId }, select: { id: true, name: true, categoryId: true, averageCost: true, unit: true } }),
      this.prisma.stock_Category.findMany({ where: { companyId: actor.companyId }, select: { id: true, name: true } }),
      this.prisma.stock_MovementLine.findMany({ where: { companyId: actor.companyId, movement: { date: range, reversedById: null, type: { not: 'estorno' } } }, include: { movement: { select: { type: true, serviceOrderId: true, costCenterId: true, employeeId: true } } } }),
      this.prisma.financial_CostCenter.findMany({ where: { companyId: actor.companyId }, select: { id: true, name: true } }),
    ]);
    const itemOf = new Map(items.map((i) => [i.id, i])), categoryOf = new Map(categories.map((c) => [c.id, c.name])), centerOf = new Map(centers.map((c) => [c.id, c.name]));
    const byCategory = new Map<string, number>();
    for (const b of balances) {
      const item = itemOf.get(b.itemId);
      const key = item?.categoryId ? categoryOf.get(item.categoryId) ?? 'Sem categoria' : 'Sem categoria';
      byCategory.set(key, round2((byCategory.get(key) ?? 0) + num(b.quantity) * num(item?.averageCost)));
    }
    const orderIds = [...new Set(lines.map((l) => l.movement.serviceOrderId).filter((x): x is number => !!x))];
    const orders = await this.prisma.service_Order.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, title: true } });
    const orderOf = new Map(orders.map((o) => [o.id, o]));
    const byOrder = new Map<number, number>(), byCenter = new Map<string, number>(), byItem = new Map<number, { out: number; value: number }>();
    let adjustments = 0, adjustmentValue = 0;
    for (const l of lines) {
      const value = num(l.totalCost);
      if (l.chargedToOrder && l.movement.serviceOrderId) {
        const sign = l.movement.type === 'retorno_os' ? -1 : 1;
        byOrder.set(l.movement.serviceOrderId, round2((byOrder.get(l.movement.serviceOrderId) ?? 0) + sign * value));
      }
      if (['consumo_interno', 'entrega_epi'].includes(l.movement.type) && !l.chargedToOrder) {
        const key = l.movement.costCenterId ? centerOf.get(l.movement.costCenterId) ?? 'Sem centro de custo' : l.movement.type === 'entrega_epi' ? 'EPI (sem centro de custo)' : 'Sem centro de custo';
        byCenter.set(key, round2((byCenter.get(key) ?? 0) + value));
      }
      if (l.fromType === 'local' && l.toType !== 'local') {
        const entry = byItem.get(l.itemId) ?? { out: 0, value: 0 };
        entry.out = round3(entry.out + num(l.quantity));
        entry.value = round2(entry.value + value);
        byItem.set(l.itemId, entry);
      }
      if (l.movement.type === 'ajuste') {
        adjustments++;
        adjustmentValue = round2(adjustmentValue + (l.fromType === 'externo' ? value : -value));
      }
    }
    const money = (v: number) => (costs ? v : null);
    return {
      from, to,
      stockValue: money(round2([...byCategory.values()].reduce((s, v) => s + v, 0))),
      byCategory: [...byCategory.entries()].map(([name, value]) => ({ name, value: money(value) })).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
      byOrder: [...byOrder.entries()].map(([id, value]) => ({ id, number: orderOf.get(id)?.number ?? '', title: orderOf.get(id)?.title ?? '', value: money(value) })).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
      byCostCenter: [...byCenter.entries()].map(([name, value]) => ({ name, value: money(value) })),
      topItems: [...byItem.entries()].map(([id, e]) => ({ id, name: itemOf.get(id)?.name ?? '', unit: itemOf.get(id)?.unit ?? '', out: e.out, value: money(e.value) })).sort((a, b) => b.out - a.out).slice(0, 20),
      adjustments: { count: adjustments, value: money(adjustmentValue) },
    };
  }

  // ------------------------------------------------------------------ loja do site

  /** Público: "pronta entrega" ou "sob encomenda" por produto ligado (nunca quantidade nem custo). */
  async availability() {
    const items = await this.prisma.stock_Item.findMany({ where: { siteProductId: { not: null }, inactiveAt: null }, select: { id: true, companyId: true, siteProductId: true, tracking: true } });
    if (!items.length) return {};
    const locations = await this.prisma.stock_Location.findMany({ where: { inactiveAt: null, companyId: { in: [...new Set(items.map((i) => i.companyId))] } }, select: { id: true, companyId: true, sellsOnline: true } });
    // sem local marcado "vende da loja", vale qualquer local da empresa
    const sellers = new Map<number, number[]>();
    for (const companyId of new Set(locations.map((l) => l.companyId))) {
      const mine = locations.filter((l) => l.companyId === companyId);
      sellers.set(companyId, (mine.some((l) => l.sellsOnline) ? mine.filter((l) => l.sellsOnline) : mine).map((l) => l.id));
    }
    const balances = await this.prisma.stock_Balance.groupBy({ by: ['itemId'], where: { itemId: { in: items.map((i) => i.id) }, holderType: 'local', holderId: { in: [...sellers.values()].flat() }, quantity: { gt: 0 } }, _sum: { quantity: true } });
    const units = await this.prisma.stock_Unit.groupBy({ by: ['itemId'], where: { itemId: { in: items.filter((i) => i.tracking === 'unidade').map((i) => i.id) }, holderType: 'local', holderId: { in: [...sellers.values()].flat() }, status: 'disponivel' }, _count: { _all: true } });
    const has = new Map(balances.map((b) => [b.itemId, num(b._sum.quantity)]));
    const hasUnits = new Map(units.map((u) => [u.itemId, u._count._all]));
    return Object.fromEntries(items.map((i) => [String(i.siteProductId), ((i.tracking === 'unidade' ? hasUnits.get(i.id) : has.get(i.id)) ?? 0) > 0 ? 'pronta_entrega' : 'sob_encomenda']));
  }

  /** Publicar na loja: cria o produto do site já ligado ao item. */
  async publish(actor: StockActor, itemId: number, body: Body) {
    const item = await this.prisma.stock_Item.findFirst({ where: { id: itemId, companyId: actor.companyId } });
    if (!item) throw new NotFoundException('Item não encontrado');
    if (item.siteProductId) throw new ConflictException('O item já está ligado a um produto da loja');
    const product = await this.prisma.$transaction(async (tx) => {
      const created = await tx.site_Products.create({ data: {
        companyId: actor.companyId, name: clean(body.name, 255) || item.name, description: text(body.description, 5000) || item.description, imageUrl: item.photoUrl,
        price: blank(body.price) ? 0 : round2(Number(body.price)), oldPrice: 0, active: true,
      } });
      await tx.stock_Item.update({ where: { id: itemId }, data: { siteProductId: created.id } });
      return created;
    });
    return { id: product.id, name: product.name };
  }

  /** Produtos da loja com a situação de estoque (para a coluna na tela de Produtos). */
  async products(actor: StockActor) {
    const items = await this.prisma.stock_Item.findMany({ where: { companyId: actor.companyId, siteProductId: { not: null } }, select: { id: true, code: true, name: true, siteProductId: true } });
    const availability = await this.availability();
    return items.map((i) => ({ productId: i.siteProductId, itemId: i.id, item: `${i.code} — ${i.name}`, availability: availability[String(i.siteProductId)] ?? 'sob_encomenda' }));
  }

  // ------------------------------------------------------------------ Minha esteira

  async pipelineBlocks(actor: StockActor) {
    const blocks: Array<{ key: string; area: string; title: string; hint: string; count: number; total: number | null; link: string; items: Array<{ id: number; title: string; subtitle: string; link: string; value: number | null; late: boolean }> }> = [];
    const now = today();
    const soon = new Date(`${addDays(now, 30)}T00:00:00.000Z`);
    const nowDate = new Date(`${now}T00:00:00.000Z`);
    const push = (block: (typeof blocks)[number]) => { if (block.count) blocks.push(block); };
    if (can(actor, 'list_itens_estoque')) {
      const items = await this.prisma.stock_Item.findMany({ where: { companyId: actor.companyId, inactiveAt: null, minQuantity: { not: null } } });
      const balances = await this.prisma.stock_Balance.groupBy({ by: ['itemId'], where: { companyId: actor.companyId, holderType: 'local', itemId: { in: items.map((i) => i.id) } }, _sum: { quantity: true } });
      const units = await this.prisma.stock_Unit.groupBy({ by: ['itemId'], where: { companyId: actor.companyId, holderType: 'local', status: 'disponivel', itemId: { in: items.map((i) => i.id) } }, _count: { _all: true } });
      const has = new Map(balances.map((b) => [b.itemId, num(b._sum.quantity)])), hasUnits = new Map(units.map((u) => [u.itemId, u._count._all]));
      const low = items.filter((i) => ((i.tracking === 'unidade' ? hasUnits.get(i.id) : has.get(i.id)) ?? 0) < num(i.minQuantity));
      push({ key: 'estoque_minimo', area: 'Suprimentos', title: 'Itens abaixo do mínimo', hint: 'Repor: o botão monta o pedido de compra', count: low.length, total: null, link: '/suprimentos/compras/reposicao',
        items: low.slice(0, 5).map((i) => ({ id: i.id, title: i.name, subtitle: `${round3((i.tracking === 'unidade' ? hasUnits.get(i.id) : has.get(i.id)) ?? 0)} de ${num(i.minQuantity)} ${i.unit}`, link: `/suprimentos/estoque/itens/${i.id}`, value: null, late: true })) });
    }
    if (can(actor, 'list_equipamentos')) {
      const insp = await this.prisma.stock_Unit.findMany({ where: { companyId: actor.companyId, status: { not: 'baixado' }, OR: [{ needsInspection: true }, { status: 'em_inspecao' }, { item: { requiresInspection: true }, OR: [{ nextInspectionAt: null }, { nextInspectionAt: { lte: soon } }] }] }, include: { item: { select: { name: true } } }, orderBy: { nextInspectionAt: { sort: 'asc', nulls: 'first' } }, take: 200 });
      push({ key: 'estoque_inspecoes', area: 'Suprimentos', title: 'Inspeções de equipamento', hint: 'Vencidas, a vencer em 30 dias, esperando inspeção ou extraordinárias', count: insp.length, total: null, link: '/suprimentos/equipamentos/inspecoes',
        items: insp.slice(0, 5).map((u) => ({ id: u.id, title: `${u.tag} · ${u.item.name}`, subtitle: u.needsInspection ? 'extraordinária' : u.status === 'em_inspecao' ? 'esperando inspeção' : u.nextInspectionAt ? `vence ${d(u.nextInspectionAt)!.split('-').reverse().join('/')}` : 'sem inspeção', link: `/suprimentos/equipamentos/${u.id}`, value: null, late: u.needsInspection || !u.nextInspectionAt || u.nextInspectionAt < nowDate })) });
      const cal = await this.prisma.stock_Unit.findMany({ where: { companyId: actor.companyId, status: { notIn: ['baixado', 'em_calibracao'] }, item: { requiresCalibration: true }, OR: [{ nextCalibrationAt: null }, { nextCalibrationAt: { lte: soon } }] }, include: { item: { select: { name: true } } }, take: 200 });
      push({ key: 'estoque_calibracoes', area: 'Suprimentos', title: 'Calibrações a vencer', hint: 'Calibração vencida bloqueia a saída do equipamento', count: cal.length, total: null, link: '/suprimentos/equipamentos/calibracao',
        items: cal.slice(0, 5).map((u) => ({ id: u.id, title: `${u.tag} · ${u.item.name}`, subtitle: u.nextCalibrationAt ? `vence ${d(u.nextCalibrationAt)!.split('-').reverse().join('/')}` : 'sem calibração registrada', link: `/suprimentos/equipamentos/${u.id}`, value: null, late: !u.nextCalibrationAt || u.nextCalibrationAt < nowDate })) });
    }
    if (can(actor, 'list_ordens_de_servico') && can(actor, PERM.move)) {
      const atOrders = await this.prisma.stock_Balance.groupBy({ by: ['holderId'], where: { companyId: actor.companyId, holderType: 'os', quantity: { gt: 0 } } });
      const done = await this.prisma.service_Order.findMany({ where: { id: { in: atOrders.map((a) => a.holderId) }, status: { in: ['concluida', 'encerrada', 'cancelada'] } }, select: { id: true, number: true, title: true } });
      push({ key: 'estoque_obra_concluida', area: 'Operação', title: 'Material em obra concluída', hint: 'Registrar o retorno ou dar como consumido', count: done.length, total: null, link: '/servicos/ordens-de-servico',
        items: done.slice(0, 5).map((o) => ({ id: o.id, title: o.number, subtitle: o.title, link: `/servicos/ordens-de-servico/${o.id}`, value: null, late: true })) });
    }
    if (can(actor, 'list_locacoes')) {
      const rentals = await this.prisma.stock_Rental.findMany({ where: { companyId: actor.companyId, inactiveAt: null, status: 'ativa' }, select: { id: true, number: true, expectedEnd: true, customerId: true } });
      const late = rentals.filter((r) => r.expectedEnd && r.expectedEnd < nowDate);
      const customers = await this.prisma.customer.findMany({ where: { id: { in: late.map((r) => r.customerId) } }, select: { id: true, name: true } });
      const customerOf = new Map(customers.map((c) => [c.id, c.name]));
      push({ key: 'locacoes_atrasadas', area: 'Suprimentos', title: 'Locações atrasadas', hint: 'Passaram da devolução prevista', count: late.length, total: null, link: '/suprimentos/locacoes',
        items: late.slice(0, 5).map((r) => ({ id: r.id, title: r.number, subtitle: `${customerOf.get(r.customerId) ?? ''} · devolução era ${d(r.expectedEnd)!.split('-').reverse().join('/')}`, link: `/suprimentos/locacoes/${r.id}`, value: null, late: true })) });
    }
    return blocks;
  }
}

