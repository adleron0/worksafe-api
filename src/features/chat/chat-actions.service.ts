import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ActivityService, brasiliaNow } from 'src/features/commercial/activity.service';
import { DealService } from 'src/features/commercial/deal.service';
import { DocumentService } from 'src/features/commercial/document.service';
import { ALL_PROPOSALS_PERMISSION } from 'src/features/commercial/ownership';
import { COSTS_PERMISSION } from 'src/features/commercial/proposal.controller';
import { ChatActor } from './chat-channels.service';
import { ChatEventsService } from './chat-events.service';
import { previewOf } from './chat.settings';

/**
 * Ações comerciais a partir da conversa: registrar o contato no
 * acompanhamento (com o trecho da conversa), agendar retorno, abrir ou ligar
 * uma negociação e montar links para mandar ao cliente (turma, proposta,
 * negociação). Cada ação respeita a permissão da área de destino.
 */

type Conversation = { id: number; companyId: number; channelId: number; assignedUserId: number | null; dealId: number | null; contact: { customerId: number | null; name: string | null; pushName: string | null }; channel: { type: string } };
type Body = Record<string, unknown>;

const blank = (value: unknown) => value === undefined || value === null || value === '';
const two = (n: number) => String(n).padStart(2, '0');
/** "25/11 14:32" no horário de Brasília. */
const stamp = (date: Date) => {
  const local = new Date(date.getTime() - 3 * 3600 * 1000);
  return `${two(local.getUTCDate())}/${two(local.getUTCMonth() + 1)} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`;
};

