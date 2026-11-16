import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ordersVisibleTo } from 'src/features/operations/service-order.service';
import { DailyReportService } from 'src/features/operations/daily-report.service';
import { OrderResultService } from 'src/features/operations/order-result.service';
import { DashboardActor, asDate, daysBetween, iso, round2 } from './shared';

const OPEN = ['a_liberar', 'a_mobilizar', 'agendada', 'em_execucao'] as const;
const RUNNING_FIRST: Record<string, number> = { em_execucao: 0, agendada: 1, a_mobilizar: 2, a_liberar: 3 };
const SHOWN = 6;
const COSTS_PERMISSION = 'view_custos_comercial';

/**
 * Operação do resumo: serviço contratado que ainda falta executar (receita
 * orçada × o que falta fazer) e as obras abertas com avanço, margem projetada
 * (só para quem vê custos) e atraso. Respeita o "só as minhas" das OS.
 */
@Injectable()
export class OperationsSection {
  constructor(private readonly prisma: PrismaService, private readonly reports: DailyReportService, private readonly results: OrderResultService) {}

  async build(actor: DashboardActor, today: string) {
    const canSeeCosts = actor.permissions.includes(COSTS_PERMISSION);
    const visible = await ordersVisibleTo(this.prisma, { userId: actor.userId, companyId: actor.companyId, seesAll: actor.permissions.includes('all_ordens_de_servico') });
    const orders = await this.prisma.service_Order.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, status: { in: [...OPEN] }, AND: [visible] },
      orderBy: [{ plannedStart: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: 60,
    });
    const customers = await this.prisma.customer.findMany({ where: { id: { in: orders.map((o) => o.customerId) } }, select: { id: true, name: true } });
    const customerName = new Map(customers.map((c) => [c.id, c.name]));

    const rows = await Promise.all(orders.map(async (order) => {
      const revenue = Number((order.budget as { revenue?: unknown } | null)?.revenue ?? 0);
      let progress: number | null;
      let margin: number | null = null;
      if (canSeeCosts) {
        const result = await this.results.compute(order);
        progress = result.progress.done === null ? null : result.progress.done / 100;
        margin = result.totals.projected.margin === null ? null : result.totals.projected.margin / 100;
      } else {
        const diary = await this.reports.summaryOf(order, false);
        progress = diary.progress.done === null ? null : diary.progress.done / 100;
      }
      const date = asDate(today);
      const lateDays = order.status === 'em_execucao'
        ? (order.plannedEnd && order.plannedEnd < date ? daysBetween(iso(order.plannedEnd)!, today) : 0)
        : (order.plannedStart && order.plannedStart < date ? daysBetween(iso(order.plannedStart)!, today) : 0);
      return {
        order, revenue, remaining: revenue * (1 - Math.min(1, progress ?? 0)),
        row: {
          id: order.id,
          title: [order.number, order.title].filter(Boolean).join(' · '),
          customer: customerName.get(order.customerId) ?? '',
          progress: progress === null ? null : round2(progress),
          margin: margin === null ? null : Math.round(margin * 1000) / 1000,
          lateDays,
          link: `/servicos/ordens-de-servico/${order.id}`,
        },
      };
    }));

    const shown = [...rows]
      .sort((a, b) => (b.row.lateDays > 0 ? 1 : 0) - (a.row.lateDays > 0 ? 1 : 0) || RUNNING_FIRST[a.order.status] - RUNNING_FIRST[b.order.status] || b.revenue - a.revenue)
      .slice(0, SHOWN)
      .map((r) => r.row);

    return {
      backlog: { value: round2(rows.reduce((sum, r) => sum + r.remaining, 0)), count: rows.length, trend: [] as number[] },
      orders: shown,
      link: '/servicos/ordens-de-servico',
    };
  }
}
