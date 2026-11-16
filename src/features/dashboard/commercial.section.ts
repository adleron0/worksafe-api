import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ActivityService } from 'src/features/commercial/activity.service';
import { ALL_PROPOSALS_PERMISSION, proposalsVisibleTo } from 'src/features/commercial/ownership';
import { DashboardActor, asDate, daysBetween, iso, lastMonths, plus, round2 } from './shared';

const OPEN = ['enviada', 'visualizada'] as const;
/** Sem histórico de decisões, a carteira é ponderada por esta chance. */
const DEFAULT_CHANCE = 0.3;
const STALLED_DAYS = 7;
const TOP = 5;

/**
 * Comercial do resumo: carteira em aberto ponderada pela conversão recente,
 * funil, conversão e tempo até o aceite (90 dias) e as propostas sem contato
 * há mais de uma semana. Respeita o "só as minhas" das propostas.
 */
@Injectable()
export class CommercialSection {
  constructor(private readonly prisma: PrismaService, private readonly activities: ActivityService) {}

  async build(actor: DashboardActor, today: string) {
    const visible = proposalsVisibleTo({ userId: actor.userId, companyId: actor.companyId, seesAll: actor.permissions.includes(ALL_PROPOSALS_PERMISSION) });
    const base: Prisma.Commercial_ProposalWhereInput = { companyId: actor.companyId, inactiveAt: null, ...visible };
    const since90 = asDate(plus(today, -90));
    const monthStart = asDate(`${today.slice(0, 7)}-01`);
    const months = lastMonths(today, 6);

    const [open, decided, sent] = await Promise.all([
      this.prisma.commercial_Proposal.findMany({
        where: { ...base, status: { in: [...OPEN] } },
        select: { id: true, number: true, title: true, status: true, total: true, sentAt: true, viewedAt: true, updatedAt: true, customer: { select: { name: true } } },
        take: 1000,
      }),
      this.prisma.commercial_Proposal.findMany({
        where: { ...base, status: { in: ['aceita', 'recusada', 'expirada'] }, decidedAt: { gte: since90 } },
        select: { status: true, total: true, sentAt: true, decidedAt: true },
        take: 2000,
      }),
      this.prisma.commercial_Proposal.findMany({
        where: { ...base, sentAt: { gte: asDate(`${months[0]}-01`) }, status: { notIn: ['rascunho', 'substituida', 'cancelada'] } },
        select: { sentAt: true, total: true },
        take: 5000,
      }),
    ]);

    const accepted = decided.filter((p) => p.status === 'aceita');
    const conversion = decided.length ? accepted.length / decided.length : null;
    const acceptDays = accepted.filter((p) => p.sentAt && p.decidedAt).map((p) => daysBetween(iso(p.sentAt)!, iso(p.decidedAt)!));
    const value = (rows: Array<{ total: unknown }>) => round2(rows.reduce((sum, row) => sum + Number(row.total ?? 0), 0));
    const openValue = value(open);
    const acceptedThisMonth = accepted.filter((p) => p.decidedAt! >= monthStart);

    // parada: sem contato (acompanhamento, envio ou visualização) há mais de uma semana
    const followUps = await this.activities.followUps(actor.companyId, open.map((p) => p.id));
    const stalled = open
      .map((p) => {
        const last = [followUps.get(p.id)?.lastAt ?? null, iso(p.viewedAt), iso(p.sentAt)].filter(Boolean).sort().pop() as string | undefined;
        return { p, days: last ? daysBetween(last.slice(0, 10), today) : daysBetween(iso(p.updatedAt)!, today) };
      })
      .filter((x) => x.days > STALLED_DAYS)
      .sort((a, b) => Number(b.p.total) - Number(a.p.total))
      .slice(0, TOP)
      .map(({ p, days }) => ({ id: p.id, title: p.title || p.number, customer: p.customer?.name ?? 'Cliente', days, value: round2(Number(p.total ?? 0)), link: `/comercial/propostas/${p.id}` }));

    return {
      weighted: round2(openValue * (conversion ?? DEFAULT_CHANCE)),
      open: openValue,
      openCount: open.length,
      // valor enviado em propostas a cada mês
      trend: months.map((m) => value(sent.filter((p) => iso(p.sentAt)!.startsWith(m)))),
      funnel: [
        { key: 'enviada', label: 'Enviadas, sem abrir', count: open.filter((p) => p.status === 'enviada').length, value: value(open.filter((p) => p.status === 'enviada')) },
        { key: 'visualizada', label: 'Vistas pelo cliente', count: open.filter((p) => p.status === 'visualizada').length, value: value(open.filter((p) => p.status === 'visualizada')) },
        { key: 'aceita', label: 'Aceitas no mês', count: acceptedThisMonth.length, value: value(acceptedThisMonth) },
      ],
      conversion: conversion === null ? null : Math.round(conversion * 1000) / 1000,
      avgDaysToAccept: acceptDays.length ? Math.round((acceptDays.reduce((a, b) => a + b, 0) / acceptDays.length) * 10) / 10 : null,
      stalled,
      link: '/comercial/propostas',
    };
  }
}