@Injectable()
export class ChatActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivityService,
    private readonly deals: DealService,
    private readonly documents: DocumentService,
    private readonly events: ChatEventsService,
  ) {}

  private has(actor: ChatActor, ...permissions: string[]) {
    return permissions.some((p) => actor.permissions.includes(p));
  }

  private commercialActor(actor: ChatActor) {
    return { userId: actor.userId, companyId: actor.companyId, seesAll: this.has(actor, ALL_PROPOSALS_PERMISSION), canSeeCosts: this.has(actor, COSTS_PERMISSION) };
  }

  private customerOf(conversation: Conversation) {
    if (!conversation.contact.customerId) throw new BadRequestException('Vincule um cliente a este contato primeiro (na ficha ao lado).');
    return conversation.contact.customerId;
  }

  private contactName(conversation: Conversation) {
    return conversation.contact.name || conversation.contact.pushName || null;
  }

  /** As últimas mensagens em texto corrido, para guardar junto do registro. */
  async excerpt(conversation: Conversation, limit = 15) {
    const rows = await this.prisma.chat_Message.findMany({
      where: { conversationId: conversation.id, direction: { in: ['in', 'out'] } },
      orderBy: { sentAt: 'desc' }, take: Math.min(Math.max(limit, 1), 40),
      select: { direction: true, type: true, text: true, sentAt: true, sentByUserId: true, sentByBotId: true },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.sentByUserId).filter((v): v is number => !!v))] } }, select: { id: true, name: true } });
    const bots = await this.prisma.ai_Bot.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.sentByBotId).filter((v): v is number => !!v))] } }, select: { id: true, name: true } });
    const client = this.contactName(conversation) || 'Cliente';
    return rows.reverse().map((r) => {
      const who = r.direction === 'in' ? client
        : (r.sentByBotId ? bots.find((b) => b.id === r.sentByBotId)?.name : r.sentByUserId ? users.find((u) => u.id === r.sentByUserId)?.name?.split(' ')[0] : null) || 'Empresa';
      return `[${stamp(r.sentAt)}] ${who}: ${previewOf(r.type, r.text)}`;
    }).join('\n');
  }

  private async tieToConversation(ids: number[], conversation: Conversation) {
    if (ids.length) await this.prisma.commercial_Activity.updateMany({ where: { id: { in: ids }, companyId: conversation.companyId }, data: { chatConversationId: conversation.id } });
  }

  private assertActivity(actor: ChatActor) {
    if (!this.has(actor, 'update_acompanhamento')) throw new ForbiddenException('Você não tem permissão para registrar acompanhamentos.');
  }

  /** Registra o contato como feito no acompanhamento (e marca o próximo retorno, se vier). */
  async registerContact(actor: ChatActor, conversation: Conversation, body: Body) {
    this.assertActivity(actor);
    const customerId = this.customerOf(conversation);
    const withExcerpt = body.excerpt !== false && body.excerpt !== 'false';
    const notes = [String(body.notes ?? '').trim(), withExcerpt ? `Trecho da conversa:\n${await this.excerpt(conversation, Number(body.messages) || 15)}` : ''].filter(Boolean).join('\n\n');
    const isInstagram = conversation.channel.type === 'instagram';
    const created = await this.activities.create(this.commercialActor(actor), {
      type: isInstagram ? 'nota' : 'whatsapp', customerId, dealId: conversation.dealId ?? undefined, done: true,
      subject: String(body.subject ?? '').trim() || (isInstagram ? 'Conversa pelo Instagram' : 'Conversa pelo WhatsApp'),
      result: body.result, notes, contactName: this.contactName(conversation),
      next: body.next && typeof body.next === 'object' && !blank((body.next as Body).dueDate) ? body.next : undefined,
    });
    // o retorno marcado junto nasce no mesmo instante, logo depois do registro
    const next = body.next && !blank((body.next as Body)?.dueDate)
      ? await this.prisma.commercial_Activity.findFirst({ where: { companyId: actor.companyId, customerId, doneAt: null, createdByUserId: actor.userId || null, id: { gt: created.id } }, orderBy: { id: 'asc' }, select: { id: true } })
      : null;
    await this.tieToConversation([created.id, ...(next ? [next.id] : [])], conversation);
    return { id: created.id, nextId: next?.id ?? null };
  }

  /** Agenda um retorno (aparece na agenda do comercial e na ficha da conversa). */
  async scheduleReturn(actor: ChatActor, conversation: Conversation, body: Body) {
    this.assertActivity(actor);
    const customerId = this.customerOf(conversation);
    if (blank(body.dueDate)) throw new BadRequestException('Escolha o dia do retorno.');
    const type = ['ligacao', 'whatsapp', 'email', 'reuniao', 'visita', 'tarefa'].includes(String(body.type)) ? String(body.type) : 'whatsapp';
    const created = await this.activities.create(this.commercialActor(actor), {
      type, customerId, dealId: conversation.dealId ?? undefined, done: false,
      subject: String(body.subject ?? '').trim() || 'Retornar a conversa', notes: body.notes, contactName: this.contactName(conversation),
      dueDate: body.dueDate, dueTime: body.dueTime, userId: body.userId,
    });
    await this.tieToConversation([created.id], conversation);
    return { id: created.id };
  }

  /** Retornos e contatos registrados a partir desta conversa (os pendentes primeiro). */
  async activitiesOf(actor: ChatActor, conversation: Conversation) {
    if (!this.has(actor, 'list_comercial', 'update_acompanhamento')) return null;
    const rows = await this.prisma.commercial_Activity.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, OR: [{ chatConversationId: conversation.id }, ...(conversation.contact.customerId ? [{ customerId: conversation.contact.customerId, doneAt: null }] : [])] },
      orderBy: [{ doneAt: { sort: 'desc', nulls: 'first' } }, { dueDate: 'asc' }], take: 8,
      select: { id: true, type: true, subject: true, dueDate: true, dueTime: true, doneAt: true, userId: true, chatConversationId: true },
    });
    const today = brasiliaNow().date;
    return rows.map((r) => {
      const due = r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null;
      return { ...r, dueDate: due, fromHere: r.chatConversationId === conversation.id, overdue: !r.doneAt && !!due && due < today, today: !r.doneAt && due === today };
    });
  }

  // ---------------------------------------------------------------- negociação

  /** Abre uma negociação para o cliente e liga à conversa. */
  async createDeal(actor: ChatActor, conversation: Conversation, body: Body) {
    if (!this.has(actor, 'create_comercial')) throw new ForbiddenException('Você não tem permissão para abrir negociações.');
    const customerId = this.customerOf(conversation);
    const withExcerpt = body.excerpt === true || body.excerpt === 'true';
    const notes = [String(body.notes ?? '').trim(), withExcerpt ? `Começou na conversa (${conversation.channel.type === 'instagram' ? 'Instagram' : 'WhatsApp'}):\n${await this.excerpt(conversation, 10)}` : ''].filter(Boolean).join('\n\n');
    const deal = await this.deals.create(this.commercialActor(actor), { customerId, title: body.title, notes, sellerId: body.sellerId });
    await this.setDeal(conversation, deal.id);
    return { id: deal.id, number: deal.number, title: deal.title };
  }

  /** Liga (ou solta, com null) uma negociação já existente do mesmo cliente. */
  async linkDeal(actor: ChatActor, conversation: Conversation, dealId: unknown) {
    if (!this.has(actor, 'list_comercial')) throw new ForbiddenException('Você não tem permissão para ver negociações.');
    if (blank(dealId)) {
      await this.setDeal(conversation, null);
      return { ok: true };
    }
    const customerId = this.customerOf(conversation);
    const deal = await this.deals.get(this.commercialActor(actor), Number(dealId));
    if (deal.customer?.id !== customerId) throw new BadRequestException('Essa negociação é de outro cliente.');
    await this.setDeal(conversation, deal.id);
    return { ok: true };
  }

  private async setDeal(conversation: Conversation, dealId: number | null) {
    await this.prisma.chat_Conversation.update({ where: { id: conversation.id }, data: { dealId } });
    this.events.emit({ companyId: conversation.companyId, kind: 'conversation', channelId: conversation.channelId, conversationId: conversation.id, assignedUserId: conversation.assignedUserId });
  }

  /** A negociação ligada e as abertas do cliente (para escolher). */
  async dealsOf(actor: ChatActor, conversation: Conversation) {
    if (!this.has(actor, 'list_comercial')) return null;
    const customerId = conversation.contact.customerId;
    let current: { id: number; number: string; title: string; status: string; statusLabel: string; total: number; publicUrl: string | null } | null = null;
    if (conversation.dealId) {
      try {
        const d = await this.deals.get(this.commercialActor(actor), conversation.dealId);
        current = { id: d.id, number: d.number, title: d.title, status: d.status, statusLabel: d.statusLabel, total: d.total, publicUrl: d.publicUrl };
      } catch {
        current = null;
      }
    }
    const options = customerId
      ? await this.prisma.commercial_Deal.findMany({ where: { companyId: actor.companyId, customerId, inactiveAt: null }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, number: true, title: true } })
      : [];
    return { current, options };
  }

  // ---------------------------------------------------------------- links para enviar

  private async siteBase(companyId: number) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { lp_domain: true, websiteUrl: true } });
    const domain = String(company?.lp_domain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (domain) return `https://${domain}`;
    const site = String(company?.websiteUrl ?? '').trim().replace(/\/+$/, '');
    return site ? (/^https?:\/\//.test(site) ? site : `https://${site}`) : null;
  }

  /**
   * O que dá para mandar ao cliente: turmas com inscrição aberta no site (e as
   * próximas, para inscrever pelo sistema), propostas enviadas do cliente e o
   * link da negociação ligada.
   */
  async links(actor: ChatActor, conversation: Conversation) {
    const today = new Date(`${brasiliaNow().date}T00:00:00.000Z`);
    const base = await this.siteBase(actor.companyId);
    const classes = this.has(actor, 'list_classes', 'create_classes', 'list_treinamentos', 'create_treinamentos')
      ? await this.prisma.courseClass.findMany({
        where: { companyId: actor.companyId, inactiveAt: null, active: true, OR: [{ initialDate: { gte: today } }, { finalDate: { gte: today } }] },
        orderBy: { initialDate: 'asc' }, take: 30,
        select: { id: true, name: true, initialDate: true, finalDate: true, openClass: true, allowSubscriptions: true, price: true, discountPrice: true },
      })
      : [];
    const customerId = conversation.contact.customerId;
    const proposals = customerId && this.has(actor, 'list_comercial')
      ? await this.prisma.commercial_Proposal.findMany({
        where: { companyId: actor.companyId, customerId, inactiveAt: null, publicKey: { not: null }, status: { notIn: ['substituida', 'cancelada'] as any } },
        orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, number: true, title: true, status: true, total: true, publicKey: true },
      })
      : [];
    const deal = conversation.dealId && this.has(actor, 'list_comercial')
      ? await this.prisma.commercial_Deal.findFirst({ where: { id: conversation.dealId, companyId: actor.companyId, inactiveAt: null }, select: { id: true, number: true, title: true, publicKey: true } })
      : null;
    const proposalLinks = await Promise.all(proposals.map(async (p) => ({
      id: p.id, number: p.number, title: p.title, status: p.status, total: Number(p.total ?? 0), url: await this.documents.publicUrl(actor.companyId, p.publicKey!),
    })));
    const dealUrl = deal?.publicKey ? (await this.documents.publicUrl(actor.companyId, deal.publicKey))?.replace(/\/proposta\/[^/]+$/, `/negociacao/${deal.publicKey}`) ?? null : null;
    return {
      classes: classes.map((c) => {
        const open = !!c.openClass && c.allowSubscriptions;
        return {
          id: c.id, name: c.name, initialDate: c.initialDate, finalDate: c.finalDate, open,
          price: c.discountPrice != null ? Number(c.discountPrice) : c.price != null ? Number(c.price) : null,
          url: open && base ? `${base}/turma/${c.id}` : null,
        };
      }),
      proposals: proposalLinks,
      deal: deal ? { id: deal.id, number: deal.number, title: deal.title, url: dealUrl } : null,
    };
  }
}
