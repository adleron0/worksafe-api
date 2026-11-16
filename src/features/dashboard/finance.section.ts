import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ReportService } from 'src/features/financial/report.service';
import { dayStart, plusDays, round } from 'src/features/financial/ledger.filters';
import { DashboardActor, OPEN_RECEIVABLE, brShort, daysBetween } from './shared';

/** Linhas da DRE que somam receita (para margem e meta). */
const REVENUE_LINES = ['receita_bruta', 'outras_receitas', 'sem_receita'];
const TOP = 5;

/**
 * Financeiro do resumo: lucro do mês (DRE), caixa hoje e projetado, gráfico de
 * caixa (realizado + 60 dias), inadimplência por faixa, meta e receita por área.
 * Reaproveita os relatórios do financeiro para os números baterem com as telas.
 */
@Injectable()
export class FinanceSection {
  constructor(private readonly prisma: PrismaService, private readonly reports: ReportService) {}

  async build(actor: DashboardActor, today: string) {
    const [dre, flow, next30, overdue, goal, areas] = await Promise.all([
      this.reports.dre(actor.companyId, { to: today.slice(0, 7) } as never),
      // ~4 meses para trás e 60 dias para a frente, semana a semana
      this.reports.cashFlow(actor.companyId, { from: plusDays(today, -119), to: plusDays(today, 60), group: 'week' } as never),
      this.reports.cashFlow(actor.companyId, { from: today, to: plusDays(today, 30), group: 'month' } as never),
      this.overdue(actor.companyId, today),
      this.goal(actor.companyId, today),
      this.revenueByArea(actor.companyId, today),
    ]);

    // ---------------- lucro do mês (DRE por competência) ----------------
    const row = (key: string) => dre.rows.find((r) => r.key === key);
    const result = row('resultado')!;
    const revenueOf = (m: string) => REVENUE_LINES.reduce((sum, key) => sum + (row(key)?.values[m] ?? 0), 0);
    const marginOf = (m: string) => (revenueOf(m) > 0 ? result.values[m] / revenueOf(m) : null);
    const current = dre.months[dre.months.length - 1];
    const previous = dre.months[dre.months.length - 2];
    const margin = marginOf(current);
    const prevMargin = previous ? marginOf(previous) : null;

    // ---------------- caixa ----------------
    // período que contém hoje: saldo realizado até agora (sem o previsto da semana)
    const points = flow.rows.map((r) => {
      const isPast = r.end < today;
      const isNow = r.start <= today && r.end >= today;
      const realNow = round(r.opening + r.realizedIn - r.realizedOut + r.transfers);
      return {
        key: r.key,
        label: isNow ? 'hoje' : r.label.slice(0, 5),
        real: isPast ? r.closing : isNow ? realNow : null,
        projected: isNow ? realNow : isPast ? null : r.closing,
      };
    });
    const future = flow.rows.filter((r) => r.end >= today);
    const lowestRow = future.reduce<(typeof future)[number] | null>((low, r) => (!low || r.closing < low.closing ? r : low), null);
    const cashToday = next30.opening;

    return {
      profit: {
        value: round(result.values[current] ?? 0),
        revenue: round(revenueOf(current)),
        margin: margin === null ? null : round(margin * 10000) / 10000,
        marginDelta: margin !== null && prevMargin !== null ? round((margin - prevMargin) * 10000) / 10000 : null,
        trend: dre.months.map((m) => round(result.values[m] ?? 0)),
        link: '/financeiro/relatorios',
      },
      cash: {
        today: round(cashToday),
        projected30: next30.closing,
        in30: next30.totals.projectedIn,
        out30: next30.totals.projectedOut,
        trend: points.filter((p) => p.real !== null).slice(-6).map((p) => p.real as number),
        link: '/financeiro/relatorios',
      },
      cashFlow: {
        points,
        lowest: lowestRow ? { key: lowestRow.key, label: lowestRow.start <= today ? 'hoje' : brShort(lowestRow.end), value: lowestRow.closing } : null,
        link: '/financeiro/relatorios',
      },
      overdue,
      goal: { ...goal, achieved: round(revenueOf(current)) },
      revenueByArea: areas,
    };
  }

