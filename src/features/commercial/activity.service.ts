import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Commercial_Activity, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ownProposalIds } from './ownership';

/**
 * Acompanhamento comercial: os contatos com o cliente (ligação, mensagem,
 * reunião, visita) e o que ficou marcado (retorno, tarefa).
 *
 * Uma atividade é uma coisa só nos dois momentos: nasce marcada (dia e, se
 * houver, hora) e vira feita quando alguém registra o que aconteceu; ou já
 * nasce feita, quando o contato é anotado depois. Ao concluir dá para marcar
 * o próximo retorno no mesmo passo, que é o que mantém a proposta andando.
 */
export const ACTIVITY_TYPES = ['ligacao', 'whatsapp', 'email', 'reuniao', 'visita', 'tarefa', 'nota'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
const TYPE_LABEL: Record<ActivityType, string> = {
  ligacao: 'Ligação', whatsapp: 'WhatsApp', email: 'E-mail', reuniao: 'Reunião', visita: 'Visita', tarefa: 'Tarefa', nota: 'Anotação',
};

export interface ActivityActor { userId: number; companyId: number; seesAll: boolean }
type Body = Record<string, unknown>;

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const text = (value: unknown, max = 10000) => String(value ?? '').trim().slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** Agora no horário de Brasília (UTC−3, sem horário de verão): dia e hora "HH:MM". */
export function brasiliaNow(now = new Date()) {
  const local = new Date(now.getTime() - 3 * 3600 * 1000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

function dateOf(value: unknown, label: string): string {
  const raw = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(String(value ?? '').trim())?.[1] ?? '';
  // 31 de fevereiro "vira" março no JavaScript: só vale a data que volta igual
  if (!raw || Number.isNaN(asDate(raw).getTime()) || iso(asDate(raw)) !== raw) throw new BadRequestException(`${label}: informe uma data válida`);
  return raw;
}
function timeOf(value: unknown): string | null {
  if (blank(value)) return null;
  const raw = String(value).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw new BadRequestException('Hora: use o formato HH:MM');
  return raw;
}

export interface FollowUp {
  /** próximo retorno marcado (o mais antigo ainda pendente) */
  next: { id: number; type: string; subject: string; dueDate: string; dueTime: string | null; overdue: boolean; today: boolean } | null;
  pending: number;
  /** último contato registrado */
  lastAt: Date | null;
}

@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ leitura

  /** Uma proposta e as suas revisões são a mesma conversa com o cliente. */
  private async familyIds(companyId: number, proposalIds: number[]): Promise<Map<number, number[]>> {
    const result = new Map<number, number[]>();
    if (!proposalIds.length) return result;
    const rows = await this.prisma.commercial_Proposal.findMany({ where: { companyId, id: { in: proposalIds } }, select: { id: true, rootId: true } });
    const roots = [...new Set(rows.map((row) => row.rootId ?? row.id))];
    const family = await this.prisma.commercial_Proposal.findMany({
      where: { companyId, OR: [{ id: { in: roots } }, { rootId: { in: roots } }] }, select: { id: true, rootId: true },
    });
    const byRoot = new Map<number, number[]>();
    for (const row of family) {
      const root = row.rootId ?? row.id;
      byRoot.set(root, [...(byRoot.get(root) ?? []), row.id]);
    }
    for (const row of rows) result.set(row.id, byRoot.get(row.rootId ?? row.id) ?? [row.id]);
    return result;
  }

  private async present(companyId: number, rows: Commercial_Activity[]) {
    const ids = <T,>(values: Array<T | null>) => [...new Set(values.filter((value): value is T => value !== null))];
    const [users, customers, proposals] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids(rows.map((row) => row.userId)) } }, select: { id: true, name: true } }),
      this.prisma.customer.findMany({ where: { companyId, id: { in: ids(rows.map((row) => row.customerId)) } }, select: { id: true, name: true } }),
      this.prisma.commercial_Proposal.findMany({
        where: { companyId, id: { in: ids(rows.map((row) => row.proposalId)) } }, select: { id: true, number: true, title: true, status: true },
      }),
    ]);
    const userName = new Map(users.map((user) => [user.id, user.name]));
    const customerOf = new Map(customers.map((customer) => [customer.id, customer]));
    const proposalOf = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const now = brasiliaNow();
    return rows.map((row) => {
      const dueDate = iso(row.dueDate);
      const pending = !row.doneAt && !row.inactiveAt;
      return {
        id: row.id, type: row.type, typeLabel: TYPE_LABEL[row.type as ActivityType] ?? row.type, subject: row.subject, notes: row.notes, contactName: row.contactName,
        dueDate, dueTime: row.dueTime, doneAt: row.doneAt, result: row.result,
        status: row.inactiveAt ? 'cancelada' : row.doneAt ? 'feita' : 'pendente',
        // atrasada = o dia já passou, ou é hoje e a hora marcada já passou
        overdue: pending && !!dueDate && (dueDate < now.date || (dueDate === now.date && !!row.dueTime && row.dueTime < now.time)),
        today: pending && dueDate === now.date,
        userId: row.userId, user: row.userId ? userName.get(row.userId) ?? null : null,
        customer: customerOf.get(row.customerId) ?? { id: row.customerId, name: '' },
        proposal: row.proposalId ? proposalOf.get(row.proposalId) ?? null : null,
        createdAt: row.createdAt,
      };
    });
  }

  /** Sem a permissão de ver tudo: os contatos da pessoa (dela ou criados por ela) e os das propostas dela. */
  private async visibleTo(actor: ActivityActor): Promise<Prisma.Commercial_ActivityWhereInput> {
    const own = await ownProposalIds(this.prisma, actor);
    if (!own) return {};
    return { OR: [{ userId: actor.userId }, { createdByUserId: actor.userId }, ...(own.length ? [{ proposalId: { in: own } }] : [])] };
  }

  async list(actor: ActivityActor, query: Record<string, string>) {
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
    const today = asDate(brasiliaNow().date);
    const proposalId = Number(query.proposalId) || 0;
    const family = proposalId ? (await this.familyIds(actor.companyId, [proposalId])).get(proposalId) ?? [proposalId] : null;
    const scope: Prisma.Commercial_ActivityWhereInput = {
      companyId: actor.companyId, inactiveAt: null, AND: [await this.visibleTo(actor)],
      ...(family ? { proposalId: { in: family } } : {}),
      ...(Number(query.customerId) > 0 ? { customerId: Number(query.customerId) } : {}),
      ...(Number(query.userId) > 0 ? { userId: Number(query.userId) } : {}),
    };
    const BY_STATUS: Record<string, Prisma.Commercial_ActivityWhereInput> = {
      pendentes: { doneAt: null }, atrasadas: { doneAt: null, dueDate: { lt: today } }, hoje: { doneAt: null, dueDate: today },
      proximas: { doneAt: null, dueDate: { gt: today } }, feitas: { doneAt: { not: null } },
    };
    const where = { ...scope, ...(BY_STATUS[query.status] ?? {}) };
    const count = (extra: Prisma.Commercial_ActivityWhereInput) => this.prisma.commercial_Activity.count({ where: { ...scope, ...extra } });
    const [rows, total, overdue, dueToday, upcoming, done] = await Promise.all([
      this.prisma.commercial_Activity.findMany({
        // pendentes primeiro, da mais antiga para a mais distante; depois as feitas, da mais recente para trás
        where, orderBy: [{ doneAt: { sort: 'desc', nulls: 'first' } }, { dueDate: 'asc' }, { dueTime: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        skip: page * limit, take: limit,
      }),
      this.prisma.commercial_Activity.count({ where }),
      count(BY_STATUS.atrasadas), count(BY_STATUS.hoje), count(BY_STATUS.proximas), count(BY_STATUS.feitas),
    ]);
    return { total, rows: await this.present(actor.companyId, rows), summary: { overdue, today: dueToday, upcoming, done } };
  }

  /** Para a lista e o kanban de propostas: o próximo retorno e o último contato de cada uma. */
  async followUps(companyId: number, proposalIds: number[]): Promise<Map<number, FollowUp>> {
    const result = new Map<number, FollowUp>();
    const family = await this.familyIds(companyId, proposalIds);
    const all = [...new Set([...family.values()].flat())];
    if (!all.length) return result;
    const rows = await this.prisma.commercial_Activity.findMany({
      where: { companyId, inactiveAt: null, proposalId: { in: all } },
      orderBy: [{ dueDate: 'asc' }, { dueTime: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      select: { id: true, proposalId: true, type: true, subject: true, dueDate: true, dueTime: true, doneAt: true },
    });
    const now = brasiliaNow();
    for (const [proposalId, members] of family) {
      const mine = rows.filter((row) => members.includes(row.proposalId!));
      const pending = mine.filter((row) => !row.doneAt && row.dueDate);
      const first = pending[0];
      const dueDate = first ? iso(first.dueDate)! : null;
      const last = mine.filter((row) => row.doneAt).reduce<Date | null>((max, row) => (!max || row.doneAt! > max ? row.doneAt : max), null);
      result.set(proposalId, {
        next: first && dueDate ? {
          id: first.id, type: first.type, subject: first.subject, dueDate, dueTime: first.dueTime,
          overdue: dueDate < now.date || (dueDate === now.date && !!first.dueTime && first.dueTime < now.time), today: dueDate === now.date,
        } : null,
        pending: pending.length, lastAt: last,
      });
    }
    return result;
  }

  // ------------------------------------------------------------------ escrita

  private async byId(actor: ActivityActor, id: number) {
    const row = await this.prisma.commercial_Activity.findFirst({ where: { id, companyId: actor.companyId, inactiveAt: null, AND: [await this.visibleTo(actor)] } });
    if (!row) throw new NotFoundException('Atividade não encontrada');
    return row;
  }

  private typeOf(value: unknown): ActivityType {
    if (!ACTIVITY_TYPES.includes(value as ActivityType)) throw new BadRequestException('Tipo de contato inválido');
    return value as ActivityType;
  }

  private async userOf(companyId: number, value: unknown, fallback: number | null): Promise<number | null> {
    if (blank(value)) return fallback;
    const id = Number(value);
    const user = await this.prisma.user.findFirst({ where: { id, companyId, inactiveAt: null }, select: { id: true } });
    if (!user) throw new BadRequestException('Responsável não encontrado');
    return user.id;
  }

  /** Quando o contato aconteceu: hoje vale a hora de agora; outro dia fica ao meio-dia (Brasília). */
  private doneAtOf(value: unknown): Date {
    const now = brasiliaNow();
    if (blank(value)) return new Date();
    const date = dateOf(value, 'Data do contato');
    if (date > now.date) throw new BadRequestException('Data do contato: não pode ser no futuro. Para marcar algo, use o agendamento.');
    return date === now.date ? new Date() : new Date(`${date}T12:00:00.000-03:00`);
  }

  /** O próximo passo marcado junto com o registro de um contato. */
  private nextOf(body: unknown, base: { companyId: number; customerId: number; proposalId: number | null; userId: number | null; contactName: string | null }, actor: ActivityActor) {
    if (!body || typeof body !== 'object' || blank((body as Body).dueDate)) return null;
    const next = body as Body;
    const type = this.typeOf(next.type ?? 'ligacao');
    return {
      ...base, type, subject: clean(next.subject, 200) || `${TYPE_LABEL[type]} de retorno`, notes: text(next.notes) || null,
      dueDate: asDate(dateOf(next.dueDate, 'Data do retorno')), dueTime: timeOf(next.dueTime), createdByUserId: actor.userId || null,
    };
  }

  async create(actor: ActivityActor, body: Body) {
    const type = this.typeOf(body.type);
    let customerId = Number(body.customerId) || 0;
    let proposalId: number | null = null;
    if (!blank(body.proposalId)) {
      const proposal = await this.prisma.commercial_Proposal.findFirst({ where: { id: Number(body.proposalId), companyId: actor.companyId }, select: { id: true, customerId: true } });
      if (!proposal) throw new NotFoundException('Proposta não encontrada');
      proposalId = proposal.id;
      customerId = proposal.customerId;
    } else {
      const customer = await this.prisma.customer.findFirst({ where: { id: customerId, companyId: actor.companyId }, select: { id: true } });
      if (!customer) throw new BadRequestException('Escolha o cliente');
    }
    const done = body.done === true || body.done === 'true';
    if (!done && blank(body.dueDate)) throw new BadRequestException('Informe para quando fica marcado, ou registre como contato já feito');
    const userId = await this.userOf(actor.companyId, body.userId, actor.userId || null);
    const contactName = clean(body.contactName, 160) || null;
    const base = { companyId: actor.companyId, customerId, proposalId, userId, contactName };
    const next = done ? this.nextOf(body.next, base, actor) : null;
    const data: Prisma.Commercial_ActivityUncheckedCreateInput = {
      ...base, type, subject: clean(body.subject, 200) || TYPE_LABEL[type], notes: text(body.notes) || null, createdByUserId: actor.userId || null,
      ...(done
        ? { doneAt: this.doneAtOf(body.doneDate), result: text(body.result, 2000) || null }
        : { dueDate: asDate(dateOf(body.dueDate, 'Data')), dueTime: timeOf(body.dueTime) }),
    };
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.commercial_Activity.create({ data });
      if (next) await tx.commercial_Activity.create({ data: next });
      return row;
    });
    return (await this.present(actor.companyId, [created]))[0];
  }

  async update(actor: ActivityActor, id: number, body: Body) {
    const row = await this.byId(actor, id);
    const data: Prisma.Commercial_ActivityUncheckedUpdateInput = {};
    if (body.type !== undefined) data.type = this.typeOf(body.type);
    if (body.subject !== undefined) {
      data.subject = clean(body.subject, 200);
      if (!data.subject) throw new BadRequestException('Informe o assunto');
    }
    if (body.notes !== undefined) data.notes = text(body.notes) || null;
    if (body.contactName !== undefined) data.contactName = clean(body.contactName, 160) || null;
    if (body.userId !== undefined) data.userId = await this.userOf(actor.companyId, body.userId, null);
    if (row.doneAt) {
      if (body.result !== undefined) data.result = text(body.result, 2000) || null;
      if (body.doneDate !== undefined) data.doneAt = this.doneAtOf(body.doneDate);
    } else {
      if (body.dueDate !== undefined) data.dueDate = asDate(dateOf(body.dueDate, 'Data'));
      if (body.dueTime !== undefined) data.dueTime = timeOf(body.dueTime);
    }
    const saved = await this.prisma.commercial_Activity.update({ where: { id: row.id }, data });
    return (await this.present(actor.companyId, [saved]))[0];
  }

  /** Conclui o que estava marcado, com o que ficou combinado e, se houver, o próximo retorno. */
  async complete(actor: ActivityActor, id: number, body: Body) {
    const row = await this.byId(actor, id);
    if (row.doneAt) throw new ConflictException('Esta atividade já foi concluída');
    const next = this.nextOf(body.next, { companyId: row.companyId, customerId: row.customerId, proposalId: row.proposalId, userId: row.userId, contactName: row.contactName }, actor);
    const saved = await this.prisma.$transaction(async (tx) => {
      // só conclui se ainda estiver pendente: dois cliques não geram dois retornos
      const changed = await tx.commercial_Activity.updateMany({
        where: { id: row.id, doneAt: null, inactiveAt: null }, data: { doneAt: this.doneAtOf(body.doneDate), result: text(body.result, 2000) || null },
      });
      if (!changed.count) throw new ConflictException('Esta atividade já foi concluída');
      if (next) await tx.commercial_Activity.create({ data: next });
      return tx.commercial_Activity.findUniqueOrThrow({ where: { id: row.id } });
    });
    return (await this.present(actor.companyId, [saved]))[0];
  }

  /** Volta para pendente o que foi concluído por engano. */
  async reopen(actor: ActivityActor, id: number) {
    const row = await this.byId(actor, id);
    if (!row.doneAt) throw new ConflictException('Esta atividade ainda está pendente');
    if (!row.dueDate) throw new ConflictException('Este contato foi registrado depois de feito: não há o que reabrir. Se foi engano, exclua.');
    const saved = await this.prisma.commercial_Activity.update({ where: { id: row.id }, data: { doneAt: null, result: null } });
    return (await this.present(actor.companyId, [saved]))[0];
  }

  /** Cancela o que estava marcado, ou exclui um registro feito por engano. Fica guardado, só sai das listas. */
  async remove(actor: ActivityActor, id: number) {
    const row = await this.byId(actor, id);
    await this.prisma.commercial_Activity.update({ where: { id: row.id }, data: { inactiveAt: new Date() } });
    return { id: row.id };
  }
}
