import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { seatsOfClasses } from 'src/features/training/reservation/seats';
import { DashboardActor, OPEN_RECEIVABLE, asDate, brShort, iso, lastMonths, plus, round2 } from './shared';

/** Turma encerrada há até tantos dias ainda cobra os certificados. */
const CERT_LOOKBACK = 60;
/** Janela das próximas turmas (ocupação, quórum, instrutor). */
const UPCOMING_DAYS = 60;
/** Quórum só preocupa quando a turma está perto. */
const QUORUM_DAYS = 21;
/** Reciclagem: certificados que vencem nos próximos dias. */
const RENEWAL_DAYS = 90;
/** Satisfação e aprovação olham os últimos dias. */
const QUALITY_DAYS = 90;

export type Tone = 'danger' | 'warning' | 'info';
export interface ActionItem { key: string; tone: Tone; title: string; detail: string; count: number; link: string }

const classLink = (id: number, tab?: string) => `/treinamentos/turmas/${id}${tab ? `?tab=${tab}` : ''}`;

/**
 * Painel de treinamentos (GET /dashboard/training). Tudo é calculado no
 * servidor, a partir das turmas, inscrições, certificados, provas e avaliações
 * da empresa: o que pede ação, os indicadores do mês, as próximas turmas, as
 * reciclagens a vencer e a tendência dos últimos 6 meses.
 */
@Injectable()
export class TrainingSection {
  constructor(private readonly prisma: PrismaService) {}

