import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatActor } from './chat-channels.service';
import { ChatEventsService } from './chat-events.service';
import { SECTORS } from './chat.settings';

/**
 * Respostas rápidas ("/" na conversa) e etiquetas das conversas.
 * Quem responde clientes cria e usa; apagar etiqueta é de quem cuida dos números.
 */

export const TAG_COLORS = ['#149E5E', '#3E6F98', '#F0C419', '#E52127', '#78716C', '#8B5CF6', '#EC4899', '#0EA5E9'];
const slug = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

@Injectable()
export class ChatLibraryService {
  constructor(private readonly prisma: PrismaService, private readonly events: ChatEventsService) {}

  private assertReply(actor: ChatActor) {
    if (!['responder_conversas', 'canais_conversas'].some((p) => actor.permissions.includes(p))) throw new ForbiddenException('Você não tem permissão para isso.');
  }

  // ---------------------------------------------------------------- respostas rápidas

  async replies(actor: ChatActor) {
    const rows = await this.prisma.chat_QuickReply.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: [{ uses: 'desc' }, { shortcut: 'asc' }] });
    return rows.map(({ companyId, inactiveAt, ...row }) => row);
  }

  private cleanReply(body: Record<string, unknown>) {
    const shortcut = slug(String(body.shortcut ?? ''));
    const title = String(body.title ?? '').trim().slice(0, 120);
    const text = String(body.text ?? '').trim();
    if (!shortcut) throw new BadRequestException('Dê um atalho (ex.: orcamento). É o que se digita depois da barra.');
    if (!text) throw new BadRequestException('Escreva o texto da resposta.');
    if (text.length > 4000) throw new BadRequestException('O texto passou de 4.000 caracteres.');
    const sector = body.sector ? String(body.sector) : null;
    if (sector && !SECTORS.some((s) => s.id === sector)) throw new BadRequestException('Setor inválido');
    return { shortcut, title: title || shortcut, text, sector };
  }

  private async assertFree(companyId: number, shortcut: string, id?: number) {
    const taken = await this.prisma.chat_QuickReply.findFirst({ where: { companyId, shortcut, inactiveAt: null, ...(id ? { id: { not: id } } : {}) } });
    if (taken) throw new ConflictException(`Já existe uma resposta com o atalho /${shortcut}.`);
  }

  async createReply(actor: ChatActor, body: Record<string, unknown>) {
    this.assertReply(actor);
    const data = this.cleanReply(body);
    await this.assertFree(actor.companyId, data.shortcut);
    const { companyId, inactiveAt, ...row } = await this.prisma.chat_QuickReply.create({ data: { ...data, companyId: actor.companyId, createdByUserId: actor.userId } });
    return row;
  }

  async updateReply(actor: ChatActor, id: number, body: Record<string, unknown>) {
    this.assertReply(actor);
    const found = await this.prisma.chat_QuickReply.findFirst({ where: { id, companyId: actor.companyId, inactiveAt: null } });
    if (!found) throw new NotFoundException('Resposta não encontrada');
    const data = this.cleanReply({ ...found, ...body });
    await this.assertFree(actor.companyId, data.shortcut, id);
    const { companyId, inactiveAt, ...row } = await this.prisma.chat_QuickReply.update({ where: { id }, data });
    return row;
  }

  async removeReply(actor: ChatActor, id: number) {
    this.assertReply(actor);
    const done = await this.prisma.chat_QuickReply.updateMany({ where: { id, companyId: actor.companyId, inactiveAt: null }, data: { inactiveAt: new Date() } });
    if (!done.count) throw new NotFoundException('Resposta não encontrada');
    return { ok: true };
  }

  /** Conta o uso (as mais usadas aparecem primeiro). */
  async used(actor: ChatActor, id: number) {
    await this.prisma.chat_QuickReply.updateMany({ where: { id, companyId: actor.companyId }, data: { uses: { increment: 1 } } });
    return { ok: true };
  }

  // ---------------------------------------------------------------- etiquetas

  async tags(actor: ChatActor) {
    const rows = await this.prisma.chat_Tag.findMany({
      where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' },
      include: { _count: { select: { conversations: true } } },
    });
    return rows.map((t) => ({ id: t.id, name: t.name, color: t.color, conversations: t._count.conversations }));
  }

  async createTag(actor: ChatActor, body: Record<string, unknown>) {
    this.assertReply(actor);
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) throw new BadRequestException('Dê um nome para a etiqueta.');
    const exists = await this.prisma.chat_Tag.findFirst({ where: { companyId: actor.companyId, inactiveAt: null, name: { equals: name, mode: 'insensitive' } } });
    if (exists) return { id: exists.id, name: exists.name, color: exists.color, conversations: 0 };
    const count = await this.prisma.chat_Tag.count({ where: { companyId: actor.companyId } });
    const color = TAG_COLORS.includes(String(body.color)) ? String(body.color) : TAG_COLORS[count % TAG_COLORS.length];
    const tag = await this.prisma.chat_Tag.create({ data: { companyId: actor.companyId, name, color } });
    return { id: tag.id, name: tag.name, color: tag.color, conversations: 0 };
  }

  async updateTag(actor: ChatActor, id: number, body: Record<string, unknown>) {
    this.assertReply(actor);
    const found = await this.prisma.chat_Tag.findFirst({ where: { id, companyId: actor.companyId, inactiveAt: null } });
    if (!found) throw new NotFoundException('Etiqueta não encontrada');
    const name = body.name !== undefined ? String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) : found.name;
    if (!name) throw new BadRequestException('Dê um nome para a etiqueta.');
    const color = body.color !== undefined && TAG_COLORS.includes(String(body.color)) ? String(body.color) : found.color;
    const tag = await this.prisma.chat_Tag.update({ where: { id }, data: { name, color } });
    return { id: tag.id, name: tag.name, color: tag.color };
  }

  async removeTag(actor: ChatActor, id: number) {
    if (!actor.permissions.includes('canais_conversas')) throw new ForbiddenException('Só quem cuida dos números pode apagar etiquetas.');
    const found = await this.prisma.chat_Tag.findFirst({ where: { id, companyId: actor.companyId, inactiveAt: null } });
    if (!found) throw new NotFoundException('Etiqueta não encontrada');
    await this.prisma.chat_ConversationTag.deleteMany({ where: { tagId: id } });
    await this.prisma.chat_Tag.update({ where: { id }, data: { inactiveAt: new Date() } });
    return { ok: true };
  }

  /** Troca as etiquetas de uma conversa (a conversa já foi conferida por quem chamou). */
  async setConversationTags(actor: ChatActor, conversation: { id: number; channelId: number; companyId: number; assignedUserId: number | null }, tagIds: unknown) {
    this.assertReply(actor);
    if (!Array.isArray(tagIds)) throw new BadRequestException('Informe as etiquetas.');
    const ids = [...new Set(tagIds.map(Number).filter((n) => n > 0))].slice(0, 10);
    const valid = ids.length ? await this.prisma.chat_Tag.findMany({ where: { id: { in: ids }, companyId: actor.companyId, inactiveAt: null }, select: { id: true } }) : [];
    await this.prisma.chat_ConversationTag.deleteMany({ where: { conversationId: conversation.id } });
    if (valid.length) await this.prisma.chat_ConversationTag.createMany({ data: valid.map((t) => ({ conversationId: conversation.id, tagId: t.id })) });
    this.events.emit({ companyId: conversation.companyId, kind: 'conversation', channelId: conversation.channelId, conversationId: conversation.id, assignedUserId: conversation.assignedUserId });
  }
}
