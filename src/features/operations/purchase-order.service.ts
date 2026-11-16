import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Purchase_Order } from '@prisma/client';
import { randomUUID } from 'crypto';
import { FlowDefinition, assertMove, listFlowEvents, recordFlowEvent } from 'src/common/flow/flow';
import { normalizeSupplier } from 'src/features/financial/payable.rules';
import { addMonths } from 'src/features/financial/payable.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { StockMovementService } from 'src/features/stock/movement.service';

/**
 * Pedido de compra: o que a empresa compra, aluga ou contrata de terceiros,
 * para uma obra (OS) ou para a própria empresa.
 *
 * Quem precisa solicita; quem tem a permissão de aprovar aprova ou recusa; o
 * aprovado já conta como comprometido na OS; comprar fecha a condição de
 * pagamento e gera as contas a pagar; receber encerra.
 */
type Tx = Prisma.TransactionClient;
type Body = Record<string, any>;
export interface PurchaseActor { userId: number; companyId: number; canApprove: boolean; canSeeCosts: boolean }
export type PurchaseStatus = 'solicitado' | 'aprovado' | 'comprado' | 'recebido' | 'recusado' | 'cancelado';
export interface PurchaseItem { description: string; unit: string | null; quantity: number; unitPrice: number; total: number; itemId?: number | null; receivedQuantity?: number }
export interface PurchaseAttachment { id: string; kind: string; name: string; url: string }

export const PURCHASE_FLOW: FlowDefinition<PurchaseStatus> = {
  entity: 'purchase_order',
  labels: { solicitado: 'Solicitado', aprovado: 'Aprovado', comprado: 'Comprado', recebido: 'Recebido', recusado: 'Recusado', cancelado: 'Cancelado' },
  moves: {
    solicitado: ['aprovado', 'recusado', 'cancelado'],
    aprovado: ['comprado', 'solicitado', 'cancelado'],
    comprado: ['recebido', 'aprovado', 'cancelado'],
    recebido: ['comprado'],
    recusado: ['solicitado'],
    cancelado: ['solicitado'],
  },
};
const STATUSES = Object.keys(PURCHASE_FLOW.labels) as PurchaseStatus[];
/** Aprovado em diante já é dinheiro comprometido da obra. */
const COMMITTED: PurchaseStatus[] = ['aprovado', 'comprado', 'recebido'];
/** Grupo do gasto e o grupo do orçamento da proposta com que ele se compara. */
export const PURCHASE_GROUPS: Array<{ id: string; name: string; budgetType: string }> = [
  { id: 'material', name: 'Materiais', budgetType: 'material' },
  { id: 'locacao', name: 'Locações', budgetType: 'locacao' },
  { id: 'terceiros', name: 'Terceiros (mão de obra contratada)', budgetType: 'mao_de_obra' },
  { id: 'outros', name: 'Outros', budgetType: 'avulso' },
];
const ATTACHMENT_KINDS = ['cotacao', 'nota', 'outro'];
const METHODS = ['transferencia', 'pix', 'boleto', 'cartaoCredito', 'dinheiro', 'outro'];

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const fail = (message: string): never => { throw new BadRequestException(message); };
function dateOf(value: unknown, label: string): string {
  const raw = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(String(value ?? '').trim())?.[1] ?? '';
  if (!raw || Number.isNaN(asDate(raw).getTime()) || iso(asDate(raw)) !== raw) throw new BadRequestException(`${label}: informe uma data válida`);
  return raw;
}

