import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ordersVisibleTo } from 'src/features/operations/service-order.service';
import { DOCUMENTS_VIEW_PERMISSION, EmployeeDocumentService } from 'src/features/hr/document.service';
import { DashboardActor, OPEN_RECEIVABLE, asDate, iso, plus, round2 } from './shared';

export type WeekKind = 'os' | 'turma' | 'retorno' | 'pagar' | 'receber' | 'documento';
export interface WeekItem { date: string; title: string; kind: WeekKind; link: string }

const MAX_ITEMS = 12;
const brl = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(value);

/**
 * Os próximos 7 dias numa lista só: OS que começam ou terminam, turmas,
 * retornos da pessoa, contas a pagar e a receber (somadas por dia) e
 * documentos de funcionários que vencem. Cada fonte só entra com a permissão dela.
 */
@Injectable()
export class WeekSection {
  constructor(private readonly prisma: PrismaService, private readonly documents: EmployeeDocumentService) {}

  /** Nulo quando a pessoa não vê nenhuma das fontes. */
  async build(actor: DashboardActor, today: string, canSeeTraining: boolean): Promise<WeekItem[] | undefined> {
    const can = (p: string) => actor.permissions.includes(p);
    const end = plus(today, 6);
    const range = { gte: asDate(today), lt: asDate(plus(end, 1)) };
    const jobs: Array<Promise<WeekItem[]>> = [];

    if (can('list_ordens_de_servico')) jobs.push((async () => {
      const visible = await ordersVisibleTo(this.prisma, { userId: actor.userId, companyId: actor.companyId, seesAll: can('all_ordens_de_servico') });
      const base = { companyId: actor.companyId, inactiveAt: null, AND: [visible] };
      const [starting, ending] = await Promise.all([
        this.prisma.service_Order.findMany({ where: { ...base, status: { in: ['a_mobilizar', 'agendada'] }, plannedStart: range }, take: 20 }),
        this.prisma.service_Order.findMany({ where: { ...base, status: 'em_execucao', plannedEnd: range }, take: 20 }),
      ]);
      const names = await this.customerNames([...starting, ...ending].map((o) => o.customerId));
      return [
        ...starting.map((o) => ({ date: iso(o.plannedStart)!, title: `${o.number} começa · ${names.get(o.customerId) ?? o.title}`, kind: 'os' as const, link: `/servicos/ordens-de-servico/${o.id}` })),
        ...ending.map((o) => ({ date: iso(o.plannedEnd)!, title: `${o.number} termina · ${names.get(o.customerId) ?? o.title}`, kind: 'os' as const, link: `/servicos/ordens-de-servico/${o.id}` })),
      ];
    })());

    if (canSeeTraining) jobs.push((async () => {
      const classes = await this.prisma.courseClass.findMany({
        where: { companyId: actor.companyId, inactiveAt: null, active: true, initialDate: range },
        select: { id: true, name: true, initialDate: true, course: { select: { name: true } } },
        take: 20,
      });
      return classes.map((c) => ({ date: iso(c.initialDate)!, title: `Turma ${c.course?.name ?? c.name}`, kind: 'turma' as const, link: `/treinamentos/turmas/${c.id}` }));
    })());

    if (can('list_comercial')) jobs.push((async () => {
      const rows = await this.prisma.commercial_Activity.findMany({
        where: { companyId: actor.companyId, inactiveAt: null, doneAt: null, userId: actor.userId, dueDate: range },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: 20,
      });
      const names = await this.customerNames(rows.map((r) => r.customerId));
      return rows.map((r) => ({
        date: iso(r.dueDate)!,
        title: `Retorno · ${names.get(r.customerId) ?? 'cliente'}${r.subject ? ` · ${r.subject}` : ''}`,
        kind: 'retorno' as const,
        link: r.proposalId ? `/comercial/propostas/${r.proposalId}` : '/comercial/acompanhamento',
      }));
    })());

    if (can('list_financeiro')) jobs.push((async () => {
      const [payables, receivables] = await Promise.all([
        this.prisma.financial_Payable.groupBy({ by: ['dueDate'], where: { companyId: actor.companyId, inactiveAt: null, status: 'aberta', dueDate: range }, _sum: { value: true }, _count: { _all: true } }),
        this.prisma.financialRecords.groupBy({ by: ['dueDate'], where: { companyId: actor.companyId, inactiveAt: null, status: { in: OPEN_RECEIVABLE }, dueDate: range }, _sum: { value: true }, _count: { _all: true } }),
      ]);
      // várias contas no mesmo dia viram uma linha só
      const byDay = (rows: Array<{ dueDate: Date | null; _sum: { value: unknown }; _count: { _all: number } }>) => {
        const out = new Map<string, { count: number; value: number }>();
        for (const r of rows) {
          if (!r.dueDate) continue;
          const day = iso(r.dueDate)!;
          const entry = out.get(day) ?? { count: 0, value: 0 };
          entry.count += r._count._all;
          entry.value += Number(r._sum.value ?? 0);
          out.set(day, entry);
        }
        return out;
      };
      const items: WeekItem[] = [];
      for (const [date, e] of byDay(payables)) items.push({ date, title: `${e.count === 1 ? '1 conta a pagar' : `${e.count} contas a pagar`} · ${brl(round2(e.value))}`, kind: 'pagar', link: '/financeiro/pagar?view=semana' });
      for (const [date, e] of byDay(receivables)) items.push({ date, title: `${e.count === 1 ? '1 recebimento previsto' : `${e.count} recebimentos previstos`} · ${brl(round2(e.value))}`, kind: 'receber', link: '/financeiro/receber?view=semana' });
      return items;
    })());

    if (can(DOCUMENTS_VIEW_PERMISSION)) jobs.push((async () => {
      const { rows } = await this.documents.expiring({ userId: actor.userId, companyId: actor.companyId }, { status: 'a_vencer' });
      return rows
        .filter((r) => r.expiryDate && r.expiryDate >= today && r.expiryDate <= end)
        .map((r) => ({ date: r.expiryDate!, title: `${r.typeName} de ${r.employee.name.split(' ')[0]} vence`, kind: 'documento' as const, link: '/rh/vencimentos' }));
    })());

    if (!jobs.length) return undefined;
    const order: Record<WeekKind, number> = { os: 0, turma: 1, retorno: 2, documento: 3, pagar: 4, receber: 5 };
    return (await Promise.all(jobs)).flat().sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind]).slice(0, MAX_ITEMS);
  }

  private async customerNames(ids: number[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map<number, string>();
    const rows = await this.prisma.customer.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}
