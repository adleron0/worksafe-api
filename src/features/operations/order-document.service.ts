import { randomUUID } from 'crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Service_DailyReport, Service_Order } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { DEFAULT_COLOR, safeImageUrl, validColor } from 'src/features/commercial/document.blocks';
import { DailyReportService, Occurrence, Photo, StepProgress } from './daily-report.service';
import { OrderActor, SERVICE_ORDER_FLOW, TeamMember, ordersVisibleTo } from './service-order.service';
import { Schedule, addDays, daysBetween, donePercent, plannedPercent, projectEnd, scheduleEnd, stepDates } from './order-schedule';

/**
 * A OS como documento: a folha que a equipe recebe (na tela e no papel), a
 * mesma folha aberta para o cliente acompanhar e a linha do tempo da obra
 * (cronograma × RDO).
 *
 * Valores de venda só saem com `view_valores_os`, lidos da proposta na hora
 * (o escopo da OS é gravado sem preço de propósito).
 */
type Body = Record<string, any>;
/** Ver o valor de venda na OS e imprimir "com valores". */
export const VALUES_PERMISSION = 'view_valores_os';
/** Depois de encerrada, o link do cliente ainda abre por estes dias. */
export const PUBLIC_DAYS_AFTER_CLOSE = 30;

export interface PublicOptions { reports: boolean; photos: boolean; occurrences: boolean; teamNames: boolean }
const DEFAULT_PUBLIC: PublicOptions = { reports: true, photos: true, occurrences: false, teamNames: false };
const optionsOf = (value: unknown): PublicOptions => ({ ...DEFAULT_PUBLIC, ...Object.fromEntries(Object.entries((value ?? {}) as Body).filter(([key, v]) => key in DEFAULT_PUBLIC && typeof v === 'boolean')) });

const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
export interface ScopeItem { type: string; description: string; unit: string | null; quantity: number; workDays: number | null; hoursPerDay: number | null; overtimeHours: number; night: boolean; weekend: boolean; travel: boolean }
export interface ScopeSection { title: string; kind: string; items: ScopeItem[] }
export interface ChecklistShape { title: string; done: boolean }
const SHIFT_LABEL: Record<string, string> = { manha: 'manhã', tarde: 'tarde', noite: 'noite' };

@Injectable()
export class OrderDocumentService {
  constructor(private readonly prisma: PrismaService, private readonly reports: DailyReportService) {}

  private async orderOf(actor: OrderActor, id: number): Promise<Service_Order> {
    const row = await this.prisma.service_Order.findFirst({ where: { id, companyId: actor.companyId, AND: [await ordersVisibleTo(this.prisma, actor)] } });
    if (!row) throw new NotFoundException('Ordem de serviço não encontrada');
    return row;
  }

  // ------------------------------------------------------------------ cabeçalho da empresa

