import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Stock_Item, Stock_Unit } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { holderKey, holderNames, lifeEnd, nextDue, postMovement } from './ledger';
import {
  Body, EXTERNAL, HolderType, MOVEMENT_TYPES, MovementType, PERM, RETIRE_REASONS, StockActor, UNIT_STATUS, UnitStatus, addDays, blank, can, clean, d,
  dateOf, dueState, fail, holder, idOf, num, optionalDate, positive, round2, text, today,
} from './stock.rules';

/**
 * Equipamentos rastreados (peças e lotes): ficha da peça, roteiros e registros
 * de inspeção, bloqueio, baixa, corte de corda, e calibração/manutenção no
 * fornecedor. Vencimentos são calculados na leitura, como no RH.
 */
const KINDS = { pre_uso: 'Pré-uso', periodica: 'Periódica', extraordinaria: 'Extraordinária', recebimento: 'Recebimento' } as const;
const RESULTS = { aprovado: 'Aprovado', aprovado_ressalva: 'Aprovado com ressalva', reprovado: 'Reprovado' } as const;
const SERVICE_KINDS = { calibracao: 'Calibração', manutencao: 'Manutenção' } as const;
const ok = (key: string, label: string) => ({ key, label, kind: 'ok_nok', required: true });

/** Roteiros iniciais (o texto final precisa ser revisado pelo responsável técnico; decisão 13). */
export const DEFAULT_TEMPLATES: Array<{ name: string; items: Array<Record<string, unknown>> }> = [
  { name: 'Corda (semiestática / dinâmica)', items: [ok('capa', 'Capa sem cortes, abrasão excessiva, fios puxados ou derretidos'), ok('alma', 'Alma sem pontos duros, moles, afinamentos ou dobras'), ok('pontas', 'Pontas e terminações costuradas íntegras'), ok('contaminacao', 'Sem contato com produto químico, óleo ou calor'), ok('etiqueta', 'Identificação legível'), { key: 'obs', label: 'Observações', kind: 'texto', required: false }] },
  { name: 'Cinturão paraquedista', items: [ok('fitas', 'Fitas sem cortes, desfiamento, queimaduras ou desbotamento forte'), ok('costuras', 'Costuras íntegras, sem fios rompidos'), ok('fivelas', 'Fivelas e reguladores sem trinca, corrosão ou deformação'), ok('argolas', 'Argolas (dorsal/peitoral/laterais) sem deformação ou corrosão'), ok('indicador', 'Indicador de queda não acionado'), ok('etiqueta', 'Etiqueta e CA legíveis')] },
  { name: 'Talabarte / absorvedor de energia', items: [ok('fita', 'Fita ou corda sem cortes, desfiamento ou queimadura'), ok('absorvedor', 'Absorvedor fechado e sem acionamento'), ok('conectores', 'Conectores com trava funcionando'), ok('costuras', 'Costuras íntegras'), ok('etiqueta', 'Identificação legível')] },
  { name: 'Trava-quedas', items: [ok('corpo', 'Corpo sem trinca, deformação ou corrosão'), ok('came', 'Came/mola funcionando e travando na corda/cabo'), ok('trava', 'Trava de segurança funcionando'), ok('conector', 'Conector e extensor íntegros')] },
  { name: 'Mosquetão / conector', items: [ok('corpo', 'Corpo sem trinca, desgaste por atrito ou deformação'), ok('gatilho', 'Gatilho abre e fecha sozinho até o fim'), ok('trava', 'Trava (rosca/automática) funcionando'), ok('corrosao', 'Sem corrosão')] },
  { name: 'Polia', items: [ok('roldana', 'Roldana gira livre, sem folga ou desgaste em canal'), ok('placas', 'Placas laterais sem trinca ou deformação'), ok('eixo', 'Eixo e rebites firmes')] },
  { name: 'Tripé / sistema de resgate', items: [ok('pernas', 'Pernas sem amassado ou trinca; travas funcionando'), ok('cabeca', 'Cabeça e pontos de ancoragem íntegros'), ok('guincho', 'Guincho com freio e catraca funcionando'), ok('cabo', 'Cabo sem fios rompidos, dobras ou corrosão'), ok('sapatas', 'Sapatas e corrente de travamento presentes')] },
  { name: 'Detector de gases — teste de resposta', items: [ok('liga', 'Liga e passa no autoteste'), ok('bateria', 'Bateria suficiente para a jornada'), ok('resposta', 'Todos os sensores responderam ao gás de teste e alarmaram'), ok('calibracao', 'Calibração dentro da validade'), { key: 'leituras', label: 'Leituras (O2 / LEL / H2S / CO)', kind: 'texto', required: false }] },
];

@Injectable()
export class StockEquipmentService {
  constructor(private readonly prisma: PrismaService) {}

  private async byUnit(companyId: number, id: number) {
    const unit = await this.prisma.stock_Unit.findFirst({ where: { id, companyId }, include: { item: true } });
    if (!unit) throw new NotFoundException('Peça não encontrada');
    return unit;
  }

  /** Situação calculada de uma peça: o que está vencido ou perto de vencer. */
  unitDues(unit: Pick<Stock_Unit, 'nextInspectionAt' | 'nextCalibrationAt' | 'lifeEndsAt' | 'status'>, item: Pick<Stock_Item, 'requiresInspection' | 'requiresCalibration' | 'warnDays'>) {
    const retired = unit.status === 'baixado';
    return {
      inspection: item.requiresInspection && !retired ? dueState(d(unit.nextInspectionAt), item.warnDays) ?? 'vencido' : null,
      calibration: item.requiresCalibration && !retired ? dueState(d(unit.nextCalibrationAt), item.warnDays) ?? 'vencido' : null,
      life: !retired ? dueState(d(unit.lifeEndsAt), Math.max(item.warnDays, 60)) : null,
    };
  }

  private worst(dues: ReturnType<StockEquipmentService['unitDues']>) {
    const all = [dues.inspection, dues.calibration, dues.life];
    return all.includes('vencido') ? 'vencido' : all.includes('a_vencer') ? 'a_vencer' : all.some(Boolean) ? 'em_dia' : null;
  }

  // ------------------------------------------------------------------ peças

