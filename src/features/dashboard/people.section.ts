import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { allocationWindow, overlaps } from 'src/features/hr/allocation';
import { DOCUMENTS_VIEW_PERMISSION, EmployeeDocumentService } from 'src/features/hr/document.service';
import { DashboardActor, asDate } from './shared';

/**
 * Equipe e turmas do resumo. Equipe: onde cada funcionário ativo está hoje
 * (obra, turma, atividade, ausente ou livre), pela mesma regra do mapa de
 * alocação, e os documentos vencidos e a vencer. Turmas: as próximas, com vagas.
 */
@Injectable()
export class PeopleSection {
  constructor(private readonly prisma: PrismaService, private readonly documents: EmployeeDocumentService) {}

  async team(actor: DashboardActor, today: string) {
    const employees = await this.prisma.hr_Employee.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, OR: [{ terminationDate: null }, { terminationDate: { gt: asDate(today) } }] },
      select: { id: true },
      take: 2000,
    });
    const active = new Set(employees.map((e) => e.id));
    const window = await allocationWindow(this.prisma, actor.companyId, today, today, today);
    const inField = new Set(window.spans.filter((s) => active.has(s.employeeId) && s.start && overlaps(s.start, s.end, today, today)).map((s) => s.employeeId));
    const inClass = new Set(window.classes.filter((s) => active.has(s.employeeId) && !inField.has(s.employeeId)).map((s) => s.employeeId));
    const atBase = new Set(window.activities.filter((s) => s.occupies && active.has(s.employeeId) && !inField.has(s.employeeId) && !inClass.has(s.employeeId)).map((s) => s.employeeId));
    const busy = new Set([...inField, ...inClass, ...atBase]);
    const away = new Set(window.unavailable.filter((s) => active.has(s.employeeId) && !busy.has(s.employeeId) && overlaps(s.start, s.end, today, today)).map((s) => s.employeeId));

    let docsExpired: number | null = null;
    let docsExpiring: number | null = null;
    if (actor.permissions.includes(DOCUMENTS_VIEW_PERMISSION)) {
      const { summary } = await this.documents.expiring({ userId: actor.userId, companyId: actor.companyId }, {});
      docsExpired = summary.vencido + summary.faltando;
      docsExpiring = summary.a_vencer;
    }
    return {
      total: active.size,
      inField: inField.size,
      inClass: inClass.size,
      atBase: atBase.size,
      away: away.size,
      free: active.size - busy.size - away.size,
      docsExpired,
      docsExpiring,
      link: '/rh/mapa-de-alocacao',
      docsLink: '/rh/vencimentos',
    };
  }

  async training(actor: DashboardActor, today: string) {
    const classes = await this.prisma.courseClass.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, active: true, initialDate: { gte: asDate(today) } },
      orderBy: [{ initialDate: 'asc' }, { id: 'asc' }],
      take: 5,
      select: {
        id: true, name: true, initialDate: true, maxSubscriptions: true, unlimitedSubscriptions: true,
        course: { select: { name: true } },
        _count: { select: { subscriptions: { where: { subscribeStatus: 'confirmed', inactiveAt: null } } } },
      },
    });
    return {
      classes: classes.map((c) => ({
        id: c.id,
        name: c.course?.name ?? c.name,
        date: c.initialDate!.toISOString().slice(0, 10),
        enrolled: c._count.subscriptions,
        seats: c.unlimitedSubscriptions || !c.maxSubscriptions ? null : c.maxSubscriptions,
        link: `/treinamentos/turmas/${c.id}`,
      })),
      link: '/treinamentos/turmas',
    };
  }
}
