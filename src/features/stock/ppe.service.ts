import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrivateStorageService } from 'src/common/storage/private-storage.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { LedgerLine, postMovement } from './ledger';
import { Body, EXTERNAL, StockActor, Tx, addDays, blank, can, clean, d, dateOf, dueState, fail, holder, idOf, num, positive, round3, text, today } from './stock.rules';

/**
 * EPI entregue aos funcionários: entrega (com assinatura), devolução, troca, a
 * ficha de EPI e as pendências (troca periódica, CA vencido, desligados).
 */
export const PPE_REASONS = { admissao: 'Admissão', troca_desgaste: 'Troca por desgaste', troca_dano: 'Troca por dano', perda: 'Perda', troca_periodica: 'Troca periódica', outro: 'Outro' } as const;

@Injectable()
export class StockPpeService {
  constructor(private readonly prisma: PrismaService, private readonly storage: PrivateStorageService) {}

  private async employee(actor: StockActor, id: number) {
    const row = await this.prisma.hr_Employee.findFirst({ where: { id, companyId: actor.companyId } });
    if (!row) throw new NotFoundException('Funcionário não encontrado');
    return row;
  }

  /** Assinatura desenhada na tela (data URL PNG) → bucket privado; o banco guarda só a chave. */
  private async signature(actor: StockActor, body: Body): Promise<Prisma.InputJsonValue | null> {
    const name = clean(body.signatureName ?? body.receivedBy, 160) || null;
    const image = String(body.signatureImage ?? '');
    let key: string | null = null;
    if (image) {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image);
      if (!match) fail('Assinatura inválida');
      const buffer = Buffer.from(match![1], 'base64');
      if (buffer.length > 600_000) fail('Assinatura grande demais');
      key = `stock/${actor.companyId}/signatures/${randomUUID()}.png`;
      await this.storage.put(key, buffer, 'image/png');
    }
    if (!name && !key) return null;
    return { name, document: clean(body.signatureDocument, 30) || null, key, at: new Date().toISOString(), by: actor.userId };
  }

  /** Imagem da assinatura de uma movimentação (entrega, locação, romaneio). */
  async signatureImage(actor: StockActor, movementId: number) {
    const movement = await this.prisma.stock_Movement.findFirst({ where: { id: movementId, companyId: actor.companyId }, select: { signature: true } });
    const key = (movement?.signature as Body | null)?.key;
    if (!key) throw new NotFoundException('Esta movimentação não tem assinatura');
    return this.storage.get(String(key));
  }

  /**
   * Entrega: do local para o funcionário, com o motivo. CA vencido e entrega repetida
   * só avisam; funcionário desligado é recusado. Marcada para uma obra, o custo vai para a OS.
   */
  async deliver(actor: StockActor, body: Body) {
    const employee = await this.employee(actor, Number(body.employeeId));
    if (employee.terminationDate && d(employee.terminationDate)! <= today()) throw new ConflictException(`${employee.name} está desligado: não recebe EPI`);
    if (employee.inactiveAt) throw new ConflictException(`${employee.name} está inativo`);
    const locationId = idOf(body.locationId);
    if (!locationId) fail('Escolha de qual local sai');
    const reason = String(body.reason ?? 'admissao');
    if (!(reason in PPE_REASONS)) fail('Motivo inválido');
    const serviceOrderId = idOf(body.serviceOrderId);
    if (serviceOrderId && !(await this.prisma.service_Order.count({ where: { id: serviceOrderId, companyId: actor.companyId } }))) fail('Ordem de serviço não encontrada');
    const raws: Body[] = Array.isArray(body.lines) ? body.lines : [];
    if (!raws.length) fail('Escolha o que será entregue');
    const date = blank(body.date) ? today() : dateOf(body.date, 'Data');
    const items = await this.prisma.stock_Item.findMany({ where: { companyId: actor.companyId, id: { in: raws.map((r) => Number(r.itemId)) } } });
    const itemOf = new Map(items.map((i) => [i.id, i]));
    const warnings: string[] = [];
    for (const item of items) {
      if (!item.isPpe) warnings.push(`${item.name} não está marcado como EPI`);
      if (item.caExpiry && d(item.caExpiry)! < date) warnings.push(`O CA ${item.caNumber ?? ''} de ${item.name} está vencido`);
    }
    const recent = await this.prisma.stock_MovementLine.findMany({
      where: { companyId: actor.companyId, toType: 'funcionario', toId: employee.id, itemId: { in: items.map((i) => i.id) }, movement: { type: 'entrega_epi', reversedById: null, date: { gte: new Date(`${addDays(date, -15)}T00:00:00.000Z`) } } },
      select: { itemId: true },
    });
    for (const id of new Set(recent.map((r) => r.itemId))) warnings.push(`${itemOf.get(id)?.name} foi entregue a ${employee.name} nos últimos 15 dias`);
    const signature = await this.signature(actor, body);
    const movement = await this.prisma.$transaction((tx) => postMovement(tx, {
      companyId: actor.companyId, type: 'entrega_epi', date, userId: actor.userId, employeeId: employee.id, serviceOrderId, reason,
      costCenterId: idOf(body.costCenterId), note: text(body.note, 1000) || null, signature,
      lines: raws.map((raw, index): LedgerLine => {
        const item = itemOf.get(Number(raw.itemId));
        if (!item) fail(`Linha ${index + 1}: item não encontrado`);
        const unitId = idOf(raw.unitId);
        return { itemId: item!.id, lotId: idOf(raw.lotId), unitId, quantity: unitId ? 1 : positive(raw.quantity, `Linha ${index + 1} (${item!.name})`), from: holder('local', locationId), to: holder('funcionario', employee.id), chargedToOrder: !!serviceOrderId };
      }),
    }));
    return { movementId: movement.id, number: movement.number, warnings };
  }

  /** Devolução: volta para o local (reaproveitável; em inspeção se exige) ou é descartada. */
  async giveBack(actor: StockActor, body: Body, tx?: Tx) {
    const employee = await this.employee(actor, Number(body.employeeId));
    const discard = body.discard === true || body.discard === 'true';
    const locationId = idOf(body.locationId);
    if (!discard && !locationId) fail('Escolha para qual local volta');
    const raws: Body[] = Array.isArray(body.lines) ? body.lines : [];
    if (!raws.length) fail('Escolha o que foi devolvido');
    const run = async (client: Tx) => {
      const items = await client.stock_Item.findMany({ where: { companyId: actor.companyId, id: { in: raws.map((r) => Number(r.itemId)) } } });
      const itemOf = new Map(items.map((i) => [i.id, i]));
      return postMovement(client, {
        companyId: actor.companyId, type: discard ? 'baixa' : 'devolucao_epi', date: today(), userId: actor.userId, employeeId: employee.id,
        note: text(body.note, 1000) || (discard ? 'EPI devolvido e descartado' : null), skipUsableCheck: true,
        lines: raws.map((raw, index): LedgerLine => {
          const item = itemOf.get(Number(raw.itemId));
          if (!item) fail(`Linha ${index + 1}: item não encontrado`);
          const unitId = idOf(raw.unitId);
          return {
            itemId: item!.id, lotId: idOf(raw.lotId), unitId, quantity: unitId ? 1 : positive(raw.quantity, `Linha ${index + 1}`), from: holder('funcionario', employee.id),
            to: discard ? EXTERNAL : holder('local', locationId), unitStatus: item!.requiresInspection ? 'em_inspecao' : 'disponivel',
          };
        }),
      });
    };
    const movement = tx ? await run(tx) : await this.prisma.$transaction(run);
    if (discard) for (const raw of raws.filter((r) => idOf(r.unitId))) {
      await (tx ?? this.prisma).stock_Unit.update({ where: { id: idOf(raw.unitId)! }, data: { retiredAt: new Date(`${today()}T00:00:00.000Z`), retiredReason: 'avaria', retiredNote: 'EPI devolvido e descartado' } });
    }
    return { movementId: movement.id, number: movement.number };
  }

  /** Troca: devolve (descarta ou guarda) a peça antiga e entrega a nova. */
  async exchange(actor: StockActor, body: Body) {
    const back = await this.giveBack(actor, { employeeId: body.employeeId, discard: body.discard ?? true, locationId: body.locationId, lines: body.returnLines, note: body.note });
    const given = await this.deliver(actor, { ...body, reason: body.reason ?? 'troca_desgaste', lines: body.lines });
    return { returned: back, delivered: given };
  }

  /** O que está com o funcionário, o histórico e o que pede troca. */
  async ofEmployee(actor: StockActor, employeeId: number) {
    const employee = await this.employee(actor, employeeId);
    const [balances, units, movements] = await Promise.all([
      this.prisma.stock_Balance.findMany({ where: { companyId: actor.companyId, holderType: 'funcionario', holderId: employeeId, quantity: { gt: 0 } } }),
      this.prisma.stock_Unit.findMany({ where: { companyId: actor.companyId, holderType: 'funcionario', holderId: employeeId }, include: { item: true } }),
      this.prisma.stock_Movement.findMany({ where: { companyId: actor.companyId, employeeId, type: { in: ['entrega_epi', 'devolucao_epi', 'baixa'] } }, orderBy: { id: 'desc' }, include: { lines: true }, take: 300 }),
    ]);
    const items = await this.prisma.stock_Item.findMany({ where: { id: { in: [...new Set([...balances.map((b) => b.itemId), ...movements.flatMap((m) => m.lines.map((l) => l.itemId))])] } } });
    const itemOf = new Map(items.map((i) => [i.id, i]));
    const lots = await this.prisma.stock_Lot.findMany({ where: { id: { in: balances.map((b) => b.lotId).filter((x) => x > 0) } }, select: { id: true, number: true } });
    const lotOf = new Map(lots.map((l) => [l.id, l.number]));
    const lastDelivery = (itemId: number) => movements.find((m) => m.type === 'entrega_epi' && !m.reversedById && m.lines.some((l) => l.itemId === itemId));
    const holding = balances.filter((b) => itemOf.get(b.itemId)?.tracking !== 'unidade').map((b) => {
      const item = itemOf.get(b.itemId)!;
      const last = lastDelivery(item.id);
      const replaceAt = item.replaceEveryDays && last ? addDays(d(last.date)!, item.replaceEveryDays) : null;
      return {
        itemId: item.id, code: item.code, item: item.name, unit: item.unit, lotId: b.lotId || null, lot: b.lotId ? lotOf.get(b.lotId) ?? null : null, unitId: null, tag: null,
        quantity: num(b.quantity), caNumber: item.caNumber, caState: dueState(d(item.caExpiry), item.warnDays), deliveredAt: last ? d(last.date) : null,
        replaceAt, replaceState: dueState(replaceAt, 15),
      };
    });
    for (const u of units) {
      const last = lastDelivery(u.itemId);
      const replaceAt = u.item.replaceEveryDays && last ? addDays(d(last.date)!, u.item.replaceEveryDays) : null;
      holding.push({
        itemId: u.itemId, code: u.item.code, item: u.item.name, unit: u.item.unit, lotId: u.lotId, lot: null, unitId: u.id as never, tag: u.tag as never, quantity: 1,
        caNumber: u.item.caNumber, caState: dueState(d(u.item.caExpiry), u.item.warnDays), deliveredAt: last ? d(last.date) : null, replaceAt, replaceState: dueState(replaceAt, 15),
      });
    }
    const users = await this.prisma.user.findMany({ where: { id: { in: movements.map((m) => m.userId).filter((x): x is number => !!x) } }, select: { id: true, name: true } });
    const userOf = new Map(users.map((u) => [u.id, u.name]));
    const unitIds = movements.flatMap((m) => m.lines.map((l) => l.unitId)).filter((x): x is number => !!x);
    const tags = new Map((await this.prisma.stock_Unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, tag: true } })).map((u) => [u.id, u.tag]));
    return {
      employee: { id: employee.id, name: employee.name, terminated: !!employee.terminationDate && d(employee.terminationDate)! <= today(), admissionDate: d(employee.admissionDate) },
      holding,
      history: movements.filter((m) => m.type !== 'baixa' || m.lines.some((l) => l.fromType === 'funcionario')).map((m) => ({
        id: m.id, number: m.number, type: m.type, date: d(m.date), reason: m.reason, reasonLabel: m.reason ? PPE_REASONS[m.reason as keyof typeof PPE_REASONS] ?? m.reason : null,
        reversed: !!m.reversedById, by: m.userId ? userOf.get(m.userId) ?? null : null,
        signed: !!(m.signature as Body | null)?.key, signedBy: (m.signature as Body | null)?.name ?? null,
        lines: m.lines.map((l) => ({ itemId: l.itemId, item: itemOf.get(l.itemId)?.name ?? '', caNumber: itemOf.get(l.itemId)?.caNumber ?? null, quantity: num(l.quantity), unit: itemOf.get(l.itemId)?.unit ?? '', tag: l.unitId ? tags.get(l.unitId) ?? null : null })),
      })),
    };
  }

  /** Dados da ficha de EPI (o front imprime / gera o PDF). */
  async sheet(actor: StockActor, employeeId: number) {
    const data = await this.ofEmployee(actor, employeeId);
    const [group, employee] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: actor.companyId }, select: { comercial_name: true, corporate_name: true, cnpj: true } }),
      this.prisma.hr_Employee.findUnique({ where: { id: employeeId }, select: { entity: { select: { tradeName: true, corporateName: true, cnpj: true } }, name: true, cpf: true, registration: true, admissionDate: true, roles: { where: { isPrimary: true }, select: { professional: { select: { name: true } } } } } }),
    ]);
    const showCpf = can(actor, 'view_dados_pessoais_funcionarios');
    // a ficha sai em nome do empregador (o CNPJ do grupo do funcionário)
    const company = employee?.entity ? { comercial_name: employee.entity.tradeName, corporate_name: employee.entity.corporateName, cnpj: employee.entity.cnpj } : group;
    return {
      company: { name: company?.comercial_name ?? '', corporateName: company?.corporate_name ?? '', cnpj: company?.cnpj ?? '' },
      employee: { name: employee?.name ?? '', cpf: showCpf ? employee?.cpf ?? null : null, registration: employee?.registration ?? null, admissionDate: d(employee?.admissionDate), role: employee?.roles[0]?.professional.name ?? null },
      entries: data.history.filter((h) => !h.reversed).slice().reverse().flatMap((h) => h.lines.map((l) => ({
        date: h.date, type: h.type === 'entrega_epi' ? 'Entrega' : 'Devolução', item: l.item, caNumber: l.caNumber, quantity: l.quantity, unit: l.unit, tag: l.tag,
        reason: h.reasonLabel, movementId: h.id, signed: h.signed, signedBy: h.signedBy,
      }))),
      generatedAt: new Date().toISOString(),
    };
  }

  /** Pendências: troca periódica vencendo, CA vencido nas mãos de alguém, desligados com EPI/equipamento. */
  async pending(actor: StockActor) {
    const balances = await this.prisma.stock_Balance.findMany({ where: { companyId: actor.companyId, holderType: 'funcionario', quantity: { gt: 0 } } });
    const units = await this.prisma.stock_Unit.findMany({ where: { companyId: actor.companyId, holderType: 'funcionario' }, select: { holderId: true } });
    const employeeIds = [...new Set([...balances.map((b) => b.holderId), ...units.map((u) => u.holderId!).filter(Boolean)])];
    const employees = await this.prisma.hr_Employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, name: true, terminationDate: true } });
    const rows: Array<Record<string, unknown>> = [];
    for (const employee of employees) {
      const data = await this.ofEmployee(actor, employee.id);
      const terminated = !!employee.terminationDate && d(employee.terminationDate)! <= today();
      for (const h of data.holding) {
        if (terminated) rows.push({ kind: 'desligado', label: 'Desligado com item', employeeId: employee.id, employee: employee.name, item: h.item, tag: h.tag, quantity: h.quantity, date: d(employee.terminationDate) });
        else if (h.replaceState === 'vencido' || h.replaceState === 'a_vencer') rows.push({ kind: 'troca', label: h.replaceState === 'vencido' ? 'Troca vencida' : 'Troca próxima', employeeId: employee.id, employee: employee.name, item: h.item, tag: h.tag, quantity: h.quantity, date: h.replaceAt });
        else if (h.caState === 'vencido') rows.push({ kind: 'ca', label: 'CA vencido', employeeId: employee.id, employee: employee.name, item: h.item, tag: h.tag, quantity: h.quantity, date: null });
      }
    }
    return rows.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  }

  /** Funcionários para escolher na entrega (ativos), com o que cada um tem. */
  async employees(actor: StockActor, query: Record<string, string>) {
    const term = clean(query.search, 80);
    const rows = await this.prisma.hr_Employee.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, ...(query.all === '1' ? {} : { OR: [{ terminationDate: null }, { terminationDate: { gt: new Date(`${today()}T00:00:00.000Z`) } }] }), ...(term ? { name: { contains: term, mode: 'insensitive' } } : {}) },
      orderBy: { name: 'asc' }, select: { id: true, name: true, terminationDate: true }, take: 500,
    });
    const counts = await this.prisma.stock_Balance.groupBy({ by: ['holderId'], where: { companyId: actor.companyId, holderType: 'funcionario', quantity: { gt: 0 }, holderId: { in: rows.map((r) => r.id) } }, _sum: { quantity: true } });
    const countOf = new Map(counts.map((c) => [c.holderId, round3(num(c._sum.quantity))]));
    return rows.map((r) => ({ id: r.id, name: r.name, terminated: !!r.terminationDate && d(r.terminationDate)! <= today(), holding: countOf.get(r.id) ?? 0 }));
  }
}
