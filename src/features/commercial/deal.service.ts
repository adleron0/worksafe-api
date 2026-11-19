import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommercialProposalStatus, Commercial_Deal, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { DealEvents } from './deal.events';
import { DocumentService } from './document.service';
import { Actor, ProposalService } from './proposal.service';

/**
 * Negociação: agrupa propostas do mesmo cliente (serviço, locação, treinamento).
 * Cada proposta continua com o seu destino (OS, OL, turma), o seu contrato e a
 * sua NF; a negociação só junta, mostra o total e cuida do desconto de
 * fechamento conjunto.
 *
 * Desconto conjunto (desligado por padrão):
 * - forma: percentual sobre o valor de cada proposta, ou um valor em R$ no total;
 * - rateio: proporcional ao valor de cada proposta, em partes iguais ou à mão;
 * - em quais propostas: todas ou só as escolhidas;
 * - condição: incondicional, "só se fechar todas" ou "só se fechar as marcadas";
 * - se a condição cair (ou uma proposta for perdida): avisar o vendedor,
 *   recalcular entre as que ficaram ou retirar o desconto.
 * O valor de cada proposta fica no `dealDiscount` dela; contrato e NF já nascem
 * com o valor certo. Proposta já enviada só muda por revisão (o documento que
 * o cliente leu é congelado); proposta aceita não muda mais.
 */
type Body = Record<string, any>;
type DealStatus = 'aberta' | 'ganha' | 'parcial' | 'perdida' | 'vazia';
type ProposalLite = {
  id: number; number: string; title: string; kind: string; status: CommercialProposalStatus; total: Prisma.Decimal; totalNet: Prisma.Decimal;
  discount: Prisma.Decimal; dealDiscount: Prisma.Decimal; publicKey: string | null; validUntil: Date | null; sellerId: number | null;
};
export interface PlanRow { id: number; number: string; status: CommercialProposalStatus; base: number; current: number; planned: number; action: 'gravar' | 'revisar' | 'travada' | 'fora' | 'igual' }
export interface Breach { at: string; reason: string; lost: number[]; action: 'avisar' | 'recalcular' | 'retirar'; pending: number[]; locked: number[] }

const OPEN: CommercialProposalStatus[] = ['rascunho', 'enviada', 'visualizada'];
const SENT: CommercialProposalStatus[] = ['enviada', 'visualizada'];
const LOST: CommercialProposalStatus[] = ['recusada', 'expirada', 'cancelada'];
const TYPES = ['percentual', 'valor'];
const SPLITS = ['proporcional', 'igual', 'manual'];
const CONDITIONS = ['incondicional', 'todas', 'marcadas'];
const BREAKS = ['avisar', 'recalcular', 'retirar'];
export const DEAL_STATUS_LABEL: Record<DealStatus, string> = { aberta: 'Aberta', ganha: 'Ganha', parcial: 'Parcialmente ganha', perdida: 'Perdida', vazia: 'Sem propostas' };
const SELECT = {
  id: true, number: true, title: true, kind: true, status: true, total: true, totalNet: true, discount: true, dealDiscount: true, publicKey: true, validUntil: true, sellerId: true,
} satisfies Prisma.Commercial_ProposalSelect;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const fail = (message: string): never => { throw new BadRequestException(message); };
const ids = (value: unknown): number[] => (Array.isArray(value) ? [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100) : []);
const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Situação da negociação pelas propostas: alguma em aberto = aberta; senão ganha, parcialmente ganha ou perdida. */
export function dealStatusOf(statuses: CommercialProposalStatus[]): DealStatus {
  if (!statuses.length) return 'vazia';
  if (statuses.some((s) => OPEN.includes(s))) return 'aberta';
  const won = statuses.filter((s) => s === 'aceita').length;
  return won === statuses.length ? 'ganha' : won > 0 ? 'parcial' : 'perdida';
}