  async units(actor: StockActor, query: Record<string, string>) {
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
    const term = clean(query.search, 80);
    const soon = new Date(`${addDays(today(), 30)}T00:00:00.000Z`);
    const where: Prisma.Stock_UnitWhereInput = {
      companyId: actor.companyId,
      ...(query.status && query.status in UNIT_STATUS ? { status: query.status } : query.status === 'todas' ? {} : { status: { not: 'baixado' } }),
      ...(idOf(query.itemId) ? { itemId: idOf(query.itemId)! } : {}),
      ...(query.holderType ? { holderType: query.holderType, ...(idOf(query.holderId) ? { holderId: idOf(query.holderId) } : {}) } : {}),
      ...(term ? { OR: [{ tag: { contains: term, mode: 'insensitive' } }, { serialNumber: { contains: term, mode: 'insensitive' } }, { item: { name: { contains: term, mode: 'insensitive' } } }] } : {}),
      ...(query.due === '1' ? { OR: [
        { item: { requiresInspection: true }, OR: [{ nextInspectionAt: null }, { nextInspectionAt: { lte: soon } }] },
        { item: { requiresCalibration: true }, OR: [{ nextCalibrationAt: null }, { nextCalibrationAt: { lte: soon } }] },
        { lifeEndsAt: { lte: new Date(`${addDays(today(), 60)}T00:00:00.000Z`) } },
      ] } : {}),
      ...(query.rentable === '1' ? { item: { rentable: true } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stock_Unit.findMany({ where, orderBy: [{ tag: 'asc' }], skip: page * limit, take: limit, include: { item: true } }),
      this.prisma.stock_Unit.count({ where }),
    ]);
    const names = await holderNames(this.prisma, actor.companyId, rows.map((u) => ({ type: u.holderType as HolderType, id: u.holderId })));
    return { total, rows: rows.map((u) => this.row(u, names)) };
  }

  private row(u: Stock_Unit & { item: Stock_Item }, names: Map<string, string>) {
    const dues = this.unitDues(u, u.item);
    return {
      id: u.id, tag: u.tag, serialNumber: u.serialNumber, itemId: u.itemId, item: u.item.name, code: u.item.code, status: u.status,
      statusLabel: UNIT_STATUS[u.status as UnitStatus] ?? u.status, needsInspection: u.needsInspection,
      holderType: u.holderType, holderId: u.holderId, holder: u.holderType === 'externo' ? (u.status === 'baixado' ? 'Baixada' : 'Fora do estoque') : names.get(holderKey({ type: u.holderType, id: u.holderId })) ?? '—',
      nextInspectionAt: d(u.nextInspectionAt), nextCalibrationAt: d(u.nextCalibrationAt), lifeEndsAt: d(u.lifeEndsAt), length: u.length === null ? null : num(u.length),
      dues, due: this.worst(dues),
    };
  }

  async byTag(actor: StockActor, tag: string) {
    const unit = await this.prisma.stock_Unit.findFirst({ where: { companyId: actor.companyId, tag: clean(tag, 40).toUpperCase() }, select: { id: true } });
    if (!unit) throw new NotFoundException('Etiqueta não encontrada');
    return unit;
  }

  /** Ficha da peça: dados, onde está, vencimentos e a linha do tempo inteira. */
  async unit(actor: StockActor, id: number) {
    const unit = await this.byUnit(actor.companyId, id);
    const [lines, inspections, events, lot, origin, children] = await Promise.all([
      this.prisma.stock_MovementLine.findMany({ where: { unitId: id }, orderBy: { id: 'desc' }, include: { movement: { select: { id: true, number: true, type: true, date: true, userId: true, note: true, serviceOrderId: true, employeeId: true, rentalId: true } } } }),
      this.prisma.stock_Inspection.findMany({ where: { unitId: id }, orderBy: [{ date: 'desc' }, { id: 'desc' }] }),
      this.prisma.stock_ServiceEvent.findMany({ where: { unitId: id }, orderBy: { id: 'desc' } }),
      unit.lotId ? this.prisma.stock_Lot.findUnique({ where: { id: unit.lotId }, select: { id: true, number: true } }) : null,
      unit.originUnitId ? this.prisma.stock_Unit.findUnique({ where: { id: unit.originUnitId }, select: { id: true, tag: true } }) : null,
      this.prisma.stock_Unit.findMany({ where: { originUnitId: id }, select: { id: true, tag: true } }),
    ]);
    const names = await holderNames(this.prisma, actor.companyId, [
      { type: unit.holderType as HolderType, id: unit.holderId },
      ...lines.flatMap((l) => [{ type: l.fromType as HolderType, id: l.fromId }, { type: l.toType as HolderType, id: l.toId }]),
      ...events.filter((e) => e.supplierId).map((e) => ({ type: 'fornecedor' as HolderType, id: e.supplierId })),
    ]);
    const people = await this.prisma.hr_Employee.findMany({ where: { id: { in: inspections.map((i) => i.inspectorEmployeeId).filter((x): x is number => !!x) } }, select: { id: true, name: true } });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...inspections.map((i) => i.inspectorUserId), ...lines.map((l) => l.movement.userId)].filter((x): x is number => !!x) } }, select: { id: true, name: true } });
    const personOf = new Map(people.map((p) => [p.id, p.name])), userOf = new Map(users.map((u) => [u.id, u.name]));
    const where2 = (type: string, hid: number | null) => (type === 'externo' ? '—' : names.get(holderKey({ type, id: hid })) ?? type);
    const timeline = [
      ...lines.map((l) => ({
        kind: 'movimento', at: d(l.movement.date)!, id: l.movement.id, title: MOVEMENT_TYPES[l.movement.type as MovementType] ?? l.movement.type,
        detail: `${where2(l.fromType, l.fromId)} → ${where2(l.toType, l.toId)}${l.condition ? ` · ${l.condition}` : ''}`, by: l.movement.userId ? userOf.get(l.movement.userId) ?? null : null, number: l.movement.number,
      })),
      ...inspections.map((i) => ({
        kind: 'inspecao', at: d(i.date)!, id: i.id, title: `Inspeção ${KINDS[i.kind as keyof typeof KINDS]?.toLowerCase() ?? i.kind}: ${RESULTS[i.result as keyof typeof RESULTS] ?? i.result}`,
        detail: i.notes ?? '', by: i.inspectorEmployeeId ? personOf.get(i.inspectorEmployeeId) ?? null : i.inspectorUserId ? userOf.get(i.inspectorUserId) ?? null : null, number: null,
      })),
      ...events.map((e) => ({
        kind: e.kind, at: d(e.returnedAt ?? e.sentAt ?? e.createdAt)!, id: e.id, title: `${SERVICE_KINDS[e.kind as keyof typeof SERVICE_KINDS] ?? e.kind}: ${e.status === 'concluido' ? (e.result ?? 'concluída') : e.status}`,
        detail: [e.supplierId ? names.get(`fornecedor:${e.supplierId}`) : null, e.certificateNumber ? `certificado ${e.certificateNumber}` : null].filter(Boolean).join(' · '), by: null, number: null,
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const costs = can(actor, PERM.costs);
    return {
      ...this.row(unit, names),
      lot, origin, children, manufacturedAt: d(unit.manufacturedAt), acquiredAt: d(unit.acquiredAt), firstUseAt: d(unit.firstUseAt),
      acquisitionCost: costs && unit.acquisitionCost !== null ? num(unit.acquisitionCost) : null, attributes: unit.attributes, notes: unit.notes,
      retiredAt: d(unit.retiredAt), retiredReason: unit.retiredReason, retiredReasonLabel: unit.retiredReason ? RETIRE_REASONS[unit.retiredReason as keyof typeof RETIRE_REASONS] ?? unit.retiredReason : null, retiredNote: unit.retiredNote,
      itemRules: {
        requiresInspection: unit.item.requiresInspection, inspectionIntervalDays: unit.item.inspectionIntervalDays, inspectionBeforeUse: unit.item.inspectionBeforeUse,
        requiresCalibration: unit.item.requiresCalibration, calibrationIntervalMonths: unit.item.calibrationIntervalMonths, lifeMonths: unit.item.lifeMonths, lifeFrom: unit.item.lifeFrom,
        templateId: unit.item.inspectionTemplateId, isPpe: unit.item.isPpe, rentable: unit.item.rentable,
      },
      inspections: inspections.map((i) => ({
        id: i.id, kind: i.kind, kindLabel: KINDS[i.kind as keyof typeof KINDS] ?? i.kind, date: d(i.date), result: i.result, resultLabel: RESULTS[i.result as keyof typeof RESULTS] ?? i.result,
        answers: i.answers, nextDueAt: d(i.nextDueAt), notes: i.notes, inspector: i.inspectorEmployeeId ? personOf.get(i.inspectorEmployeeId) ?? null : i.inspectorUserId ? userOf.get(i.inspectorUserId) ?? null : null,
      })),
      services: events.map((e) => this.eventRow(e, names)),
      timeline,
    };
  }

  async updateUnit(actor: StockActor, id: number, body: Body) {
    const unit = await this.byUnit(actor.companyId, id);
    const data: Prisma.Stock_UnitUncheckedUpdateInput = {};
    if ('serialNumber' in body) data.serialNumber = clean(body.serialNumber, 80) || null;
    if ('tag' in body && !blank(body.tag)) {
      const tag = clean(body.tag, 40).toUpperCase();
      if (tag !== unit.tag && (await this.prisma.stock_Unit.count({ where: { companyId: actor.companyId, tag } }))) throw new ConflictException(`A etiqueta ${tag} já existe`);
      data.tag = tag;
    }
    if ('manufacturedAt' in body) data.manufacturedAt = optionalDate(body.manufacturedAt, 'Fabricação');
    if ('firstUseAt' in body) data.firstUseAt = optionalDate(body.firstUseAt, 'Primeiro uso');
    if ('nextInspectionAt' in body) data.nextInspectionAt = optionalDate(body.nextInspectionAt, 'Próxima inspeção');
    if ('nextCalibrationAt' in body) data.nextCalibrationAt = optionalDate(body.nextCalibrationAt, 'Próxima calibração');
    if ('length' in body) data.length = blank(body.length) ? null : positive(body.length, 'Comprimento', 100000);
    if ('notes' in body) data.notes = text(body.notes, 1000) || null;
    if ('attributes' in body) data.attributes = body.attributes && typeof body.attributes === 'object' ? body.attributes : Prisma.JsonNull;
    if ('manufacturedAt' in data || 'firstUseAt' in data) {
      data.lifeEndsAt = lifeEnd(unit.item, { manufacturedAt: (data.manufacturedAt as Date | null | undefined) ?? unit.manufacturedAt, firstUseAt: (data.firstUseAt as Date | null | undefined) ?? unit.firstUseAt });
    }
    await this.prisma.stock_Unit.update({ where: { id }, data });
    return this.unit(actor, id);
  }

  /** Bloquear, liberar e pedir inspeção extraordinária. */
  async setState(actor: StockActor, id: number, body: Body) {
    const unit = await this.byUnit(actor.companyId, id);
    const action = String(body.action);
    if (unit.status === 'baixado') throw new ConflictException('Peça baixada não muda de situação');
    if (action === 'bloquear') {
      await this.prisma.stock_Unit.update({ where: { id }, data: { status: 'bloqueado', notes: text(body.note, 1000) || unit.notes } });
    } else if (action === 'liberar') {
      if (unit.status !== 'bloqueado') throw new ConflictException('Só peça bloqueada é liberada');
      if (unit.item.requiresInspection) throw new ConflictException('Peça com inspeção só é liberada por uma inspeção aprovada');
      await this.prisma.stock_Unit.update({ where: { id }, data: { status: unit.holderType === 'local' ? 'disponivel' : 'em_uso' } });
    } else if (action === 'extraordinaria') {
      await this.prisma.stock_Unit.update({ where: { id }, data: { needsInspection: true, notes: text(body.note, 1000) || unit.notes } });
    } else fail('Ação inválida');
    return this.unit(actor, id);
  }

  /**
   * Baixa (descarte, perda, fim de vida, venda): a peça vai para fora com o motivo.
   * Se estava na obra, o custo da peça conta no resultado da OS (decisão 9).
   */
  async retire(actor: StockActor, id: number, body: Body) {
    const unit = await this.byUnit(actor.companyId, id);
    if (unit.status === 'baixado') throw new ConflictException('A peça já foi baixada');
    const reason = String(body.reason ?? '');
    if (!(reason in RETIRE_REASONS) || reason === 'corte') fail('Escolha o motivo da baixa');
    const note = text(body.note, 500) || null;
    if (['perda', 'extravio', 'avaria', 'outro'].includes(reason) && !note) fail('Conte o que aconteceu');
    const date = blank(body.date) ? today() : dateOf(body.date, 'Data');
    const atOrder = unit.holderType === 'os' ? unit.holderId : null;
    await this.prisma.$transaction(async (tx) => {
      if (unit.holderType !== 'externo') {
        await postMovement(tx, {
          companyId: actor.companyId, type: 'baixa', date, userId: actor.userId, note: `${RETIRE_REASONS[reason as keyof typeof RETIRE_REASONS]}${note ? `: ${note}` : ''}`,
          serviceOrderId: atOrder, employeeId: unit.holderType === 'funcionario' ? unit.holderId : null, rentalId: unit.holderType === 'locacao' ? unit.holderId : null, skipUsableCheck: true,
          lines: [{ itemId: unit.itemId, unitId: unit.id, quantity: 1, from: holder(unit.holderType as HolderType, unit.holderId), to: EXTERNAL, unitCost: unit.acquisitionCost !== null ? num(unit.acquisitionCost) : null, chargedToOrder: !!atOrder && reason !== 'venda' }],
        });
      }
      await tx.stock_Unit.update({ where: { id }, data: { status: 'baixado', holderType: 'externo', holderId: null, retiredAt: new Date(`${date}T00:00:00.000Z`), retiredReason: reason, retiredNote: note } });
    });
    return this.unit(actor, id);
  }

  /** Corte de corda: a original é baixada (motivo "corte") e nascem as peças novas, no mesmo lugar, com o histórico de origem. */
  async cut(actor: StockActor, id: number, body: Body) {
    const unit = await this.byUnit(actor.companyId, id);
    if (unit.holderType !== 'local') throw new ConflictException('Corte a peça no estoque (ela precisa estar num local)');
    const lengths: number[] = (Array.isArray(body.lengths) ? body.lengths : []).map((value: unknown, index: number) => positive(value, `Pedaço ${index + 1}`, 100000));
    if (lengths.length < 1) fail('Informe o comprimento de cada pedaço');
    if (unit.length !== null && lengths.reduce((s, v) => s + v, 0) > num(unit.length) + 0.01) fail(`Os pedaços passam do comprimento da peça (${num(unit.length)})`);
    const date = today();
    const created = await this.prisma.$transaction(async (tx) => {
      const here = holder('local', unit.holderId);
      await postMovement(tx, { companyId: actor.companyId, type: 'baixa', date, userId: actor.userId, note: `Corte em ${lengths.length} pedaço(s)`, skipUsableCheck: true,
        lines: [{ itemId: unit.itemId, unitId: unit.id, quantity: 1, from: here, to: EXTERNAL }] });
      await tx.stock_Unit.update({ where: { id }, data: { status: 'baixado', holderType: 'externo', holderId: null, retiredAt: new Date(`${date}T00:00:00.000Z`), retiredReason: 'corte' } });
      const existing = await tx.stock_Unit.findMany({ where: { companyId: actor.companyId, tag: { startsWith: `${unit.tag}-` } }, select: { tag: true } });
      let seq = existing.reduce((m, u) => Math.max(m, Number(/-([A-Z])$/.exec(u.tag)?.[1]?.charCodeAt(0) ?? 64)), 64);
      const pieces = [];
      for (const length of lengths) {
        const tag = `${unit.tag}-${String.fromCharCode(++seq)}`;
        pieces.push(await tx.stock_Unit.create({ data: {
          companyId: actor.companyId, itemId: unit.itemId, lotId: unit.lotId, tag, serialNumber: unit.serialNumber, manufacturedAt: unit.manufacturedAt, acquiredAt: unit.acquiredAt,
          firstUseAt: unit.firstUseAt, supplierId: unit.supplierId, purchaseOrderId: unit.purchaseOrderId,
          acquisitionCost: unit.acquisitionCost !== null && unit.length ? round2((num(unit.acquisitionCost) * length) / num(unit.length)) : unit.acquisitionCost,
          status: unit.status === 'baixado' ? 'disponivel' : unit.status, holderType: 'externo', nextInspectionAt: unit.nextInspectionAt, nextCalibrationAt: unit.nextCalibrationAt,
          lifeEndsAt: unit.lifeEndsAt, originUnitId: unit.id, length, attributes: unit.attributes ?? undefined,
        } }));
      }
      await postMovement(tx, { companyId: actor.companyId, type: 'entrada_avulsa', date, userId: actor.userId, note: `Pedaços de ${unit.tag}`, skipUsableCheck: true,
        lines: pieces.map((p) => ({ itemId: p.itemId, unitId: p.id, quantity: 1, from: EXTERNAL, to: here, unitCost: p.acquisitionCost !== null ? num(p.acquisitionCost) : 0, unitStatus: p.status as UnitStatus })) });
      return pieces;
    });
    return { pieces: created.map((p) => ({ id: p.id, tag: p.tag, length: num(p.length) })) };
  }

  /** Baixa de quantidade de um lote (peças não identificadas). */
  async retireFromLot(actor: StockActor, lotId: number, body: Body) {
    const lot = await this.prisma.stock_Lot.findFirst({ where: { id: lotId, companyId: actor.companyId }, include: { item: true } });
    if (!lot) throw new NotFoundException('Lote não encontrado');
    const locationId = idOf(body.locationId);
    if (!locationId) fail('Escolha o local');
    const reason = String(body.reason ?? '');
    if (!(reason in RETIRE_REASONS)) fail('Escolha o motivo da baixa');
    const quantity = positive(body.quantity, 'Quantidade');
    await this.prisma.$transaction((tx) => postMovement(tx, {
      companyId: actor.companyId, type: 'baixa', date: today(), userId: actor.userId, note: `${RETIRE_REASONS[reason as keyof typeof RETIRE_REASONS]}${body.note ? `: ${text(body.note, 400)}` : ''} (lote ${lot.number})`, skipUsableCheck: true,
      lines: [{ itemId: lot.itemId, lotId: lot.id, quantity, from: holder('local', locationId), to: EXTERNAL }],
    }));
    return { ok: true };
  }

  // ------------------------------------------------------------------ roteiros

  async ensureTemplates(companyId: number) {
    if (await this.prisma.stock_InspectionTemplate.count({ where: { companyId } })) return;
    await this.prisma.stock_InspectionTemplate.createMany({ data: DEFAULT_TEMPLATES.map((t) => ({ companyId, name: t.name, items: t.items as Prisma.InputJsonValue })), skipDuplicates: true });
  }

  async templates(actor: StockActor, query: Record<string, string> = {}) {
    await this.ensureTemplates(actor.companyId);
    const rows = await this.prisma.stock_InspectionTemplate.findMany({ where: { companyId: actor.companyId, ...(query.all === '1' ? {} : { inactiveAt: null }) }, orderBy: { name: 'asc' } });
    return rows.map((t) => ({ id: t.id, name: t.name, items: t.items, active: !t.inactiveAt }));
  }

  private templateData(body: Body, isNew: boolean): Prisma.Stock_InspectionTemplateUncheckedUpdateInput {
    const data: Prisma.Stock_InspectionTemplateUncheckedUpdateInput = {};
    if ('name' in body || isNew) {
      data.name = clean(body.name, 120);
      if (String(data.name).length < 2) fail('Informe o nome do roteiro');
    }
    if ('items' in body || isNew) {
      const items = (Array.isArray(body.items) ? body.items : []).map((raw: Body, index: number) => {
        const label = clean(raw.label, 300);
        if (!label) fail(`Pergunta ${index + 1}: informe o texto`);
        return { key: clean(raw.key, 40) || `q${index + 1}`, label, kind: ['ok_nok', 'texto', 'numero'].includes(raw.kind) ? raw.kind : 'ok_nok', required: raw.required !== false };
      });
      if (!items.length) fail('O roteiro precisa de pelo menos uma pergunta');
      if (items.length > 60) fail('Perguntas demais');
      data.items = items as Prisma.InputJsonValue;
    }
    return data;
  }

  async createTemplate(actor: StockActor, body: Body) {
    const row = await this.prisma.stock_InspectionTemplate.create({ data: { ...(this.templateData(body, true) as Prisma.Stock_InspectionTemplateUncheckedCreateInput), companyId: actor.companyId } });
    return { id: row.id, name: row.name, items: row.items, active: true };
  }

  async updateTemplate(actor: StockActor, id: number, body: Body) {
    if (!(await this.prisma.stock_InspectionTemplate.count({ where: { id, companyId: actor.companyId } }))) throw new NotFoundException('Roteiro não encontrado');
    const row = await this.prisma.stock_InspectionTemplate.update({ where: { id }, data: { ...this.templateData(body, false), ...('active' in body ? { inactiveAt: body.active ? null : new Date() } : {}) } });
    return { id: row.id, name: row.name, items: row.items, active: !row.inactiveAt };
  }

  // ------------------------------------------------------------------ inspeções

  /**
   * Registra uma inspeção de peça ou lote. Aprovada: próxima pelo intervalo do item,
   * peça liberada (sai de "em inspeção" e da marca de extraordinária). Reprovada: bloqueia.
   */
  async inspect(actor: StockActor, body: Body) {
    if (!can(actor, PERM.inspect)) throw new ForbiddenException('Você não tem permissão para registrar inspeções');
    const unitId = idOf(body.unitId), lotId = idOf(body.lotId);
    if (!unitId === !lotId) fail('Escolha a peça ou o lote');
    const kind = String(body.kind ?? 'periodica');
    if (!(kind in KINDS)) fail('Tipo de inspeção inválido');
    const result = String(body.result ?? '');
    if (!(result in RESULTS)) fail('Informe o resultado');
    const date = blank(body.date) ? today() : dateOf(body.date, 'Data');
    if (date > today()) fail('A data não pode ser no futuro');
    const notes = text(body.notes, 1000) || null;
    if (result !== 'aprovado' && !notes) fail('Conte o que foi encontrado');
    const unit = unitId ? await this.byUnit(actor.companyId, unitId) : null;
    const lot = lotId ? await this.prisma.stock_Lot.findFirst({ where: { id: lotId, companyId: actor.companyId }, include: { item: true } }) : null;
    if (lotId && !lot) throw new NotFoundException('Lote não encontrado');
    if (unit?.status === 'baixado') throw new ConflictException('Peça baixada não é inspecionada');
    const item = (unit?.item ?? lot!.item);
    const templateId = idOf(body.templateId) ?? item.inspectionTemplateId;
    const template = templateId ? await this.prisma.stock_InspectionTemplate.findFirst({ where: { id: templateId, companyId: actor.companyId } }) : null;
    const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
    if (template) {
      const missing = (template.items as Body[]).filter((q) => q.required && (answers[q.key] === undefined || answers[q.key] === '' || answers[q.key] === null));
      if (missing.length) fail(`Responda: ${missing.map((q) => q.label).slice(0, 3).join('; ')}`);
      if (result === 'aprovado' && (template.items as Body[]).some((q) => q.kind === 'ok_nok' && answers[q.key] === 'nok')) fail('Há item "não OK": o resultado não pode ser "aprovado"');
    }
    const inspectorEmployeeId = idOf(body.inspectorEmployeeId);
    if (inspectorEmployeeId && !(await this.prisma.hr_Employee.count({ where: { id: inspectorEmployeeId, companyId: actor.companyId } }))) fail('Inspetor não encontrado');
    // pré-uso não empurra a periódica; as demais, sim
    const nextDueAt = result === 'reprovado' ? null
      : !blank(body.nextDueAt) ? dateOf(body.nextDueAt, 'Próxima inspeção')
        : kind === 'pre_uso' ? null : nextDue(date, item.inspectionIntervalDays);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stock_Inspection.create({ data: {
        companyId: actor.companyId, unitId, lotId, kind, date: new Date(`${date}T00:00:00.000Z`), result, templateId: template?.id ?? null, answers: answers as Prisma.InputJsonValue,
        inspectorEmployeeId, inspectorUserId: actor.userId || null, serviceOrderId: idOf(body.serviceOrderId), nextDueAt: nextDueAt ? new Date(`${nextDueAt}T00:00:00.000Z`) : null, photos: [], notes,
      } });
      if (unit) {
        const data: Prisma.Stock_UnitUncheckedUpdateInput = {};
        if (result === 'reprovado') data.status = 'bloqueado';
        else {
          if (nextDueAt) data.nextInspectionAt = new Date(`${nextDueAt}T00:00:00.000Z`);
          else if (!unit.nextInspectionAt && item.requiresInspection && kind !== 'pre_uso') data.nextInspectionAt = new Date(`${date}T00:00:00.000Z`);
          if (kind !== 'pre_uso' || unit.needsInspection) data.needsInspection = false;
          if (['em_inspecao', 'bloqueado'].includes(unit.status) && kind !== 'pre_uso') data.status = unit.holderType === 'local' ? 'disponivel' : unit.holderType === 'externo' ? 'disponivel' : 'em_uso';
        }
        await tx.stock_Unit.update({ where: { id: unit.id }, data });
      }
      if (lot) {
        await tx.stock_Lot.update({ where: { id: lot.id }, data: result === 'reprovado' ? { status: 'bloqueado' } : { status: 'liberado', ...(nextDueAt ? { nextInspectionAt: new Date(`${nextDueAt}T00:00:00.000Z`) } : {}) } });
      }
      return created;
    });
    return { id: row.id, result: row.result, nextDueAt: d(row.nextDueAt), unit: unit ? await this.unit(actor, unit.id) : null };
  }

  /** Inspeções a fazer (vencidas, a vencer, em inspeção, extraordinárias) e as registradas. */
  async inspections(actor: StockActor, query: Record<string, string>) {
    const soon = new Date(`${addDays(today(), 30)}T00:00:00.000Z`);
    if (query.view === 'registradas') {
      const page = Math.max(0, Number(query.page) || 0);
      const where: Prisma.Stock_InspectionWhereInput = { companyId: actor.companyId, ...(query.result && query.result in RESULTS ? { result: query.result } : {}) };
      const [rows, total] = await Promise.all([
        this.prisma.stock_Inspection.findMany({ where, orderBy: [{ date: 'desc' }, { id: 'desc' }], skip: page * 50, take: 50 }),
        this.prisma.stock_Inspection.count({ where }),
      ]);
      const units = await this.prisma.stock_Unit.findMany({ where: { id: { in: rows.map((r) => r.unitId).filter((x): x is number => !!x) } }, select: { id: true, tag: true, item: { select: { name: true } } } });
      const lots = await this.prisma.stock_Lot.findMany({ where: { id: { in: rows.map((r) => r.lotId).filter((x): x is number => !!x) } }, select: { id: true, number: true, item: { select: { name: true } } } });
      const people = await this.prisma.hr_Employee.findMany({ where: { id: { in: rows.map((r) => r.inspectorEmployeeId).filter((x): x is number => !!x) } }, select: { id: true, name: true } });
      const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.inspectorUserId).filter((x): x is number => !!x) } }, select: { id: true, name: true } });
      const unitOf = new Map(units.map((u) => [u.id, u])), lotOf = new Map(lots.map((l) => [l.id, l])), personOf = new Map(people.map((p) => [p.id, p.name])), userOf = new Map(users.map((u) => [u.id, u.name]));
      return {
        total, rows: rows.map((r) => ({
          id: r.id, date: d(r.date), kind: r.kind, kindLabel: KINDS[r.kind as keyof typeof KINDS] ?? r.kind, result: r.result, resultLabel: RESULTS[r.result as keyof typeof RESULTS] ?? r.result,
          unitId: r.unitId, lotId: r.lotId, target: r.unitId ? `${unitOf.get(r.unitId)?.tag} · ${unitOf.get(r.unitId)?.item.name}` : `Lote ${lotOf.get(r.lotId!)?.number} · ${lotOf.get(r.lotId!)?.item.name}`,
          inspector: r.inspectorEmployeeId ? personOf.get(r.inspectorEmployeeId) ?? null : r.inspectorUserId ? userOf.get(r.inspectorUserId) ?? null : null, notes: r.notes, nextDueAt: d(r.nextDueAt),
        })),
      };
    }
    const units = await this.prisma.stock_Unit.findMany({
      where: { companyId: actor.companyId, status: { not: 'baixado' }, OR: [
        { status: 'em_inspecao' }, { needsInspection: true },
        { item: { requiresInspection: true }, OR: [{ nextInspectionAt: null }, { nextInspectionAt: { lte: soon } }] },
      ] },
      include: { item: true }, orderBy: [{ nextInspectionAt: { sort: 'asc', nulls: 'first' } }, { tag: 'asc' }], take: 500,
    });
    const lots = await this.prisma.stock_Lot.findMany({
      where: { companyId: actor.companyId, status: { not: 'baixado' }, item: { requiresInspection: true, tracking: 'lote' }, OR: [{ nextInspectionAt: null }, { nextInspectionAt: { lte: soon } }] },
      include: { item: true }, take: 200,
    });
    const names = await holderNames(this.prisma, actor.companyId, units.map((u) => ({ type: u.holderType as HolderType, id: u.holderId })));
    return {
      units: units.map((u) => ({ ...this.row(u, names), reason: u.needsInspection ? 'Extraordinária' : u.status === 'em_inspecao' ? 'Esperando inspeção' : !u.nextInspectionAt ? 'Sem inspeção registrada' : d(u.nextInspectionAt)! < today() ? 'Vencida' : 'A vencer' })),
      lots: lots.map((l) => ({ id: l.id, number: l.number, itemId: l.itemId, item: l.item.name, nextInspectionAt: d(l.nextInspectionAt), state: dueState(d(l.nextInspectionAt), l.item.warnDays) ?? 'vencido' })),
    };
  }

  // ------------------------------------------------------------------ calibração e manutenção

  private eventRow(e: Prisma.Stock_ServiceEventGetPayload<object>, names: Map<string, string>, extra: Record<string, unknown> = {}) {
    return {
      id: e.id, unitId: e.unitId, kind: e.kind, kindLabel: SERVICE_KINDS[e.kind as keyof typeof SERVICE_KINDS] ?? e.kind, status: e.status,
      sentAt: d(e.sentAt), returnedAt: d(e.returnedAt), supplierId: e.supplierId, supplier: e.supplierId ? names.get(`fornecedor:${e.supplierId}`) ?? null : null,
      purchaseOrderId: e.purchaseOrderId, cost: e.cost === null ? null : num(e.cost), result: e.result, certificateNumber: e.certificateNumber, nextDueAt: d(e.nextDueAt), notes: e.notes,
      daysOut: e.status === 'enviado' && e.sentAt ? Math.round((new Date(`${today()}T00:00:00.000Z`).getTime() - e.sentAt.getTime()) / 86400000) : null, ...extra,
    };
  }

  /** Mandar para calibração ou manutenção: a peça sai do local para o fornecedor. */
  async sendToService(actor: StockActor, unitId: number, body: Body) {
    const unit = await this.byUnit(actor.companyId, unitId);
    const kind = String(body.kind ?? '');
    if (!(kind in SERVICE_KINDS)) fail('Escolha calibração ou manutenção');
    if (unit.holderType !== 'local') throw new ConflictException(`${unit.tag} precisa estar num local do estoque para ser enviada`);
    const supplierId = idOf(body.supplierId);
    if (!supplierId) fail('Escolha o fornecedor (laboratório ou assistência)');
    if (await this.prisma.stock_ServiceEvent.count({ where: { unitId, status: 'enviado' } })) throw new ConflictException(`${unit.tag} já está fora para serviço`);
    const date = blank(body.sentAt) ? today() : dateOf(body.sentAt, 'Envio');
    const event = await this.prisma.$transaction(async (tx) => {
      await postMovement(tx, {
        companyId: actor.companyId, type: 'envio_fornecedor', date, userId: actor.userId, supplierId, note: `${SERVICE_KINDS[kind as keyof typeof SERVICE_KINDS]}${body.notes ? `: ${text(body.notes, 400)}` : ''}`, skipUsableCheck: true,
        lines: [{ itemId: unit.itemId, unitId: unit.id, quantity: 1, from: holder('local', unit.holderId), to: holder('fornecedor', supplierId), unitStatus: kind === 'calibracao' ? 'em_calibracao' : 'em_manutencao' }],
      });
      return tx.stock_ServiceEvent.create({ data: {
        companyId: actor.companyId, unitId, kind, status: 'enviado', sentAt: new Date(`${date}T00:00:00.000Z`), supplierId, locationId: unit.holderId,
        notes: text(body.notes, 1000) || null, createdByUserId: actor.userId || null,
      } });
    });
    return this.event(actor, event.id);
  }

  async event(actor: StockActor, id: number) {
    const e = await this.prisma.stock_ServiceEvent.findFirst({ where: { id, companyId: actor.companyId } });
    if (!e) throw new NotFoundException('Serviço não encontrado');
    const unit = await this.prisma.stock_Unit.findUnique({ where: { id: e.unitId }, select: { tag: true, item: { select: { name: true } } } });
    const purchase = e.purchaseOrderId ? await this.prisma.purchase_Order.findUnique({ where: { id: e.purchaseOrderId }, select: { id: true, number: true, status: true } }) : null;
    const names = await holderNames(this.prisma, actor.companyId, e.supplierId ? [{ type: 'fornecedor', id: e.supplierId }] : []);
    return this.eventRow(e, names, { tag: unit?.tag, item: unit?.item.name, purchaseOrder: purchase });
  }

  /** Voltou do fornecedor: resultado, certificado e a próxima data. */
  async returnFromService(actor: StockActor, id: number, body: Body) {
    const e = await this.prisma.stock_ServiceEvent.findFirst({ where: { id, companyId: actor.companyId } });
    if (!e) throw new NotFoundException('Serviço não encontrado');
    if (e.status !== 'enviado') throw new ConflictException('Este serviço já foi encerrado');
    const unit = await this.byUnit(actor.companyId, e.unitId);
    const result = String(body.result ?? '');
    if (!['aprovado', 'ajustado', 'reprovado'].includes(result)) fail('Informe o resultado');
    const date = blank(body.returnedAt) ? today() : dateOf(body.returnedAt, 'Retorno');
    const locationId = idOf(body.locationId) ?? e.locationId;
    if (!locationId) fail('Escolha para qual local volta');
    const nextDueAt = result === 'reprovado' ? null : !blank(body.nextDueAt) ? dateOf(body.nextDueAt, 'Próxima calibração')
      : e.kind === 'calibracao' ? nextDue(date, null, unit.item.calibrationIntervalMonths) : null;
    if (e.kind === 'calibracao' && result !== 'reprovado' && !nextDueAt) fail('Informe a data da próxima calibração');
    await this.prisma.$transaction(async (tx) => {
      await postMovement(tx, {
        companyId: actor.companyId, type: 'retorno_fornecedor', date, userId: actor.userId, supplierId: e.supplierId, skipUsableCheck: true,
        lines: [{ itemId: unit.itemId, unitId: unit.id, quantity: 1, from: holder('fornecedor', e.supplierId), to: holder('local', locationId), unitStatus: result === 'reprovado' ? 'bloqueado' : unit.item.requiresInspection && unit.needsInspection ? 'em_inspecao' : 'disponivel' }],
      });
      await tx.stock_ServiceEvent.update({ where: { id }, data: {
        status: 'concluido', returnedAt: new Date(`${date}T00:00:00.000Z`), result, certificateNumber: clean(body.certificateNumber, 80) || null,
        cost: blank(body.cost) ? e.cost : round2(Number(body.cost)), nextDueAt: nextDueAt ? new Date(`${nextDueAt}T00:00:00.000Z`) : null,
        notes: text(body.notes, 1000) || e.notes,
      } });
      if (e.kind === 'calibracao' && nextDueAt) await tx.stock_Unit.update({ where: { id: unit.id }, data: { nextCalibrationAt: new Date(`${nextDueAt}T00:00:00.000Z`) } });
    });
    return this.event(actor, id);
  }

  /** Cancelar um envio (não chegou a sair): a peça volta ao local de origem. */
  async cancelService(actor: StockActor, id: number) {
    const e = await this.prisma.stock_ServiceEvent.findFirst({ where: { id, companyId: actor.companyId } });
    if (!e) throw new NotFoundException('Serviço não encontrado');
    if (e.status !== 'enviado') throw new ConflictException('Este serviço já foi encerrado');
    const unit = await this.byUnit(actor.companyId, e.unitId);
    await this.prisma.$transaction(async (tx) => {
      await postMovement(tx, { companyId: actor.companyId, type: 'retorno_fornecedor', date: today(), userId: actor.userId, note: 'Envio cancelado', skipUsableCheck: true,
        lines: [{ itemId: unit.itemId, unitId: unit.id, quantity: 1, from: holder('fornecedor', e.supplierId), to: holder('local', e.locationId), unitStatus: 'disponivel' }] });
      await tx.stock_ServiceEvent.update({ where: { id }, data: { status: 'cancelado' } });
    });
    return this.event(actor, id);
  }

  async linkPurchase(actor: StockActor, id: number, body: Body) {
    const e = await this.prisma.stock_ServiceEvent.findFirst({ where: { id, companyId: actor.companyId } });
    if (!e) throw new NotFoundException('Serviço não encontrado');
    const purchaseOrderId = idOf(body.purchaseOrderId);
    if (purchaseOrderId && !(await this.prisma.purchase_Order.count({ where: { id: purchaseOrderId, companyId: actor.companyId } }))) fail('Pedido de compra não encontrado');
    await this.prisma.stock_ServiceEvent.update({ where: { id }, data: { purchaseOrderId } });
    return this.event(actor, id);
  }

  /** Calibração e manutenção: em andamento, a vencer, vencidas e o histórico. */
  async services(actor: StockActor, query: Record<string, string>) {
    const soon = new Date(`${addDays(today(), 60)}T00:00:00.000Z`);
    const [open, history, due] = await Promise.all([
      this.prisma.stock_ServiceEvent.findMany({ where: { companyId: actor.companyId, status: 'enviado' }, orderBy: { sentAt: 'asc' } }),
      this.prisma.stock_ServiceEvent.findMany({ where: { companyId: actor.companyId, status: { not: 'enviado' } }, orderBy: { id: 'desc' }, take: Math.min(500, Number(query.limit) || 100) }),
      this.prisma.stock_Unit.findMany({ where: { companyId: actor.companyId, status: { notIn: ['baixado', 'em_calibracao'] }, item: { requiresCalibration: true }, OR: [{ nextCalibrationAt: null }, { nextCalibrationAt: { lte: soon } }] }, include: { item: true }, orderBy: { nextCalibrationAt: { sort: 'asc', nulls: 'first' } } }),
    ]);
    const unitIds = [...new Set([...open, ...history].map((e) => e.unitId))];
    const units = await this.prisma.stock_Unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, tag: true, item: { select: { name: true } } } });
    const unitOf = new Map(units.map((u) => [u.id, u]));
    const names = await holderNames(this.prisma, actor.companyId, [
      ...[...open, ...history].filter((e) => e.supplierId).map((e) => ({ type: 'fornecedor' as HolderType, id: e.supplierId })),
      ...due.map((u) => ({ type: u.holderType as HolderType, id: u.holderId })),
    ]);
    const label = (e: { unitId: number }) => ({ tag: unitOf.get(e.unitId)?.tag ?? '', item: unitOf.get(e.unitId)?.item.name ?? '' });
    return {
      open: open.map((e) => this.eventRow(e, names, label(e))),
      history: history.map((e) => this.eventRow(e, names, label(e))),
      due: due.map((u) => this.row(u, names)),
    };
  }

  /** Vencimentos de tudo (inspeção, calibração, vida útil, lote, CA): para a tela e para a Minha esteira. */
  async dues(actor: StockActor, query: Record<string, string> = {}) {
    const now = today();
    const horizon = addDays(now, Math.min(365, Number(query.days) || 30));
    const end = new Date(`${horizon}T00:00:00.000Z`);
    const [units, lots, items] = await Promise.all([
      this.prisma.stock_Unit.findMany({ where: { companyId: actor.companyId, status: { not: 'baixado' }, OR: [
        { item: { requiresInspection: true }, OR: [{ nextInspectionAt: null }, { nextInspectionAt: { lte: end } }] },
        { item: { requiresCalibration: true }, OR: [{ nextCalibrationAt: null }, { nextCalibrationAt: { lte: end } }] },
        { lifeEndsAt: { lte: end } },
      ] }, include: { item: true } }),
      this.prisma.stock_Lot.findMany({ where: { companyId: actor.companyId, status: { not: 'baixado' }, expiresAt: { lte: end } }, include: { item: true } }),
      this.prisma.stock_Item.findMany({ where: { companyId: actor.companyId, inactiveAt: null, isPpe: true, caExpiry: { lte: end } } }),
    ]);
    const balances = await this.prisma.stock_Balance.groupBy({ by: ['lotId'], where: { companyId: actor.companyId, lotId: { in: lots.map((l) => l.id) }, quantity: { gt: 0 } }, _sum: { quantity: true } });
    const lotQty = new Map(balances.map((b) => [b.lotId, num(b._sum.quantity)]));
    const names = await holderNames(this.prisma, actor.companyId, units.map((u) => ({ type: u.holderType as HolderType, id: u.holderId })));
    const rows: Array<Record<string, unknown>> = [];
    for (const u of units) {
      const where = u.holderType === 'externo' ? '—' : names.get(holderKey({ type: u.holderType, id: u.holderId })) ?? '—';
      const push = (type: string, label: string, date: string | null) => {
        if (date && date > horizon) return;
        rows.push({ type, label, date, state: date ? (date < now ? 'vencido' : 'a_vencer') : 'vencido', target: `${u.tag} · ${u.item.name}`, unitId: u.id, itemId: u.itemId, where });
      };
      if (u.item.requiresInspection) push('inspecao', 'Inspeção', d(u.nextInspectionAt));
      if (u.item.requiresCalibration && u.status !== 'em_calibracao') push('calibracao', 'Calibração', d(u.nextCalibrationAt));
      if (u.lifeEndsAt) push('vida_util', 'Fim da vida útil', d(u.lifeEndsAt));
    }
    for (const l of lots.filter((x) => (lotQty.get(x.id) ?? 0) > 0)) rows.push({ type: 'validade_lote', label: 'Validade do lote', date: d(l.expiresAt), state: d(l.expiresAt)! < now ? 'vencido' : 'a_vencer', target: `Lote ${l.number} · ${l.item.name}`, itemId: l.itemId, lotId: l.id, where: `${lotQty.get(l.id)} ${l.item.unit}` });
    for (const i of items) rows.push({ type: 'ca', label: 'CA do EPI', date: d(i.caExpiry), state: d(i.caExpiry)! < now ? 'vencido' : 'a_vencer', target: `${i.code} · ${i.name} (CA ${i.caNumber ?? '—'})`, itemId: i.id, where: '' });
    rows.sort((a, b) => String(a.date ?? '0').localeCompare(String(b.date ?? '0')));
    const filtered = query.type ? rows.filter((r) => r.type === query.type) : rows;
    return { rows: filtered, counts: { vencido: rows.filter((r) => r.state === 'vencido').length, a_vencer: rows.filter((r) => r.state === 'a_vencer').length } };
  }
}