  async build(actor: DashboardActor, today: string) {
    const companyId = actor.companyId;
    const canSeeMoney = actor.permissions.includes('list_financeiro');
    const months = lastMonths(today, 6);
    const since = asDate(`${months[0]}-01`);

    const [classes, subscriptionsCreated, reviews, exams, renewals] = await Promise.all([
      // turmas do período da tendência em diante (inclui as futuras)
      this.prisma.courseClass.findMany({
        where: { companyId, inactiveAt: null, OR: [{ initialDate: { gte: since } }, { finalDate: { gte: since } }] },
        orderBy: [{ initialDate: 'asc' }, { id: 'asc' }],
        take: 1000,
        select: {
          id: true, name: true, active: true, initialDate: true, finalDate: true,
          maxSubscriptions: true, unlimitedSubscriptions: true, minimumQuorum: true,
          course: { select: { name: true } },
          instructors: { where: { active: true, inactiveAt: null }, select: { id: true } },
          _count: { select: { certificates: { where: { inactiveAt: null } } } },
          subscriptions: {
            where: { inactiveAt: null },
            select: { id: true, subscribeStatus: true, financialRecords: { select: { status: true } } },
          },
        },
      }),
      this.prisma.courseClassSubscription.findMany({
        where: { companyId, inactiveAt: null, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      this.prisma.courseReview.findMany({
        where: { companyId, inactiveAt: null, createdAt: { gte: asDate(plus(today, -QUALITY_DAYS)) } },
        select: { generalRating: true },
      }),
      this.prisma.courseClassExam.findMany({
        where: { companyId, inactiveAt: null, createdAt: { gte: asDate(plus(today, -QUALITY_DAYS)) } },
        select: { result: true },
      }),
      this.renewals(companyId, today),
    ]);

    // vagas com as reservas de empresa (vaga reservada é vaga vendida)
    const seatMap = await seatsOfClasses(this.prisma, classes.map((c) => c.id));
    const reservedOpen = (c: (typeof classes)[number]) => seatMap.get(c.id)?.reservedOpen ?? 0;
    const occupied = (c: (typeof classes)[number]) => confirmed(c).length + reservedOpen(c);
    const start = (c: (typeof classes)[number]) => iso(c.initialDate);
    const end = (c: (typeof classes)[number]) => iso(c.finalDate) ?? iso(c.initialDate);
    const confirmed = (c: (typeof classes)[number]) => c.subscriptions.filter((s) => s.subscribeStatus === 'confirmed');
    const seatsOf = (c: (typeof classes)[number]) => (c.unlimitedSubscriptions || !c.maxSubscriptions ? null : c.maxSubscriptions);
    const label = (c: (typeof classes)[number]) => c.course?.name ?? c.name;

    // turmas que ainda vão acontecer (ou estão acontecendo), ativas
    const upcoming = classes.filter((c) => c.active && start(c) && (end(c) ?? '') >= today && start(c)! <= plus(today, UPCOMING_DAYS));

    /* ---------------- o que pede ação ---------------- */
    const actions: ActionItem[] = [];
    for (const c of upcoming) {
      const when = brShort(start(c)!);
      const enrolled = occupied(c);
      if (c.minimumQuorum && enrolled < c.minimumQuorum && start(c)! >= today && start(c)! <= plus(today, QUORUM_DAYS)) {
        actions.push({ key: `quorum-${c.id}`, tone: 'danger', title: `${label(c)} · ${when} abaixo do quórum`, detail: `${enrolled} de ${c.minimumQuorum} (confirmados e vagas de empresa)`, count: c.minimumQuorum - enrolled, link: classLink(c.id, 'inscricoes') });
      }
      const pending = c.subscriptions.filter((s) => s.subscribeStatus === 'pending').length;
      if (pending) {
        actions.push({ key: `pending-${c.id}`, tone: 'warning', title: `${pending === 1 ? '1 inscrição' : `${pending} inscrições`} a confirmar`, detail: `${label(c)} · ${when}`, count: pending, link: classLink(c.id, 'inscricoes') });
      }
      // confirmado com cobrança em aberto e nenhuma paga
      const unpaid = confirmed(c).filter((s) => s.financialRecords.length > 0 && !s.financialRecords.some((f) => f.status === 'received') && s.financialRecords.some((f) => OPEN_RECEIVABLE.includes(f.status))).length;
      if (unpaid) {
        actions.push({ key: `unpaid-${c.id}`, tone: 'warning', title: `${unpaid === 1 ? '1 inscrito' : `${unpaid} inscritos`} sem pagamento`, detail: `${label(c)} · ${when}`, count: unpaid, link: classLink(c.id, 'inscricoes') });
      }
      // empresa comprou vagas e ainda não mandou os nomes
      if (reservedOpen(c) > 0 && start(c)! >= today && start(c)! <= plus(today, 3)) {
        const open = reservedOpen(c);
        actions.push({ key: `names-${c.id}`, tone: 'warning', title: `${open === 1 ? '1 vaga de empresa' : `${open} vagas de empresas`} sem nome`, detail: `${label(c)} · ${when}`, count: open, link: classLink(c.id, 'empresas') });
      }
      if (c.instructors.length === 0 && start(c)! <= plus(today, 30)) {
        actions.push({ key: `instructor-${c.id}`, tone: 'info', title: `${label(c)} · ${when} sem instrutor`, detail: 'defina quem vai dar a turma', count: 1, link: classLink(c.id, 'basico') });
      }
    }
    // turmas encerradas com alunos confirmados ainda sem certificado
    for (const c of classes) {
      const e = end(c);
      if (!e || e >= today || e < plus(today, -CERT_LOOKBACK)) continue;
      const missing = confirmed(c).length - c._count.certificates;
      if (missing > 0) {
        actions.push({ key: `certs-${c.id}`, tone: 'info', title: `${label(c)} terminou: emitir ${missing === 1 ? '1 certificado' : `${missing} certificados`}`, detail: `encerrada em ${brShort(e)}`, count: missing, link: classLink(c.id, 'inscricoes') });
      }
    }
    const rank: Record<Tone, number> = { danger: 0, warning: 1, info: 2 };
    // turma fechada sem venda nem "sem cobrança": a turma acontece e o financeiro não fica sabendo
    if (canSeeMoney || actor.permissions.includes('list_comercial')) {
      const billed = (await this.prisma.commercial_ClassBilling.findMany({ where: { companyId }, select: { classId: true } })).map((b) => b.classId);
      const unbilled = await this.prisma.courseClass.findMany({
        where: { companyId, inactiveAt: null, customerId: { not: null }, ...(billed.length ? { id: { notIn: billed } } : {}) },
        orderBy: [{ initialDate: 'asc' }, { id: 'asc' }], take: 20,
        select: { id: true, name: true, initialDate: true, customer: { select: { name: true } } },
      });
      for (const c of unbilled) {
        actions.push({ key: `nosale-${c.id}`, tone: 'danger', title: `${c.name}: turma fechada sem venda`, detail: `${c.customer?.name ?? 'cliente'}${c.initialDate ? ` · ${brShort(iso(c.initialDate)!)}` : ''} · ligue a uma venda ou marque "sem cobrança"`, count: 1, link: classLink(c.id, 'venda') });
      }
    }
    actions.sort((a, b) => rank[a.tone] - rank[b.tone] || b.count - a.count);

    /* ---------------- indicadores ---------------- */
    // alunos treinados: confirmados em turmas que terminaram no mês (até hoje)
    const trainedIn = (month: string) =>
      classes.filter((c) => c.active && end(c)?.slice(0, 7) === month && end(c)! <= today).reduce((sum, c) => sum + confirmed(c).length, 0);
    const trained = months.map(trainedIn);
    const enrolledIn = (month: string) => subscriptionsCreated.filter((s) => s.createdAt.toISOString().slice(0, 7) === month).length;

    const withSeats = upcoming.filter((c) => start(c)! >= today && seatsOf(c));
    const seats = withSeats.reduce((sum, c) => sum + seatsOf(c)!, 0);
    const taken = withSeats.reduce((sum, c) => sum + occupied(c), 0);

    const rating = reviews.length ? round2(reviews.reduce((sum, r) => sum + r.generalRating, 0) / reviews.length) : null;
    const approval = exams.length ? exams.filter((e) => e.result).length / exams.length : null;

    const revenue = canSeeMoney ? await this.revenue(companyId, months) : undefined;
    // vagas vendidas para empresas nas próximas turmas (a receita delas está nas vendas, não nas inscrições)
    const companySeats = await this.companySeats(companyId, upcoming.map((c) => c.id), canSeeMoney);

    /* ---------------- próximas turmas ---------------- */
    const next = upcoming.slice(0, 8).map((c) => ({
      id: c.id,
      name: label(c),
      date: start(c)!,
      endDate: end(c),
      ongoing: start(c)! < today,
      enrolled: confirmed(c).length,
      reserved: reservedOpen(c),
      companySeats: seatMap.get(c.id)?.reserved ?? 0,
      pending: c.subscriptions.filter((s) => s.subscribeStatus === 'pending').length,
      seats: seatsOf(c),
      quorum: c.minimumQuorum ?? null,
      instructors: c.instructors.length,
      link: classLink(c.id),
    }));

    return {
      today,
      actions: actions.slice(0, 10),
      actionsTotal: actions.length,
      kpis: {
        trained: { value: trained[trained.length - 1], previous: trained[trained.length - 2], trend: trained },
        occupancy: { ratio: seats ? taken / seats : null, taken, seats, classes: withSeats.length },
        companySeats,
        revenue,
        quality: { rating, reviews: reviews.length, approval, exams: exams.length, days: QUALITY_DAYS },
      },
      upcoming: next,
      renewals,
      trend: months.map((month, i) => ({ month, trained: trained[i], enrolled: enrolledIn(month) })),
      links: { classes: '/treinamentos/turmas', certificates: '/treinamentos/certificados', reviews: '/treinamentos/cursos', newClass: '/treinamentos/turmas/nova' },
      generatedAt: new Date().toISOString(),
    };
  }

  /** Recebido de inscrições por mês (pela data do pagamento) e o que está em aberto. */
  /** Vagas reservadas para empresas nas turmas dadas: quantas, de quantas empresas e o valor combinado. */
  private async companySeats(companyId: number, classIds: number[], canSeeMoney: boolean) {
    if (!classIds.length) return { seats: 0, customers: 0, value: canSeeMoney ? 0 : undefined };
    const rows = await this.prisma.courseClassReservation.findMany({
      where: { companyId, classId: { in: classIds }, inactiveAt: null },
      select: { seats: true, customerId: true, unitValue: true },
    });
    return {
      seats: rows.reduce((n, r) => n + r.seats, 0),
      customers: new Set(rows.map((r) => r.customerId)).size,
      value: canSeeMoney ? round2(rows.reduce((n, r) => n + r.seats * Number(r.unitValue ?? 0), 0)) : undefined,
    };
  }

  private async revenue(companyId: number, months: string[]) {
    const since = asDate(`${months[0]}-01`);
    const [paid, open] = await Promise.all([
      this.prisma.financialRecords.findMany({
        where: { companyId, subscriptionId: { not: null }, status: 'received', paidAt: { gte: since } },
        select: { paidAt: true, value: true, receivedValue: true },
      }),
      this.prisma.financialRecords.aggregate({
        where: { companyId, subscriptionId: { not: null }, status: { in: OPEN_RECEIVABLE } },
        _sum: { value: true },
        _count: true,
      }),
    ]);
    const byMonth = months.map((month) =>
      round2(paid.filter((p) => p.paidAt!.toISOString().slice(0, 7) === month).reduce((sum, p) => sum + Number(p.receivedValue ?? p.value ?? 0), 0)),
    );
    return {
      month: byMonth[byMonth.length - 1],
      previous: byMonth[byMonth.length - 2],
      trend: byMonth,
      open: round2(Number(open._sum.value ?? 0)),
      openCount: open._count,
      link: '/financeiro/receber',
    };
  }

  /**
   * Certificados que vencem nos próximos 90 dias, de quem ainda não voltou:
   * sai da lista quem já tem certificado mais novo do mesmo curso ou está
   * inscrito numa turma futura dele.
   */
  private async renewals(companyId: number, today: string) {
    const certificates = await this.prisma.traineeCourseCertificate.findMany({
      where: { companyId, inactiveAt: null, expirationDate: { gte: asDate(today), lte: asDate(plus(today, RENEWAL_DAYS)) } },
      orderBy: { expirationDate: 'asc' },
      take: 500,
      select: {
        id: true, key: true, traineeId: true, courseId: true, expirationDate: true, createdAt: true,
        course: { select: { name: true } },
        trainee: { select: { name: true, phone: true, email: true } },
      },
    });
    if (certificates.length === 0) return { total: 0, days: RENEWAL_DAYS, byCourse: [], items: [] };

    const traineeIds = [...new Set(certificates.map((c) => c.traineeId))];
    const courseIds = [...new Set(certificates.map((c) => c.courseId))];
    const [newer, enrolled] = await Promise.all([
      this.prisma.traineeCourseCertificate.findMany({
        where: { companyId, inactiveAt: null, traineeId: { in: traineeIds }, courseId: { in: courseIds } },
        select: { traineeId: true, courseId: true, createdAt: true },
      }),
      this.prisma.courseClassSubscription.findMany({
        where: {
          inactiveAt: null, traineeId: { in: traineeIds }, subscribeStatus: { in: ['pending', 'confirmed'] },
          class: { companyId, inactiveAt: null, courseId: { in: courseIds }, initialDate: { gte: asDate(today) } },
        },
        select: { traineeId: true, class: { select: { courseId: true } } },
      }),
    ]);
    const pair = (t: number | null, c: number | null) => `${t}:${c}`;
    const back = new Set(enrolled.map((s) => pair(s.traineeId, s.class?.courseId ?? null)));
    const pending = certificates.filter(
      (cert) =>
        !back.has(pair(cert.traineeId, cert.courseId)) &&
        !newer.some((n) => n.traineeId === cert.traineeId && n.courseId === cert.courseId && n.createdAt > cert.createdAt),
    );

    const courses = new Map<number, { courseId: number; name: string; count: number }>();
    for (const cert of pending) {
      const row = courses.get(cert.courseId) ?? { courseId: cert.courseId, name: cert.course?.name ?? 'Curso', count: 0 };
      row.count += 1;
      courses.set(cert.courseId, row);
    }
    return {
      total: pending.length,
      days: RENEWAL_DAYS,
      byCourse: [...courses.values()].sort((a, b) => b.count - a.count),
      items: pending.slice(0, 200).map((cert) => ({
        id: cert.id,
        trainee: cert.trainee?.name ?? '—',
        phone: cert.trainee?.phone ?? null,
        email: cert.trainee?.email ?? null,
        courseId: cert.courseId,
        course: cert.course?.name ?? 'Curso',
        expiresAt: iso(cert.expirationDate)!,
        certificateKey: cert.key,
      })),
    };
  }
}