/** A condição do desconto ainda vale? (proposta perdida derruba "todas"; marcada perdida derruba "marcadas") */
export function conditionHolds(deal: Pick<Commercial_Deal, 'discountCondition' | 'requiredIds'>, proposals: Array<{ id: number; status: CommercialProposalStatus }>): boolean {
  if (deal.discountCondition === 'todas') return !proposals.some((p) => LOST.includes(p.status));
  if (deal.discountCondition === 'marcadas') return !proposals.some((p) => deal.requiredIds.includes(p.id) && LOST.includes(p.status));
  return true;
}

/** Reparte `amount` em centavos pelos pesos; o resto dos centavos vai para a última. */
function spread(amount: number, weights: number[]): number[] {
  const cents = Math.round(amount * 100);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!weights.length || cents <= 0) return weights.map(() => 0);
  const parts = weights.map((w) => (sum > 0 ? Math.floor((cents * w) / sum) : Math.floor(cents / weights.length)));
  parts[parts.length - 1] += cents - parts.reduce((s, p) => s + p, 0);
  return parts.map((p) => p / 100);
}

/**
 * Quanto do desconto conjunto cabe a cada proposta. Propostas aceitas ficam com
 * o que já tinham (o contrato está fechado); perdidas e fora do alvo, zero.
 * `drop` tira propostas da conta (para recalcular sem as perdidas).
 */
export function planDiscount(deal: Pick<Commercial_Deal, 'discountEnabled' | 'discountType' | 'discountValue' | 'discountSplit' | 'discountManual' | 'discountTargets'>, proposals: ProposalLite[], base: (p: ProposalLite) => number, drop: number[] = []): PlanRow[] {
  const targets = deal.discountTargets.length ? deal.discountTargets : proposals.map((p) => p.id);
  const eligible = proposals.filter((p) => deal.discountEnabled && OPEN.includes(p.status) && targets.includes(p.id) && !drop.includes(p.id));
  const locked = proposals.filter((p) => p.status === 'aceita');
  const lockedSum = round2(locked.reduce((s, p) => s + Number(p.dealDiscount), 0));
  const value = Number(deal.discountValue);
  const planned = new Map<number, number>();
  if (eligible.length) {
    const bases = eligible.map(base);
    let amounts: number[];
    if (deal.discountSplit === 'manual') {
      const manual = (deal.discountManual ?? {}) as Record<string, unknown>;
      amounts = eligible.map((p) => round2(Math.max(0, Number(manual[String(p.id)] ?? 0))));
    } else if (deal.discountType === 'percentual') {
      const total = round2(bases.reduce((s, b) => s + b, 0) * value);
      amounts = deal.discountSplit === 'igual' ? spread(total, bases.map(() => 1)) : bases.map((b) => round2(b * value));
    } else {
      // valor em R$ no total da negociação: o que as aceitas já levaram sai da conta
      const remaining = Math.max(0, round2(value - lockedSum));
      amounts = spread(remaining, deal.discountSplit === 'igual' ? bases.map(() => 1) : bases);
    }
    // nunca mais que o valor da própria proposta
    eligible.forEach((p, i) => planned.set(p.id, Math.min(amounts[i], bases[i])));
  }
  return proposals.map((p) => {
    const current = round2(Number(p.dealDiscount));
    if (p.status === 'aceita') return { id: p.id, number: p.number, status: p.status, base: base(p), current, planned: current, action: 'travada' as const };
    const target = planned.get(p.id) ?? 0;
    const action = !OPEN.includes(p.status) ? 'fora' as const : Math.abs(target - current) < 0.005 ? 'igual' as const : p.status === 'rascunho' ? 'gravar' as const : 'revisar' as const;
    return { id: p.id, number: p.number, status: p.status, base: base(p), current, planned: OPEN.includes(p.status) ? round2(target) : current, action };
  });
}

@Injectable()
export class DealService {
  constructor(private readonly prisma: PrismaService, private readonly proposals: ProposalService, private readonly documents: DocumentService, events: DealEvents) {
    events.subscribe((companyId, proposalId) => this.onDecided(companyId, proposalId));
  }

