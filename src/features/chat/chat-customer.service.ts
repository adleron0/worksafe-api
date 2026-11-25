import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatActor } from './chat-channels.service';

/**
 * Ficha do cliente dentro da conversa: buscar e vincular um cliente ao
 * contato e um resumo do que ele tem com a empresa (propostas, ordens de
 * serviço, contas a receber, inscrições). Cada bloco só aparece para quem tem
 * a permissão daquela área.
 */

const OPEN_OS = ['a_liberar', 'a_mobilizar', 'agendada', 'em_execucao'];
const OPEN_RECEIVABLE = ['waiting', 'processing', 'overdue'];
const num = (value: unknown) => (value == null ? 0 : Number(value));

@Injectable()
export class ChatCustomerService {
  constructor(private readonly prisma: PrismaService) {}

  private can(actor: ChatActor, permission: string) {
    return actor.permissions.includes(permission);
  }

  /** Busca para vincular (nome, razão social ou CPF/CNPJ). */
  async search(actor: ChatActor, term: string) {
    if (!this.can(actor, 'list_clientes')) throw new ForbiddenException('Você não tem permissão para ver os clientes.');
    const search = String(term ?? '').trim();
    const digits = search.replace(/\D/g, '');
    const where: Prisma.CustomerWhereInput = {
      companyId: actor.companyId, inactiveAt: null,
      ...(search ? { OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { corporateName: { contains: search, mode: 'insensitive' } },
        ...(digits.length >= 3 ? [{ cnpj: { contains: digits } }, { phone: { contains: digits } }] : []),
      ] } : {}),
    };
    const rows = await this.prisma.customer.findMany({
      where, orderBy: { name: 'asc' }, take: 15,
      select: { id: true, name: true, corporateName: true, cnpj: true, phone: true, city: { select: { name: true } }, state: { select: { uf: true } } },
    });
    return rows.map((r) => ({ id: r.id, name: r.name, corporateName: r.corporateName, cnpj: r.cnpj, phone: r.phone, place: [r.city?.name, r.state?.uf].filter(Boolean).join('/') || null }));
  }

  async assertCustomer(companyId: number, customerId: number) {
    const found = await this.prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true, name: true } });
    if (!found) throw new BadRequestException('Cliente não encontrado');
    return found;
  }

  /** Resumo do cliente para a ficha da conversa. */
  async summary(actor: ChatActor, customerId: number) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, companyId: actor.companyId },
      select: { id: true, name: true, corporateName: true, cnpj: true, phone: true, email: true, inactiveAt: true, city: { select: { name: true } }, state: { select: { uf: true } } },
    });
    if (!customer) throw new NotFoundException('Cliente não encontrado');
    const where = { customerId, companyId: actor.companyId };
    const [proposals, orders, receivables, subscriptions] = await Promise.all([
      this.can(actor, 'list_comercial')
        ? this.prisma.commercial_Proposal.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, number: true, title: true, status: true, total: true, createdAt: true } })
        : null,
      this.can(actor, 'list_ordens_de_servico')
        ? this.prisma.service_Order.findMany({ where: { ...where, status: { in: OPEN_OS as any } }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, number: true, title: true, status: true } })
        : null,
      this.can(actor, 'list_financeiro')
        ? this.prisma.financialRecords.findMany({ where: { ...where, status: { in: OPEN_RECEIVABLE as any } }, orderBy: { dueDate: 'asc' }, take: 50, select: { id: true, value: true, dueDate: true, status: true, description: true } as any })
        : null,
      this.can(actor, 'list_classes')
        ? this.prisma.courseClassSubscription.findMany({ where: { customerId, companyId: actor.companyId } as any, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, name: true, subscribeStatus: true, createdAt: true, class: { select: { id: true, name: true, initialDate: true } } } as any })
        : null,
    ]);
    const now = Date.now();
    const open = (receivables as any[] | null) ?? null;
    return {
      customer: {
        id: customer.id, name: customer.name, corporateName: customer.corporateName, cnpj: customer.cnpj, phone: customer.phone, email: customer.email,
        place: [customer.city?.name, customer.state?.uf].filter(Boolean).join('/') || null, active: !customer.inactiveAt,
      },
      proposals: proposals?.map((p) => ({ ...p, total: num(p.total) })) ?? null,
      orders: orders ?? null,
      receivables: open
        ? {
          count: open.length,
          total: open.reduce((sum, r) => sum + num(r.value), 0),
          overdue: open.filter((r) => r.status === 'overdue' || (r.dueDate && new Date(r.dueDate).getTime() < now)).length,
          next: open[0] ? { value: num(open[0].value), dueDate: open[0].dueDate, description: open[0].description ?? null } : null,
        }
        : null,
      subscriptions: (subscriptions as any[] | null)?.map((s) => ({ id: s.id, name: s.name, status: s.subscribeStatus, createdAt: s.createdAt, class: s.class })) ?? null,
    };
  }
}