  /** Contas a receber vencidas, por faixa de atraso, com os maiores devedores. */
  private async overdue(companyId: number, today: string) {
    const rows = await this.prisma.financialRecords.findMany({
      where: { companyId, inactiveAt: null, status: { in: OPEN_RECEIVABLE }, dueDate: { lt: dayStart(today) } },
      select: { id: true, value: true, dueDate: true, customerId: true, description: true, customer: { select: { name: true } }, trainee: { select: { name: true } }, subscription: { select: { name: true } } },
    });
    const buckets = { upTo15: 0, upTo30: 0, over30: 0 };
    const byDebtor = new Map<string, { id: number; customer: string; days: number; value: number; link: string }>();
    for (const r of rows) {
      const value = Number(r.value ?? 0);
      const days = daysBetween(r.dueDate!.toISOString().slice(0, 10), today);
      if (days <= 15) buckets.upTo15 += value; else if (days <= 30) buckets.upTo30 += value; else buckets.over30 += value;
      const name = r.customer?.name ?? r.trainee?.name ?? r.subscription?.name ?? r.description ?? 'Sem cliente';
      const key = r.customerId ? `c${r.customerId}` : `n${name}`;
      const entry = byDebtor.get(key) ?? { id: r.id, customer: name, days: 0, value: 0, link: `/financeiro/receber?view=atrasadas&q=${encodeURIComponent(name)}` };
      entry.value += value;
      entry.days = Math.max(entry.days, days);
      byDebtor.set(key, entry);
    }
    const total = buckets.upTo15 + buckets.upTo30 + buckets.over30;
    return {
      total: round(total),
      count: rows.length,
      buckets: { upTo15: round(buckets.upTo15), upTo30: round(buckets.upTo30), over30: round(buckets.over30) },
      items: [...byDebtor.values()].sort((a, b) => b.days - a.days || b.value - a.value).slice(0, TOP).map((e) => ({ ...e, value: round(e.value) })),
      link: '/financeiro/receber?view=atrasadas',
    };
  }

  /** Meta de faturamento do mês (cadastrada em Empresa) e dias que faltam. */
  private async goal(companyId: number, today: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { monthlyRevenueGoal: true } });
    const [y, m, d] = today.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const target = company?.monthlyRevenueGoal ? Number(company.monthlyRevenueGoal) : null;
    return { target: target && target > 0 ? target : null, daysLeft: lastDay - d, link: target ? '/financeiro/relatorios' : '/empresa' };
  }

  /**
   * Receita dos últimos 12 meses por área, pelo plano de contas: cada conta
   * a receber sobe até a conta logo abaixo da raiz (ex.: Receitas › Serviços).
   */
  private async revenueByArea(companyId: number, today: string) {
    const from = plusDays(today, -365).slice(0, 7);
    const [accounts, rows] = await Promise.all([
      this.prisma.financial_ChartAccount.findMany({ where: { companyId }, select: { id: true, parentId: true, name: true } }),
      this.prisma.financialRecords.groupBy({
        by: ['chartAccountId'],
        where: { companyId, inactiveAt: null, status: { notIn: ['cancelled', 'declined', 'chargeback'] }, accrualDate: { gte: from, lte: today.slice(0, 7) } },
        _sum: { value: true },
      }),
    ]);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const areaOf = (id: number | null) => {
      let current = id ? byId.get(id) : undefined;
      if (!current) return null;
      while (current.parentId && byId.get(current.parentId)?.parentId) current = byId.get(current.parentId)!;
      return current;
    };
    const totals = new Map<string, { key: string; label: string; value: number }>();
    for (const r of rows) {
      const area = areaOf(r.chartAccountId);
      const key = area ? String(area.id) : 'sem';
      const entry = totals.get(key) ?? { key, label: area?.name ?? 'Sem classificação', value: 0 };
      entry.value += Number(r._sum.value ?? 0);
      totals.set(key, entry);
    }
    return [...totals.values()]
      .filter((a) => a.value > 0)
      .sort((a, b) => (a.key === 'sem' ? 1 : b.key === 'sem' ? -1 : b.value - a.value))
      .map((a) => ({ ...a, value: round(a.value), margin: null as number | null }));
  }
}