  private visible(actor: Actor): Prisma.Commercial_DealWhereInput {
    return actor.seesAll ? {} : { OR: [{ sellerId: actor.userId }, { createdByUserId: actor.userId }] };
  }

  private async byId(actor: Actor, id: number) {
    const row = await this.prisma.commercial_Deal.findFirst({ where: { id, companyId: actor.companyId, inactiveAt: null, AND: [this.visible(actor)] } });
    if (!row) throw new NotFoundException('Negociação não encontrada');
    return row;
  }

  private proposalsOf(dealId: number) {
    return this.prisma.commercial_Proposal.findMany({ where: { dealId, inactiveAt: null, status: { not: 'substituida' } }, orderBy: { id: 'asc' }, select: SELECT });
  }

  private base = (p: ProposalLite) => this.proposals.baseOf(p);

  private summary(deal: Commercial_Deal, proposals: ProposalLite[]) {
    const status = dealStatusOf(proposals.map((p) => p.status));
    const live = proposals.filter((p) => !LOST.includes(p.status));
    const total = round2(live.reduce((s, p) => s + Number(p.total), 0));
    const won = round2(proposals.filter((p) => p.status === 'aceita').reduce((s, p) => s + Number(p.total), 0));
    const discount = round2(live.reduce((s, p) => s + Number(p.dealDiscount), 0));
    const holds = conditionHolds(deal, proposals);
    return { status, statusLabel: DEAL_STATUS_LABEL[status], total, won, discountTotal: discount, conditionHolds: holds, breach: (deal.breach as unknown as Breach | null) ?? null };
  }

  // ------------------------------------------------------------------ leitura