  private async companyOf(companyId: number) {
    const [company, settings] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: {
        comercial_name: true, corporate_name: true, cnpj: true, logoUrl: true, primary_color: true, representative_contact: true, representative_email: true,
        address: true, addressNumber: true, neighborhood: true, system_domain: true,
      } }),
      this.prisma.commercial_Settings.findUnique({ where: { companyId } }),
    ]);
    const brand = (settings?.brand ?? {}) as Body;
    const domain = String(company?.system_domain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return {
      name: company?.comercial_name ?? '', corporateName: company?.corporate_name ?? '', cnpj: company?.cnpj ?? '',
      logoUrl: safeImageUrl(brand.logoUrl) ?? safeImageUrl(company?.logoUrl), color: validColor(brand.color ?? company?.primary_color ?? DEFAULT_COLOR),
      phone: brand.phone || company?.representative_contact || '', email: brand.email || company?.representative_email || '',
      address: brand.address || [company?.address, company?.addressNumber, company?.neighborhood].filter(Boolean).join(', '),
      registrations: brand.registrations || '', domain: domain || null,
    };
  }

  // ------------------------------------------------------------------ valores da venda

  /**
   * Valores dos itens, na mesma ordem e com o mesmo filtro do escopo da OS
   * (seções sem treinamento), para a tela casar linha a linha.
   */
  private async valuesOf(row: Service_Order) {
    const proposal = await this.prisma.commercial_Proposal.findUnique({
      where: { id: row.proposalId },
      select: { total: true, discount: true, dealDiscount: true, sections: { orderBy: [{ order: 'asc' }, { id: 'asc' }], select: { title: true, items: { orderBy: [{ order: 'asc' }, { id: 'asc' }], select: { type: true, quantity: true, value: true } } } } },
    });
    if (!proposal) return null;
    const sections = proposal.sections
      .map((section) => {
        const items = section.items.filter((item) => item.type !== 'treinamento').map((item) => {
          const value = Number(item.value);
          const quantity = Number(item.quantity) || 1;
          return { value: round2(value), unitValue: round2(value / quantity) };
        });
        return { title: section.title, items, total: round2(items.reduce((sum, item) => sum + item.value, 0)) };
      })
      .filter((section) => section.items.length > 0);
    const subtotal = round2(sections.reduce((sum, section) => sum + section.total, 0));
    return { sections, subtotal, discount: round2(Number(proposal.discount) + Number(proposal.dealDiscount ?? 0)), total: round2(Number(proposal.total)) };
  }

  // ------------------------------------------------------------------ a folha

  private lastProgress(reports: Service_DailyReport[]) {
    const last = new Map<number, number>();
    for (const report of reports) for (const item of (report.progress as unknown as StepProgress[]) ?? []) last.set(item.step, item.percent);
    return last;
  }

  /** O conteúdo da folha da OS. `audience` decide o que entra: equipe (sistema) ou cliente (link aberto). */
  private async sheet(row: Service_Order, audience: 'equipe' | 'cliente', options: PublicOptions = DEFAULT_PUBLIC) {
    const [company, customer, contract, responsible, reports] = await Promise.all([
      this.companyOf(row.companyId),
      this.prisma.customer.findUnique({ where: { id: row.customerId }, select: { name: true, corporateName: true, cnpj: true } }),
      this.prisma.commercial_Contract.findUnique({ where: { id: row.contractId }, select: { customerOrderNumber: true, customerOrderDate: true } }),
      row.responsibleUserId ? this.prisma.user.findUnique({ where: { id: row.responsibleUserId }, select: { name: true, phone: true } }) : null,
      this.prisma.service_DailyReport.findMany({ where: { orderId: row.id, inactiveAt: null, ...(audience === 'cliente' ? { status: 'fechado' } : {}) }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    ]);
    const schedule = row.schedule as Schedule | null;
    const start = iso(row.startedAt) ?? iso(row.plannedStart);
    const last = this.lastProgress(reports);
    const running = ['em_execucao', 'concluida', 'encerrada'].includes(row.status);
    const steps = stepDates(schedule, start).map((step) => ({ ...step, percent: running ? last.get(step.step) ?? 0 : null }));
    const done = running ? donePercent(schedule, last) : null;
    const planned = running && iso(row.startedAt) ? plannedPercent(schedule, iso(row.startedAt)!, iso(row.finishedAt) ?? today()) : null;
    const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';
    const team = ((row.team as unknown as TeamMember[]) ?? []).map((member) => ({
      name: audience === 'equipe' ? member.name : options.teamNames ? firstName(member.name) : null,
      role: member.role, from: member.from ?? null, to: member.to ?? null, shift: member.shift ? SHIFT_LABEL[member.shift] ?? null : null,
    }));
    return {
      company: { name: company.name, corporateName: company.corporateName, cnpj: company.cnpj, logoUrl: company.logoUrl, color: company.color, phone: company.phone, email: company.email, address: company.address, registrations: company.registrations },
      order: {
        id: row.id, number: row.number, status: row.status, statusLabel: SERVICE_ORDER_FLOW.labels[row.status], title: row.title, description: row.description,
        location: row.location, latitude: row.latitude, longitude: row.longitude,
        plannedStart: iso(row.plannedStart), plannedEnd: iso(row.plannedEnd), startedAt: iso(row.startedAt), finishedAt: iso(row.finishedAt),
        contactName: row.contactName, contactPhone: row.contactPhone, safety: row.safety,
        // observações da operação são internas
        notes: audience === 'equipe' ? row.notes : null, conclusionNotes: row.conclusionNotes,
      },
      customer: customer ? { name: customer.name, corporateName: customer.corporateName, cnpj: customer.cnpj } : null,
      customerOrder: contract?.customerOrderNumber ? { number: contract.customerOrderNumber, date: iso(contract.customerOrderDate) } : null,
      responsible: responsible ? { name: responsible.name, phone: audience === 'equipe' ? responsible.phone ?? null : null } : null,
      schedule: steps.length ? { unit: schedule?.unit ?? 'dia', start, end: scheduleEnd(schedule, start), steps, replanned: !!row.baseline } : null,
      scope: (row.scope as unknown as ScopeSection[]) ?? [],
      team,
      checklist: ((row.checklist as unknown as ChecklistShape[]) ?? []).map((item) => ({ title: item.title, done: item.done })),
      progress: done === null ? null : { done, planned, lastReport: reports.length ? iso(reports[reports.length - 1].date) : null },
      reports,
    };
  }

  /** A folha da OS no sistema. `values` só com a permissão. */
  async document(actor: OrderActor, id: number, query: Record<string, string>) {
    const row = await this.orderOf(actor, id);
    const withValues = query.values === '1' || query.values === 'true';
    if (withValues && !actor.canSeeValues) throw new ForbiddenException('Você não tem permissão para ver os valores da OS');
    const { reports, ...sheet } = await this.sheet(row, 'equipe');
    void reports;
    const [me, company] = await Promise.all([
      actor.userId ? this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }) : null,
      this.companyOf(row.companyId),
    ]);
    return {
      ...sheet, withValues, canSeeValues: actor.canSeeValues,
      values: withValues ? await this.valuesOf(row) : null,
      issuedAt: new Date().toISOString(), issuedBy: me?.name ?? null,
      systemUrl: company.domain ? `https://${company.domain}/servicos/ordens-de-servico/${row.id}` : null,
      publicUrl: row.publicEnabled && row.publicKey && company.domain ? `https://${company.domain}/acompanhar/${row.publicKey}` : null,
    };
  }

  // ------------------------------------------------------------------ link do cliente

  private async publicState(row: Pick<Service_Order, 'companyId' | 'publicEnabled' | 'publicKey' | 'publicOptions'>) {
    const company = await this.companyOf(row.companyId);
    return {
      enabled: row.publicEnabled, key: row.publicKey, options: optionsOf(row.publicOptions),
      url: row.publicKey && company.domain ? `https://${company.domain}/acompanhar/${row.publicKey}` : null, path: row.publicKey ? `/acompanhar/${row.publicKey}` : null,
      daysAfterClose: PUBLIC_DAYS_AFTER_CLOSE,
    };
  }

  async publicSettings(actor: OrderActor, id: number) {
    return this.publicState(await this.orderOf(actor, id));
  }

  /** Liga/desliga o link e escolhe o que ele mostra. Ligar pela primeira vez cria a chave. */
  async updatePublic(actor: OrderActor, id: number, body: Body) {
    const row = await this.orderOf(actor, id);
    const data: Prisma.Service_OrderUncheckedUpdateInput = {};
    if ('enabled' in body) {
      data.publicEnabled = body.enabled === true;
      if (body.enabled === true && !row.publicKey) data.publicKey = randomUUID();
    }
    if ('options' in body) data.publicOptions = optionsOf({ ...optionsOf(row.publicOptions), ...(body.options ?? {}) }) as unknown as Prisma.InputJsonValue;
    const saved = await this.prisma.service_Order.update({ where: { id }, data });
    return this.publicState(saved);
  }

  /** Troca a chave: o link antigo para de abrir na hora. */
  async renewPublic(actor: OrderActor, id: number) {
    await this.orderOf(actor, id);
    const saved = await this.prisma.service_Order.update({ where: { id }, data: { publicKey: randomUUID() } });
    return this.publicState(saved);
  }

  /** A página do cliente: a folha sem valores e sem nada interno, mais o diário (só RDOs fechados). */
  async publicView(key: string) {
    const row = /^[0-9a-f-]{36}$/i.test(key) ? await this.prisma.service_Order.findFirst({ where: { publicKey: key, publicEnabled: true, inactiveAt: null } }) : null;
    const expired = row && (row.status === 'cancelada' || (row.status === 'encerrada' && row.closedAt && Date.now() - row.closedAt.getTime() > PUBLIC_DAYS_AFTER_CLOSE * 86400000));
    if (!row || expired) throw new NotFoundException('Acompanhamento não encontrado ou encerrado');
    const options = optionsOf(row.publicOptions);
    const { reports, ...sheet } = await this.sheet(row, 'cliente', options);
    const timeline = this.timelineOf(row, reports);
    return {
      ...sheet, options,
      timeline: { start: timeline.start, today: timeline.today, days: timeline.days, curve: timeline.curve, projection: timeline.projection, end: timeline.end, done: timeline.done },
      reports: options.reports ? [...reports].reverse().slice(0, 120).map((report) => ({
        date: iso(report.date), shift: report.shift, weather: report.weather, weatherEnd: report.weatherEnd,
        activities: report.activities, people: ((report.crew as unknown[]) ?? []).length,
        progress: ((report.progress as unknown as StepProgress[]) ?? []).filter((item) => item.percent > 0).map((item) => ({ title: item.title, percent: item.percent })),
        photos: options.photos ? ((report.photos as unknown as Photo[]) ?? []).map((photo) => ({ url: photo.url, caption: photo.caption })) : [],
        occurrences: options.occurrences ? ((report.occurrences as unknown as Occurrence[]) ?? []).map((item) => ({ type: item.type, description: item.description })) : [],
      })) : [],
    };
  }

  // ------------------------------------------------------------------ cronograma × RDO

  /**
   * Dias da obra (com e sem RDO), curva previsto × feito e projeção de término.
   * Recebe os RDOs já lidos para servir à tela interna (todos) e à do cliente (só fechados).
   */
  private timelineOf(row: Service_Order, reports: Service_DailyReport[]) {
    const schedule = row.schedule as Schedule | null;
    const started = iso(row.startedAt);
    const start = started ?? iso(row.plannedStart);
    const now = today();
    const end = scheduleEnd(schedule, start) ?? iso(row.plannedEnd);
    const until = iso(row.finishedAt) ?? (started ? now : null);
    const byDate = new Map<string, Service_DailyReport[]>();
    for (const report of reports) byDate.set(iso(report.date)!, [...(byDate.get(iso(report.date)!) ?? []), report]);

    // dias: do início até o maior entre hoje (ou o fim real) e o fim do cronograma
    const days: Array<{ date: string; state: string; weekend: boolean; reports: Array<{ id: number; status: string; returned: boolean }>; weather: string | null }> = [];
    const last = until && end ? (until > end ? until : end) : until ?? end;
    if (start && last && daysBetween(start, last) <= 1000) {
      for (let date = start; date <= last; date = addDays(date, 1)) {
        const list = byDate.get(date) ?? [];
        const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
        const stopped = list.some((report) => report.weather === 'impraticavel' || report.startCondition === 'impedido' || ((report.occurrences as unknown as Occurrence[]) ?? []).some((item) => item.type === 'paralisacao'));
        const state = !started || date > (until ?? now) ? 'futuro'
          : list.length === 0 ? 'sem_rdo'
            : stopped ? 'parado'
              : list.some((report) => report.returnedAt && report.status !== 'fechado') ? 'devolvido'
                : list.some((report) => report.status !== 'fechado') ? 'rascunho' : 'fechado';
        days.push({ date, state, weekend: weekday === 0 || weekday === 6, reports: list.map((report) => ({ id: report.id, status: report.status, returned: !!report.returnedAt && report.status !== 'fechado' })), weather: list[0]?.weather ?? null });
      }
    }

    // curva: previsto e feito acumulado dia a dia, até hoje (ou o fim real)
    const curve: Array<{ date: string; planned: number | null; done: number | null }> = [];
    const progress = new Map<number, number>();
    let done: number | null = null;
    if (started && start) {
      const stop = last ?? now;
      for (let date = start; date <= stop; date = addDays(date, 1)) {
        for (const report of byDate.get(date) ?? []) for (const item of (report.progress as unknown as StepProgress[]) ?? []) progress.set(item.step, item.percent);
        const reached = until && date <= until;
        if (reached) done = donePercent(schedule, progress);
        curve.push({ date, planned: plannedPercent(schedule, started, date), done: reached ? done : null });
      }
    }
    return { start, end, today: now, days, curve, projection: projectEnd(started, done, until, end), done };
  }

  async timeline(actor: OrderActor, id: number) {
    const row = await this.orderOf(actor, id);
    const reports = await this.prisma.service_DailyReport.findMany({ where: { orderId: row.id, inactiveAt: null }, orderBy: [{ date: 'asc' }, { id: 'asc' }] });
    const timeline = this.timelineOf(row, reports);
    const schedule = row.schedule as Schedule | null;
    const baseline = row.baseline as Schedule | null;
    const baseDates = baseline ? stepDates(baseline, timeline.start) : [];
    const lastByStep = this.lastProgress(reports);
    const summary = await this.reports.summaryOf(row, actor.canSeeCosts);
    return {
      ...timeline,
      unit: schedule?.unit ?? 'dia',
      steps: stepDates(schedule, timeline.start).map((step) => {
        const base = baseDates.find((item) => item.title === step.title) ?? baseDates[step.step] ?? null;
        const planned = iso(row.startedAt) && step.from ? Math.round(((plannedPercent({ unit: schedule?.unit, steps: [step] }, iso(row.startedAt)!, iso(row.finishedAt) ?? timeline.today) ?? 0)) * 100) / 100 : null;
        return { ...step, percent: lastByStep.get(step.step) ?? 0, plannedPercent: planned, baseline: base ? { from: base.from, to: base.to, start: base.start, duration: base.duration } : null };
      }),
      replanned: !!baseline,
      summary,
    };
  }
}