function itemsOf(value: unknown): { items: PurchaseItem[]; total: number } {
  if (!Array.isArray(value) || value.length === 0) throw new BadRequestException('Informe pelo menos um item');
  if (value.length > 100) throw new BadRequestException('Itens demais no pedido');
  const items = value.map((raw: Body, index) => {
    const description = clean(raw?.description, 255);
    if (!description) throw new BadRequestException(`Item ${index + 1}: informe a descrição`);
    const quantity = blank(raw?.quantity) ? 1 : Number(raw.quantity);
    const unitPrice = blank(raw?.unitPrice) ? 0 : Number(raw.unitPrice);
    if (!(quantity > 0) || quantity > 1e9) throw new BadRequestException(`Item ${index + 1}: quantidade inválida`);
    if (!(unitPrice >= 0) || unitPrice > 1e11) throw new BadRequestException(`Item ${index + 1}: valor inválido`);
    const itemId = Number(raw?.itemId) > 0 ? Number(raw.itemId) : null;
    return { description, unit: clean(raw?.unit, 20) || null, quantity: Math.round(quantity * 1000) / 1000, unitPrice: round2(unitPrice), total: round2(quantity * unitPrice), ...(itemId ? { itemId, receivedQuantity: 0 } : {}) };
  });
  const total = round2(items.reduce((sum, item) => sum + item.total, 0));
  if (total <= 0) throw new BadRequestException('Informe o valor dos itens');
  return { items, total };
}

@Injectable()
export class PurchaseOrderService {
  constructor(private readonly prisma: PrismaService, private readonly stock: StockMovementService) {}

  private async byId(companyId: number, id: number) {
    const row = await this.prisma.purchase_Order.findFirst({ where: { id, companyId, inactiveAt: null } });
    if (!row) throw new NotFoundException('Pedido de compra não encontrado');
    return row;
  }

  private lateOf(row: Pick<Purchase_Order, 'status' | 'neededBy'>): boolean {
    return ['solicitado', 'aprovado', 'comprado'].includes(row.status) && !!row.neededBy && iso(row.neededBy)! < today();
  }

  private async supplierOf(companyId: number, value: unknown, current?: number | null): Promise<number | null> {
    if (blank(value)) return null;
    const id = Number(value);
    if (id === current) return id;
    const supplier = await this.prisma.financial_Supplier.findFirst({ where: { id, companyId }, select: { inactiveAt: true, name: true } });
    if (!supplier) throw new BadRequestException('Fornecedor não encontrado');
    if (supplier.inactiveAt) throw new BadRequestException(`O fornecedor ${supplier.name} está inativo`);
    return id;
  }

  private async serviceOrderOf(companyId: number, value: unknown, current?: number | null): Promise<number | null> {
    if (blank(value)) return null;
    const id = Number(value);
    if (id === current) return id;
    const order = await this.prisma.service_Order.findFirst({ where: { id, companyId, inactiveAt: null }, select: { status: true, number: true } });
    if (!order) throw new BadRequestException('Ordem de serviço não encontrada');
    if (order.status === 'cancelada' || order.status === 'encerrada') throw new BadRequestException(`A ${order.number} está ${order.status}: não recebe novos pedidos`);
    return id;
  }

  // ------------------------------------------------------------------ leitura