  async list(actor: Actor, query: Record<string, string>) {
    const term = clean(query.search, 80);
    const rows = await this.prisma.commercial_Deal.findMany({
      where: {
        companyId: actor.companyId, inactiveAt: null, AND: [this.visible(actor)],
        ...(Number(query.customerId) > 0 ? { customerId: Number(query.customerId) } : {}),
        ...(term ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { id: 'desc' }, take: 200,
    });
    const [proposals, customers, sellers] = await Promise.all([
      this.prisma.commercial_Proposal.findMany({ where: { dealId: { in: rows.map((r) => r.id) }, inactiveAt: null, status: { not: 'substituida' } }, select: { ...SELECT, dealId: true } }),
      this.prisma.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId) } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.sellerId).filter((x): x is number => !!x) } }, select: { id: true, name: true } }),
    ]);
    const result = rows.map((deal) => {
      const mine = proposals.filter((p) => p.dealId === deal.id);
      return {
        id: deal.id, number: deal.number, title: deal.title, createdAt: deal.createdAt,
        customer: customers.find((c) => c.id === deal.customerId) ?? null, seller: sellers.find((s) => s.id === deal.sellerId)?.name ?? null,
        discountEnabled: deal.discountEnabled, discountCondition: deal.discountCondition,
        proposals: mine.map((p) => ({ id: p.id, number: p.number, kind: p.kind, status: p.status, total: Number(p.total) })),
        ...this.summary(deal, mine),
      };
    });
    const status = String(query.status ?? '');
    return { rows: status ? result.filter((row) => row.status === status) : result };
  }

  async get(actor: Actor, id: number) {
    return this.present(await this.byId(actor, id));
  }

  private async present(deal: Commercial_Deal) {
    const proposals = await this.proposalsOf(deal.id);
    const [customer, seller, activities] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: deal.customerId }, select: { id: true, name: true } }),
      deal.sellerId ? this.prisma.user.findUnique({ where: { id: deal.sellerId }, select: { id: true, name: true } }) : null,
      this.prisma.commercial_Activity.findMany({
        where: { companyId: deal.companyId, inactiveAt: null, OR: [{ dealId: deal.id }, ...(proposals.length ? [{ proposalId: { in: proposals.map((p) => p.id) } }] : [])] },
        orderBy: [{ doneAt: { sort: 'desc', nulls: 'first' } }, { dueDate: 'asc' }], take: 30,
        select: { id: true, type: true, subject: true, dueDate: true, dueTime: true, doneAt: true, proposalId: true, dealId: true },
      }),
    ]);
    const plan = planDiscount(deal, proposals, this.base);
    const urls = new Map<number, string | null>();
    for (const p of proposals) urls.set(p.id, p.publicKey ? await this.documents.publicUrl(deal.companyId, p.publicKey) : null);
    return {
      id: deal.id, number: deal.number, title: deal.title, notes: deal.notes, customer, seller, createdAt: deal.createdAt,
      discount: {
        enabled: deal.discountEnabled, type: deal.discountType, value: Number(deal.discountValue), split: deal.discountSplit,
        manual: (deal.discountManual ?? {}) as Record<string, number>, targets: deal.discountTargets, condition: deal.discountCondition,
        requiredIds: deal.requiredIds, onBreak: deal.onBreak, appliedAt: deal.discountAppliedAt,
      },
      proposals: proposals.map((p) => {
        const row = plan.find((r) => r.id === p.id)!;
        return {
          id: p.id, number: p.number, title: p.title, kind: p.kind, status: p.status, total: Number(p.total), base: row.base,
          ownDiscount: Number(p.discount), dealDiscount: row.current, planned: row.planned, action: row.action,
          publicUrl: urls.get(p.id) ?? null,
        };
      }),
      pendingChanges: plan.filter((r) => r.action === 'gravar' || r.action === 'revisar').length,
      ...this.summary(deal, proposals),
      publicUrl: deal.publicKey ? await this.dealUrl(deal.companyId, deal.publicKey) : null,
      activities,
    };
  }

  /** Link do cliente para a negociação: mesma base do link da proposta. */
  private async dealUrl(companyId: number, key: string) {
    const proposalUrl = await this.documents.publicUrl(companyId, key);
    return proposalUrl ? proposalUrl.replace(/\/proposta\/[^/]+$/, `/negociacao/${key}`) : null;
  }

  /** Propostas do cliente que ainda podem entrar numa negociação. */
  async candidates(actor: Actor, id: number) {
    const deal = await this.byId(actor, id);
    const rows = await this.prisma.commercial_Proposal.findMany({
      where: {
        companyId: actor.companyId, customerId: deal.customerId, inactiveAt: null, dealId: null, status: { in: [...OPEN, 'aceita'] },
        ...(actor.seesAll ? {} : { OR: [{ sellerId: actor.userId }, { createdByUserId: actor.userId }] }),
      },
      orderBy: { id: 'desc' }, take: 100, select: { id: true, number: true, title: true, kind: true, status: true, total: true },
    });
    return rows.map((row) => ({ ...row, total: Number(row.total) }));
  }

  // ------------------------------------------------------------------ cadastro

  private async attach(actor: Actor, deal: Commercial_Deal, proposalIds: number[]) {
    if (!proposalIds.length) return;
    const rows = await this.prisma.commercial_Proposal.findMany({
      where: { id: { in: proposalIds }, companyId: actor.companyId, inactiveAt: null, ...(actor.seesAll ? {} : { OR: [{ sellerId: actor.userId }, { createdByUserId: actor.userId }] }) },
      select: { id: true, number: true, customerId: true, dealId: true, status: true },
    });
    if (rows.length !== proposalIds.length) fail('Proposta não encontrada');
    for (const row of rows) {
      if (row.customerId !== deal.customerId) fail(`A ${row.number} é de outro cliente: a negociação junta propostas do mesmo cliente`);
      if (row.dealId && row.dealId !== deal.id) fail(`A ${row.number} já está em outra negociação`);
      if (row.status === 'substituida') fail(`A ${row.number} foi substituída por uma revisão: escolha a revisão mais nova`);
    }
    await this.prisma.commercial_Proposal.updateMany({ where: { id: { in: proposalIds } }, data: { dealId: deal.id } });
  }

  private async nextNumber(tx: Prisma.TransactionClient, companyId: number) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(740130::int, ${companyId}::int)`;
    const year = new Date().getFullYear();
    const last = await tx.commercial_Deal.aggregate({ where: { companyId, year }, _max: { sequence: true } });
    const sequence = (last._max.sequence ?? 0) + 1;
    return { year, sequence, number: `NG-${year}-${String(sequence).padStart(4, '0')}` };
  }

  async create(actor: Actor, body: Body) {
    let customerId = Number(body.customerId) || 0;
    const proposalIds = ids(body.proposalIds);
    // sem cliente informado, vale o da primeira proposta escolhida
    if (!customerId && proposalIds.length) customerId = (await this.prisma.commercial_Proposal.findFirst({ where: { id: proposalIds[0], companyId: actor.companyId }, select: { customerId: true } }))?.customerId ?? 0;
    const customer = customerId ? await this.prisma.customer.findFirst({ where: { id: customerId, companyId: actor.companyId }, select: { id: true, name: true } }) : null;
    if (!customer) fail('Escolha o cliente da negociação');
    const sellerId = blank(body.sellerId) ? actor.userId || null : Number(body.sellerId);
    if (sellerId && !(await this.prisma.user.findFirst({ where: { id: sellerId, companyId: actor.companyId }, select: { id: true } }))) fail('Vendedor não encontrado');
    const deal = await this.prisma.$transaction(async (tx) => tx.commercial_Deal.create({ data: {
      companyId: actor.companyId, ...(await this.nextNumber(tx, actor.companyId)), customerId: customer!.id,
      title: clean(body.title, 200) || `Negociação ${customer!.name}`.slice(0, 200), sellerId, notes: String(body.notes ?? '').trim().slice(0, 4000) || null,
      createdByUserId: actor.userId || null,
    } }));
    await this.attach(actor, deal, proposalIds);
    return this.get(actor, deal.id);
  }

  async update(actor: Actor, id: number, body: Body) {
    const deal = await this.byId(actor, id);
    const data: Prisma.Commercial_DealUpdateInput = {};
    if ('title' in body) { data.title = clean(body.title, 200); if (String(data.title).length < 2) fail('Informe o título da negociação'); }
    if ('notes' in body) data.notes = String(body.notes ?? '').trim().slice(0, 4000) || null;
    if ('sellerId' in body) {
      const sellerId = blank(body.sellerId) ? null : Number(body.sellerId);
      if (sellerId && !(await this.prisma.user.findFirst({ where: { id: sellerId, companyId: actor.companyId }, select: { id: true } }))) fail('Vendedor não encontrado');
      data.sellerId = sellerId;
    }
    const d = (body.discount ?? {}) as Body;
    const members = (await this.proposalsOf(deal.id)).map((p) => p.id);
    if ('enabled' in d) data.discountEnabled = d.enabled === true || d.enabled === 'true';
    if ('type' in d) { if (!TYPES.includes(d.type)) fail('Forma do desconto inválida'); data.discountType = d.type; }
    const type = (data.discountType as string | undefined) ?? deal.discountType;
    if ('value' in d || 'type' in d) {
      const value = Number('value' in d ? d.value : deal.discountValue);
      if (!(value >= 0)) fail('Valor do desconto inválido');
      if (type === 'percentual' && value > 0.9) fail('O desconto percentual vai até 90%');
      if (type === 'valor' && value > 1e10) fail('Valor do desconto inválido');
      data.discountValue = type === 'percentual' ? Math.round(value * 1e4) / 1e4 : round2(value);
    }
    if ('split' in d) { if (!SPLITS.includes(d.split)) fail('Rateio inválido'); data.discountSplit = d.split; }
    if ('manual' in d) {
      const manual: Record<string, number> = {};
      for (const [key, value] of Object.entries((d.manual ?? {}) as Record<string, unknown>)) {
        if (!members.includes(Number(key))) continue;
        const amount = round2(Number(value));
        if (!(amount >= 0)) fail('Valor do rateio inválido');
        if (amount > 0) manual[key] = amount;
      }
      data.discountManual = manual;
    }
    if ('targets' in d) data.discountTargets = ids(d.targets).filter((pid) => members.includes(pid));
    if ('condition' in d) { if (!CONDITIONS.includes(d.condition)) fail('Condição inválida'); data.discountCondition = d.condition; }
    if ('requiredIds' in d) data.requiredIds = ids(d.requiredIds).filter((pid) => members.includes(pid));
    if ('onBreak' in d) { if (!BREAKS.includes(d.onBreak)) fail('Escolha o que fazer se a condição cair'); data.onBreak = d.onBreak; }
    const condition = (data.discountCondition as string | undefined) ?? deal.discountCondition;
    const required = (data.requiredIds as number[] | undefined) ?? deal.requiredIds;
    if (condition === 'marcadas' && !required.length && ((data.discountEnabled as boolean | undefined) ?? deal.discountEnabled)) fail('Marque as propostas que precisam fechar para o desconto valer');
    await this.prisma.commercial_Deal.update({ where: { id }, data });
    return this.get(actor, id);
  }

  async addProposals(actor: Actor, id: number, body: Body) {
    const deal = await this.byId(actor, id);
    await this.attach(actor, deal, ids(body.proposalIds));
    return this.get(actor, id);
  }

  /** Tira a proposta da negociação; o desconto conjunto dela sai se ainda for rascunho. */
  async removeProposal(actor: Actor, id: number, proposalId: number) {
    const deal = await this.byId(actor, id);
    const row = await this.prisma.commercial_Proposal.findFirst({ where: { id: proposalId, dealId: deal.id }, select: { id: true, status: true, dealDiscount: true } });
    if (!row) throw new NotFoundException('A proposta não está nesta negociação');
    if (row.status === 'rascunho' && Number(row.dealDiscount) > 0) await this.proposals.setDealDiscount(actor.companyId, row.id, 0);
    await this.prisma.commercial_Proposal.update({ where: { id: row.id }, data: { dealId: null } });
    const manual = { ...((deal.discountManual ?? {}) as Record<string, number>) };
    delete manual[String(proposalId)];
    await this.prisma.commercial_Deal.update({ where: { id }, data: {
      discountTargets: deal.discountTargets.filter((x) => x !== proposalId), requiredIds: deal.requiredIds.filter((x) => x !== proposalId), discountManual: manual,
    } });
    return this.get(actor, id);
  }

  async inactivate(actor: Actor, id: number) {
    const deal = await this.byId(actor, id);
    for (const row of await this.proposalsOf(deal.id)) {
      if (row.status === 'rascunho' && Number(row.dealDiscount) > 0) await this.proposals.setDealDiscount(actor.companyId, row.id, 0);
    }
    await this.prisma.commercial_Proposal.updateMany({ where: { dealId: deal.id }, data: { dealId: null } });
    await this.prisma.commercial_Deal.update({ where: { id }, data: { inactiveAt: new Date() } });
    return { id, inactive: true };
  }

  // ------------------------------------------------------------------ desconto

  /** Grava o plano: rascunho recalcula na hora; enviada vira revisão (se autorizado); aceita não muda. */
  private async applyPlan(actor: Actor, plan: PlanRow[], reviseSent: boolean) {
    const toRevise = plan.filter((r) => r.action === 'revisar');
    if (toRevise.length && !reviseSent) {
      throw new ConflictException(`${toRevise.map((r) => r.number).join(', ')} já ${toRevise.length === 1 ? 'foi enviada' : 'foram enviadas'}: o valor só muda numa revisão (que precisa ser enviada de novo). Confirme para criar as revisões.`);
    }
    const revised: string[] = [];
    for (const row of plan) {
      if (row.action === 'gravar') await this.proposals.setDealDiscount(actor.companyId, row.id, row.planned);
      if (row.action === 'revisar') { await this.proposals.reviseWithDealDiscount(actor, row.id, row.planned); revised.push(row.number); }
    }
    return revised;
  }

  /** Aplica o desconto conjunto como está configurado (ou zera, se desligado). */
  async applyDiscount(actor: Actor, id: number, body: Body) {
    const deal = await this.byId(actor, id);
    const proposals = await this.proposalsOf(deal.id);
    if (deal.discountEnabled && !conditionHolds(deal, proposals)) fail('A condição do desconto já não vale (uma proposta exigida foi perdida). Mude a condição ou retire o desconto.');
    const revised = await this.applyPlan(actor, planDiscount(deal, proposals, this.base), body.reviseSent === true || body.reviseSent === 'true');
    await this.prisma.commercial_Deal.update({ where: { id }, data: { discountAppliedAt: deal.discountEnabled ? new Date() : null, breach: Prisma.DbNull } });
    return { ...(await this.get(actor, id)), revised };
  }

  /** Simula o rateio de uma configuração sem gravar (a tela mostra antes de aplicar). */
  async previewDiscount(actor: Actor, id: number, body: Body) {
    const deal = await this.byId(actor, id);
    const proposals = await this.proposalsOf(deal.id);
    const d = (body.discount ?? {}) as Body;
    const draft = {
      ...deal,
      discountEnabled: 'enabled' in d ? d.enabled === true || d.enabled === 'true' : deal.discountEnabled,
      discountType: TYPES.includes(d.type) ? d.type : deal.discountType,
      discountValue: new Prisma.Decimal('value' in d && Number(d.value) >= 0 ? Number(d.value) : Number(deal.discountValue)),
      discountSplit: SPLITS.includes(d.split) ? d.split : deal.discountSplit,
      discountManual: 'manual' in d ? d.manual : deal.discountManual,
      discountTargets: 'targets' in d ? ids(d.targets) : deal.discountTargets,
      discountCondition: CONDITIONS.includes(d.condition) ? d.condition : deal.discountCondition,
      requiredIds: 'requiredIds' in d ? ids(d.requiredIds) : deal.requiredIds,
    };
    const plan = planDiscount(draft, proposals, this.base);
    return { plan, total: round2(plan.reduce((s, r) => s + r.planned, 0)), conditionHolds: conditionHolds(draft, proposals) };
  }

  /**
   * Uma proposta da negociação foi decidida. Se ela foi perdida depois que o
   * desconto foi aplicado, confere a condição e faz o combinado: avisar (o
   * vendedor revisa), recalcular entre as que ficaram ou retirar. Só mexe nas
   * que estão em rascunho; enviadas ficam pendentes de revisão e aceitas, travadas.
   */
  private async onDecided(companyId: number, proposalId: number) {
    const proposal = await this.prisma.commercial_Proposal.findFirst({ where: { id: proposalId, companyId }, select: { dealId: true, status: true } });
    if (!proposal?.dealId || !LOST.includes(proposal.status)) return;
    const deal = await this.prisma.commercial_Deal.findFirst({ where: { id: proposal.dealId, inactiveAt: null } });
    if (!deal || !deal.discountEnabled || !deal.discountAppliedAt) return;
    const proposals = await this.proposalsOf(deal.id);
    const previous = (deal.breach as unknown as Breach | null) ?? null;
    const lost = proposals.filter((p) => LOST.includes(p.status)).map((p) => p.id);
    if (previous && lost.every((pid) => previous.lost.includes(pid))) return;
    const holds = conditionHolds(deal, proposals);
    // incondicional: só o valor em R$ (ou à mão) depende das outras propostas
    const affected = !holds || (deal.onBreak === 'recalcular' && deal.discountType === 'valor');
    if (!affected) return;
    const lostNames = proposals.filter((p) => lost.includes(p.id)).map((p) => p.number).join(', ');
    let plan: PlanRow[] = [];
    if (deal.onBreak === 'retirar' && !holds) plan = planDiscount({ ...deal, discountEnabled: false }, proposals, this.base);
    else if (deal.onBreak === 'recalcular' || (deal.onBreak === 'retirar' && holds)) plan = planDiscount(deal, proposals, this.base, lost);
    const pending: number[] = [];
    for (const row of plan) {
      if (row.action === 'gravar') await this.proposals.setDealDiscount(companyId, row.id, row.planned);
      if (row.action === 'revisar') pending.push(row.id);
    }
    // aceitas que ganharam o desconto sob uma condição que caiu: o contrato já está fechado
    const locked = !holds ? proposals.filter((p) => p.status === 'aceita' && Number(p.dealDiscount) > 0).map((p) => p.id) : [];
    if (deal.onBreak === 'avisar') for (const p of proposals) if (SENT.includes(p.status) || p.status === 'rascunho') if (Number(p.dealDiscount) > 0) pending.push(p.id);
    const reason = !holds
      ? `${lostNames} ${lost.length === 1 ? 'foi perdida' : 'foram perdidas'}: a condição "${deal.discountCondition === 'todas' ? 'só se fechar todas' : 'só se fechar as marcadas'}" caiu`
      : `${lostNames} ${lost.length === 1 ? 'foi perdida' : 'foram perdidas'}: o desconto de ${money(Number(deal.discountValue))} foi recalculado entre as que ficaram`;
    const breach: Breach = { at: new Date().toISOString(), reason, lost, action: deal.onBreak as Breach['action'], pending: [...new Set(pending)], locked };
    await this.prisma.commercial_Deal.update({ where: { id: deal.id }, data: { breach: breach as unknown as Prisma.InputJsonValue } });
  }

  /** O vendedor viu o aviso e decidiu: some da tela. */
  async dismissBreach(actor: Actor, id: number) {
    await this.byId(actor, id);
    await this.prisma.commercial_Deal.update({ where: { id }, data: { breach: Prisma.DbNull } });
    return this.get(actor, id);
  }

  // ------------------------------------------------------------------ link do cliente

  async createLink(actor: Actor, id: number) {
    const deal = await this.byId(actor, id);
    if (!deal.publicKey) await this.prisma.commercial_Deal.update({ where: { id }, data: { publicKey: randomUUID() } });
    return this.get(actor, id);
  }

  /** O que o cliente vê: as propostas enviadas da negociação, cada uma com o link de aceite dela. */
  async publicView(key: string) {
    if (!/^[a-f0-9-]{20,40}$/i.test(String(key))) throw new NotFoundException('Negociação não encontrada');
    const deal = await this.prisma.commercial_Deal.findFirst({ where: { publicKey: key, inactiveAt: null } });
    if (!deal) throw new NotFoundException('Negociação não encontrada');
    const [proposals, customer, brand] = await Promise.all([
      this.proposalsOf(deal.id),
      this.prisma.customer.findUnique({ where: { id: deal.customerId }, select: { name: true } }),
      this.documents.brand(deal.companyId).catch(() => null),
    ]);
    // rascunho não vai para o cliente
    const shown = proposals.filter((p) => p.publicKey && p.status !== 'rascunho');
    return {
      number: deal.number, title: deal.title, customer: customer?.name ?? '', brand: brand ? { logoUrl: brand.logoUrl, color: brand.color } : null,
      condition: deal.discountEnabled && deal.discountCondition !== 'incondicional' ? deal.discountCondition : null,
      discount: round2(shown.filter((p) => !LOST.includes(p.status)).reduce((s, p) => s + Number(p.dealDiscount), 0)),
      total: round2(shown.filter((p) => !LOST.includes(p.status)).reduce((s, p) => s + Number(p.total), 0)),
      proposals: shown.map((p) => ({
        number: p.number, title: p.title, kind: p.kind, status: p.status, total: Number(p.total), dealDiscount: Number(p.dealDiscount),
        required: deal.discountCondition === 'marcadas' && deal.requiredIds.includes(p.id), key: p.publicKey,
      })),
    };
  }
}