  async list(actor: PurchaseActor, query: Record<string, string>) {
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 20));
    const term = clean(query.search, 80);
    const supplierIds = term ? (await this.prisma.financial_Supplier.findMany({
      where: { companyId: actor.companyId, name: { contains: term, mode: 'insensitive' } }, select: { id: true }, take: 200,
    })).map((supplier) => supplier.id) : [];
    const scope: Prisma.Purchase_OrderWhereInput = {
      companyId: actor.companyId, inactiveAt: null,
      ...(Number(query.serviceOrderId) > 0 ? { serviceOrderId: Number(query.serviceOrderId) } : {}),
      ...(term ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } }, { supplierId: { in: supplierIds } }] } : {}),
    };
    const status = STATUSES.includes(query.status as PurchaseStatus) ? (query.status as PurchaseStatus) : undefined;
    // recusados e cancelados só aparecem quando pedidos
    const where: Prisma.Purchase_OrderWhereInput = { ...scope, status: status ?? { notIn: ['recusado', 'cancelado'] } };
    const [rows, total, groups] = await Promise.all([
      this.prisma.purchase_Order.findMany({ where, orderBy: [{ neededBy: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }], skip: page * limit, take: limit }),
      this.prisma.purchase_Order.count({ where }),
      this.prisma.purchase_Order.groupBy({ by: ['status'], where: scope, _count: { _all: true }, _sum: { total: true } }),
    ]);
    const ids = <K extends 'supplierId' | 'serviceOrderId' | 'requestedByUserId'>(key: K) => [...new Set(rows.map((row) => row[key]).filter((id): id is number => !!id))];
    const [suppliers, orders, users] = await Promise.all([
      this.prisma.financial_Supplier.findMany({ where: { id: { in: ids('supplierId') } }, select: { id: true, name: true } }),
      this.prisma.service_Order.findMany({ where: { id: { in: ids('serviceOrderId') } }, select: { id: true, number: true } }),
      this.prisma.user.findMany({ where: { id: { in: ids('requestedByUserId') } }, select: { id: true, name: true } }),
    ]);
    const supplierOf = new Map(suppliers.map((s) => [s.id, s])), orderOf = new Map(orders.map((o) => [o.id, o])), userOf = new Map(users.map((u) => [u.id, u.name]));
    return {
      total,
      rows: rows.map((row) => ({
        id: row.id, number: row.number, title: row.title, group: row.group, status: row.status, total: Number(row.total),
        supplier: row.supplierId ? supplierOf.get(row.supplierId) ?? null : null,
        serviceOrder: row.serviceOrderId ? orderOf.get(row.serviceOrderId) ?? null : null,
        neededBy: iso(row.neededBy), deliveryDate: iso(row.deliveryDate), requestedBy: row.requestedByUserId ? userOf.get(row.requestedByUserId) ?? null : null,
        late: this.lateOf(row), createdAt: row.createdAt,
      })),
      summary: Object.fromEntries(groups.map((g) => [g.status, { count: g._count._all, total: Number(g._sum.total ?? 0) }])),
      canApprove: actor.canApprove,
    };
  }

  /** O orçado do grupo na OS, o que outros pedidos já comprometeram e quanto sobra com este. */
  private async budgetView(row: Purchase_Order) {
    if (!row.serviceOrderId) return null;
    const order = await this.prisma.service_Order.findUnique({ where: { id: row.serviceOrderId }, select: { budget: true } });
    const group = PURCHASE_GROUPS.find((g) => g.id === row.group);
    const budgetGroups = ((order?.budget as Body | null)?.groups ?? []) as Array<{ type: string; label: string; cost: number }>;
    const budgeted = budgetGroups.find((g) => g.type === group?.budgetType);
    const others = await this.prisma.purchase_Order.aggregate({
      where: { companyId: row.companyId, serviceOrderId: row.serviceOrderId, group: row.group, inactiveAt: null, status: { in: COMMITTED }, NOT: { id: row.id } },
      _sum: { total: true },
    });
    const committed = Number(others._sum.total ?? 0);
    const budget = budgeted ? Number(budgeted.cost) : null;
    return {
      group: group?.name ?? row.group, budgetLabel: budgeted?.label ?? null, budget, committed, thisOrder: Number(row.total),
      remaining: budget === null ? null : round2(budget - committed - Number(row.total)),
    };
  }

  private async present(row: Purchase_Order, actor: PurchaseActor) {
    const [supplier, order, events, payables] = await Promise.all([
      row.supplierId ? this.prisma.financial_Supplier.findUnique({ where: { id: row.supplierId }, select: { id: true, name: true, document: true, pixKey: true, phone: true, email: true } }) : null,
      row.serviceOrderId ? this.prisma.service_Order.findUnique({ where: { id: row.serviceOrderId }, select: { id: true, number: true, title: true, customerId: true } }) : null,
      listFlowEvents(this.prisma, PURCHASE_FLOW.entity, row.id),
      this.prisma.financial_Payable.findMany({
        where: { companyId: row.companyId, purchaseOrderId: row.id, inactiveAt: null }, orderBy: { dueDate: 'asc' },
        select: { id: true, value: true, dueDate: true, status: true, paidAt: true, installmentNumber: true, installmentTotal: true },
      }),
    ]);
    const userIds = [...new Set([row.requestedByUserId, row.approvedByUserId, ...events.map((event) => event.userId)].filter((id): id is number => !!id))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const userName = new Map(users.map((user) => [user.id, user.name]));
    const customer = order ? await this.prisma.customer.findUnique({ where: { id: order.customerId }, select: { name: true } }) : null;
    const seesBudget = actor.canApprove || actor.canSeeCosts;
    return {
      id: row.id, number: row.number, title: row.title, group: row.group, status: row.status as PurchaseStatus,
      statusLabel: PURCHASE_FLOW.labels[row.status as PurchaseStatus], nextStatuses: PURCHASE_FLOW.moves[row.status as PurchaseStatus],
      statusNote: row.statusNote, late: this.lateOf(row),
      supplier, serviceOrder: order ? { id: order.id, number: order.number, title: order.title, customer: customer?.name ?? '' } : null,
      items: row.items as unknown as PurchaseItem[], total: Number(row.total), justification: row.justification,
      neededBy: iso(row.neededBy), deliveryDate: iso(row.deliveryDate), purchasedAt: iso(row.purchasedAt), receivedAt: iso(row.receivedAt),
      paymentTerms: row.paymentTerms, invoiceNumber: row.invoiceNumber,
      attachments: (row.attachments as unknown as PurchaseAttachment[]) ?? [],
      requestedBy: row.requestedByUserId ? userName.get(row.requestedByUserId) ?? null : null,
      approvedBy: row.approvedByUserId ? userName.get(row.approvedByUserId) ?? null : null, approvedAt: row.approvedAt, createdAt: row.createdAt,
      payables: payables.map((p) => ({ id: p.id, value: Number(p.value), dueDate: iso(p.dueDate), status: p.status, paidAt: iso(p.paidAt), installmentNumber: p.installmentNumber, installmentTotal: p.installmentTotal })),
      canApprove: actor.canApprove,
      budget: seesBudget ? await this.budgetView(row) : null,
      events: events.map((event) => ({ id: event.id, type: event.type, from: event.fromStage, to: event.toStage, note: event.note, at: event.createdAt, user: event.userId ? userName.get(event.userId) ?? null : null })),
    };
  }

  async get(actor: PurchaseActor, id: number) {
    return this.present(await this.byId(actor.companyId, id), actor);
  }

  async options(actor: PurchaseActor) {
    const [suppliers, orders] = await Promise.all([
      this.prisma.financial_Supplier.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, document: true }, take: 1000 }),
      this.prisma.service_Order.findMany({
        where: { companyId: actor.companyId, inactiveAt: null, status: { notIn: ['cancelada', 'encerrada'] } }, orderBy: { id: 'desc' }, select: { id: true, number: true, title: true, customerId: true }, take: 300,
      }),
    ]);
    const customers = await this.prisma.customer.findMany({ where: { id: { in: orders.map((o) => o.customerId) } }, select: { id: true, name: true } });
    const customerOf = new Map(customers.map((c) => [c.id, c.name]));
    return {
      suppliers, groups: PURCHASE_GROUPS.map(({ id, name }) => ({ id, name })),
      serviceOrders: orders.map((o) => ({ id: o.id, name: `${o.number} — ${customerOf.get(o.customerId) ?? o.title}` })),
      canApprove: actor.canApprove,
    };
  }

  /** O que os pedidos já comprometeram numa OS, por grupo (para a tela da obra). */
  async ofServiceOrder(actor: PurchaseActor, serviceOrderId: number) {
    const rows = await this.prisma.purchase_Order.findMany({
      where: { companyId: actor.companyId, serviceOrderId, inactiveAt: null, status: { not: 'cancelado' } }, orderBy: { id: 'desc' },
      select: { id: true, number: true, title: true, group: true, status: true, total: true, supplierId: true },
    });
    const suppliers = await this.prisma.financial_Supplier.findMany({ where: { id: { in: rows.map((r) => r.supplierId).filter((id): id is number => !!id) } }, select: { id: true, name: true } });
    const supplierOf = new Map(suppliers.map((s) => [s.id, s.name]));
    const committed = rows.filter((row) => COMMITTED.includes(row.status as PurchaseStatus));
    return {
      rows: rows.map((row) => ({ id: row.id, number: row.number, title: row.title, group: row.group, status: row.status, total: Number(row.total), supplier: row.supplierId ? supplierOf.get(row.supplierId) ?? null : null })),
      committed: round2(committed.reduce((sum, row) => sum + Number(row.total), 0)),
      pending: round2(rows.filter((row) => row.status === 'solicitado').reduce((sum, row) => sum + Number(row.total), 0)),
      byGroup: PURCHASE_GROUPS.map((group) => ({ group: group.id, name: group.name, committed: round2(committed.filter((row) => row.group === group.id).reduce((sum, row) => sum + Number(row.total), 0)) })).filter((g) => g.committed > 0),
    };
  }

  // ------------------------------------------------------------------ cadastro

  /** Campos que o solicitante preenche. Só mudam enquanto o pedido não foi aprovado. */
  private async contentOf(actor: PurchaseActor, body: Body, current: Purchase_Order | null) {
    const data: Prisma.Purchase_OrderUncheckedUpdateInput = {};
    if ('title' in body || !current) {
      data.title = clean(body.title, 200);
      if (String(data.title).length < 2) fail('Informe o que será comprado');
    }
    if ('group' in body || !current) {
      if (!PURCHASE_GROUPS.some((g) => g.id === body.group)) fail('Escolha o grupo do gasto');
      data.group = String(body.group);
    }
    if ('items' in body || !current) {
      const { items, total } = itemsOf(body.items);
      const itemIds = [...new Set(items.map((item) => item.itemId).filter((id): id is number => !!id))];
      if (itemIds.length && (await this.prisma.stock_Item.count({ where: { id: { in: itemIds }, companyId: actor.companyId } })) !== itemIds.length) fail('Item do estoque não encontrado');
      data.items = items as unknown as Prisma.InputJsonValue;
      data.total = total;
    }
    if ('justification' in body) data.justification = String(body.justification ?? '').trim().slice(0, 2000) || null;
    if ('neededBy' in body) data.neededBy = blank(body.neededBy) ? null : asDate(dateOf(body.neededBy, 'Precisa até'));
    if ('supplierId' in body) data.supplierId = await this.supplierOf(actor.companyId, body.supplierId, current?.supplierId);
    if ('serviceOrderId' in body) data.serviceOrderId = await this.serviceOrderOf(actor.companyId, body.serviceOrderId, current?.serviceOrderId);
    return data;
  }

  async create(actor: PurchaseActor, body: Body) {
    const content = await this.contentOf(actor, body, null);
    const year = Number(today().slice(0, 4));
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(740122::int, ${actor.companyId}::int)`;
      const last = await tx.purchase_Order.aggregate({ where: { companyId: actor.companyId, year }, _max: { sequence: true } });
      const sequence = (last._max.sequence ?? 0) + 1;
      const row = await tx.purchase_Order.create({ data: {
        ...(content as Prisma.Purchase_OrderUncheckedCreateInput), companyId: actor.companyId, number: `PDC-${year}-${String(sequence).padStart(4, '0')}`, year, sequence,
        status: 'solicitado', attachments: [], requestedByUserId: actor.userId || null,
      } });
      await recordFlowEvent(tx, PURCHASE_FLOW.entity, { companyId: actor.companyId, entityId: row.id, type: 'criado', to: 'solicitado', userId: actor.userId });
      return row;
    });
    return this.present(created, actor);
  }

  async update(actor: PurchaseActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    const status = row.status as PurchaseStatus;
    let data: Prisma.Purchase_OrderUncheckedUpdateInput = {};
    if (status === 'solicitado' || status === 'recusado') {
      data = await this.contentOf(actor, body, row);
    } else {
      const locked = ['title', 'group', 'items', 'serviceOrderId', 'justification'].filter((key) => key in body);
      if (locked.length) throw new ConflictException(`Pedido ${PURCHASE_FLOW.labels[status].toLowerCase()}: volte para "Solicitado" para alterar itens e valores`);
      // aprovado ainda pode trocar o fornecedor (a cotação pode mudar); depois de comprado, não
      if ('supplierId' in body) {
        if (status !== 'aprovado') throw new ConflictException('O fornecedor não muda depois da compra');
        data.supplierId = await this.supplierOf(actor.companyId, body.supplierId, row.supplierId);
      }
      if ('neededBy' in body) data.neededBy = blank(body.neededBy) ? null : asDate(dateOf(body.neededBy, 'Precisa até'));
    }
    if ('deliveryDate' in body) data.deliveryDate = blank(body.deliveryDate) ? null : asDate(dateOf(body.deliveryDate, 'Prazo de entrega'));
    if ('invoiceNumber' in body) data.invoiceNumber = clean(body.invoiceNumber, 60) || null;
    await this.prisma.purchase_Order.update({ where: { id }, data });
    return this.get(actor, id);
  }

  /** Cadastro rápido de fornecedor a partir do pedido (o cadastro completo fica no Financeiro). */
  async createSupplier(actor: PurchaseActor, body: Body) {
    const input = Object.fromEntries(['name', 'document', 'phone', 'email', 'pixKey', 'supplies'].filter((key) => key in body).map((key) => [key, body[key]]));
    const data = await normalizeSupplier(this.prisma, actor.companyId, input, null, (message) => fail(message));
    return this.prisma.financial_Supplier.create({ data: { ...(data as { name: string }), companyId: actor.companyId }, select: { id: true, name: true, document: true } });
  }

  // ------------------------------------------------------------------ anexos

  async addAttachment(actor: PurchaseActor, id: number, file: { location?: string; originalname?: string } | undefined, kind: unknown) {
    const row = await this.byId(actor.companyId, id);
    if (!file?.location) throw new BadRequestException('Envie o arquivo');
    const attachments = ((row.attachments as unknown as PurchaseAttachment[]) ?? []);
    if (attachments.length >= 20) throw new BadRequestException('Limite de 20 anexos por pedido');
    attachments.push({ id: randomUUID().slice(0, 8), kind: ATTACHMENT_KINDS.includes(String(kind)) ? String(kind) : 'outro', name: clean(file.originalname, 160) || 'arquivo', url: file.location });
    await this.prisma.purchase_Order.update({ where: { id }, data: { attachments: attachments as unknown as Prisma.InputJsonValue } });
    return this.get(actor, id);
  }

  async removeAttachment(actor: PurchaseActor, id: number, attachmentId: string) {
    const row = await this.byId(actor.companyId, id);
    const attachments = ((row.attachments as unknown as PurchaseAttachment[]) ?? []).filter((item) => item.id !== attachmentId);
    await this.prisma.purchase_Order.update({ where: { id }, data: { attachments: attachments as unknown as Prisma.InputJsonValue } });
    return this.get(actor, id);
  }

  // ------------------------------------------------------------------ passagens

  /** Desfaz as contas a pagar geradas pela compra; se alguma já foi paga, não deixa. */
  private async dropPayables(tx: Tx, row: Purchase_Order, reason: string) {
    const paid = await tx.financial_Payable.count({ where: { companyId: row.companyId, purchaseOrderId: row.id, inactiveAt: null, status: 'paga' } });
    if (paid > 0) throw new ConflictException(`Este pedido já tem ${paid} parcela(s) paga(s): estorne a baixa em Contas a Pagar antes`);
    await tx.financial_Payable.updateMany({
      where: { companyId: row.companyId, purchaseOrderId: row.id, inactiveAt: null }, data: { inactiveAt: new Date(), observations: reason.slice(0, 500) },
    });
  }

  /** Comprar: fecha a condição de pagamento e gera as contas a pagar das parcelas. */
  private async buy(tx: Tx, row: Purchase_Order, body: Body, actor: PurchaseActor): Promise<Prisma.Purchase_OrderUncheckedUpdateInput> {
    if (!row.supplierId) fail('Escolha o fornecedor antes de comprar');
    const count = blank(body.installments) ? 1 : Number(body.installments);
    if (!Number.isInteger(count) || count < 1 || count > 60) fail('Informe de 1 a 60 parcelas');
    if (blank(body.firstDueDate)) fail('Informe o vencimento da primeira parcela');
    const first = new Date(`${dateOf(body.firstDueDate, 'Primeiro vencimento')}T12:00:00.000Z`);
    const method = blank(body.paymentMethod) ? null : String(body.paymentMethod);
    if (method && !METHODS.includes(method)) fail('Forma de pagamento inválida');
    const purchasedAt = blank(body.date) ? today() : dateOf(body.date, 'Data da compra');
    if (purchasedAt > today()) fail('A data da compra não pode ser no futuro');

    const cents = Math.round(Number(row.total) * 100);
    const share = Math.floor(cents / count);
    if (share <= 0) fail('O valor é pequeno demais para esse número de parcelas');
    const groupKey = randomUUID();
    for (let i = 0; i < count; i++) {
      const dueDate = addMonths(first, i);
      await tx.financial_Payable.create({ data: {
        companyId: row.companyId, supplierId: row.supplierId, description: `${row.number} — ${row.title}`.slice(0, 255),
        value: (i === count - 1 ? cents - share * (count - 1) : share) / 100, dueDate, accrualDate: dueDate.toISOString().slice(0, 7),
        status: 'aberta', paymentMethod: method, documentNumber: row.invoiceNumber,
        installmentNumber: count > 1 ? i + 1 : null, installmentTotal: count > 1 ? count : null, groupKey,
        origin: 'pedido_compra', purchaseOrderId: row.id, serviceOrderId: row.serviceOrderId, createdByUserId: actor.userId || null,
      } });
    }
    return {
      purchasedAt: asDate(purchasedAt), paymentTerms: { count, firstDueDate: iso(first), method } as Prisma.InputJsonValue,
      ...(blank(body.deliveryDate) ? {} : { deliveryDate: asDate(dateOf(body.deliveryDate, 'Prazo de entrega')) }),
    };
  }

  /**
   * Passagem de etapa. Aprovar e recusar pedem a permissão de aprovação;
   * comprar pede fornecedor e condição de pagamento; recusar e cancelar pedem o motivo.
   */
  async move(actor: PurchaseActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    const from = row.status as PurchaseStatus;
    const target = String(body.status) as PurchaseStatus;
    if (!STATUSES.includes(target)) throw new BadRequestException('Etapa inválida');
    assertMove(PURCHASE_FLOW, from, target);
    const note = clean(body.note, 500) || null;
    const deciding = from === 'solicitado' && (target === 'aprovado' || target === 'recusado');
    if (deciding && !actor.canApprove) throw new ForbiddenException('Você não tem permissão para aprovar pedidos de compra');
    if ((target === 'recusado' || target === 'cancelado') && !note) throw new BadRequestException(target === 'recusado' ? 'Informe o motivo da recusa' : 'Informe o motivo do cancelamento');

    await this.prisma.$transaction(async (tx) => {
      let data: Prisma.Purchase_OrderUncheckedUpdateInput = { status: target, statusNote: note };
      if (from === 'solicitado' && target === 'aprovado') data = { ...data, approvedByUserId: actor.userId || null, approvedAt: new Date() };
      // voltar para solicitado zera a aprovação: o pedido precisa ser aprovado de novo
      if (target === 'solicitado') data = { ...data, approvedByUserId: null, approvedAt: null };
      if (from === 'aprovado' && target === 'comprado') data = { ...data, ...(await this.buy(tx, row, body, actor)) };
      if (from === 'comprado' && (target === 'aprovado' || target === 'cancelado')) {
        await this.dropPayables(tx, row, target === 'cancelado' ? `Pedido ${row.number} cancelado` : `Compra do pedido ${row.number} desfeita`);
        data = { ...data, purchasedAt: null, paymentTerms: Prisma.JsonNull };
      }
      const items = (row.items as unknown as PurchaseItem[]) ?? [];
      if (target === 'recebido') {
        const received = blank(body.date) ? today() : dateOf(body.date, 'Recebimento');
        if (received > today()) fail('O recebimento não pode ser no futuro');
        data = { ...data, receivedAt: asDate(received), ...(blank(body.invoiceNumber) ? {} : { invoiceNumber: clean(body.invoiceNumber, 60) }) };
        // o que é do estoque e ainda falta receber entra agora (quantidade simples); peça e lote pedem o recebimento detalhado
        const pending = items.map((item, index) => ({ item, index, left: Math.round((item.quantity - (item.receivedQuantity ?? 0)) * 1000) / 1000 })).filter((p) => p.item.itemId && p.left > 0);
        if (pending.length) {
          const tracked = await tx.stock_Item.findMany({ where: { id: { in: pending.map((p) => p.item.itemId!) }, tracking: { not: 'quantidade' } }, select: { name: true } });
          if (tracked.length) throw new ConflictException(`Use "Receber itens" para informar lote ou peças de: ${tracked.map((t) => t.name).join(', ')}`);
          const { items: next } = await this.stock.receivePurchase(tx, { ...row, items: items as never }, pending.map((p) => ({ index: p.index, quantity: p.left, locationId: body.locationId })), received, actor.userId);
          data = { ...data, items: next as unknown as Prisma.InputJsonValue };
        }
      }
      if (from === 'recebido' || (items.some((item) => (item.receivedQuantity ?? 0) > 0) && ['aprovado', 'cancelado'].includes(target))) {
        // desfazer o recebimento estorna as entradas no estoque (falha se algo já saiu)
        await this.stock.undoPurchase(tx, row.companyId, row.id, actor.userId);
        data = { ...data, receivedAt: null, items: items.map((item) => (item.itemId ? { ...item, receivedQuantity: 0 } : item)) as unknown as Prisma.InputJsonValue };
      }

      // só anda se ainda estiver onde a tela viu: dois cliques não compram duas vezes
      const moved = await tx.purchase_Order.updateMany({ where: { id, status: from }, data });
      if (!moved.count) throw new ConflictException('O pedido já mudou de etapa: atualize a tela');
      const forward = STATUSES.indexOf(target) > STATUSES.indexOf(from) && !['recusado', 'cancelado'].includes(target) && !['recusado', 'cancelado'].includes(from);
      await recordFlowEvent(tx, PURCHASE_FLOW.entity, {
        companyId: row.companyId, entityId: id, type: target === 'recusado' ? 'recusado' : target === 'cancelado' ? 'cancelado' : forward ? 'avancou' : 'voltou',
        from, to: target, userId: actor.userId, note,
      });
    });
    return this.get(actor, id);
  }

  /**
   * Recebimento detalhado (pedido comprado): por linha do estoque, quanto chegou, para onde,
   * lote e peças. Quando tudo o que é do estoque chega, o pedido passa a "Recebido".
   */
  async receive(actor: PurchaseActor, id: number, body: Body) {
    const row = await this.byId(actor.companyId, id);
    if (row.status !== 'comprado') throw new ConflictException('Só pedido comprado recebe itens');
    const date = blank(body.date) ? today() : dateOf(body.date, 'Recebimento');
    if (date > today()) fail('O recebimento não pode ser no futuro');
    const lines: Body[] = Array.isArray(body.lines) ? body.lines.filter((line: Body) => Number(line.quantity) > 0 || (Array.isArray(line.units) && line.units.length)) : [];
    if (!lines.length) fail('Informe o que chegou');
    await this.prisma.$transaction(async (tx) => {
      const { items } = await this.stock.receivePurchase(tx, { ...row, items: row.items as never }, lines, date, actor.userId);
      const done = items.every((item: PurchaseItem) => !item.itemId || (item.receivedQuantity ?? 0) >= item.quantity - 0.0005);
      const data: Prisma.Purchase_OrderUncheckedUpdateInput = { items: items as unknown as Prisma.InputJsonValue, ...(blank(body.invoiceNumber) ? {} : { invoiceNumber: clean(body.invoiceNumber, 60) }) };
      if (done) {
        const moved = await tx.purchase_Order.updateMany({ where: { id, status: 'comprado' }, data: { ...data, status: 'recebido', receivedAt: asDate(date), statusNote: null } as Prisma.Purchase_OrderUncheckedUpdateManyInput });
        if (!moved.count) throw new ConflictException('O pedido já mudou de etapa: atualize a tela');
        await recordFlowEvent(tx, PURCHASE_FLOW.entity, { companyId: row.companyId, entityId: id, type: 'avancou', from: 'comprado', to: 'recebido', userId: actor.userId, note: 'Itens recebidos no estoque' });
      } else {
        await tx.purchase_Order.update({ where: { id }, data });
      }
    });
    return this.get(actor, id);
  }
}
