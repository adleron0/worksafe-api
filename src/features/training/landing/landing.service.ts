import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  BOT_UA,
  LANDING_EVENTS,
  LANDING_LAYOUTS,
  LandingLayout,
  isLayout,
  layoutList,
  shortText,
  visitorOrNull,
} from './landing.rules';

const BLOCK = /^[a-z0-9_-]{1,30}$/;
const MAX_EVENTS = 25;
/** Abaixo disso o painel avisa que ainda não dá para concluir. */
export const MIN_VISITORS = 100;
export const MIN_SUBMITS = 5;

interface EventInput { event?: unknown; block?: unknown }
interface EventsBody {
  classId?: unknown;
  visitorId?: unknown;
  layout?: unknown;
  source?: unknown;
  medium?: unknown;
  campaign?: unknown;
  device?: unknown;
  events?: unknown;
}

type Count = { layout: string; n: number };

/**
 * Página de inscrição da turma: grava os eventos de cada visitante (por
 * layout) e calcula o resultado do teste A/B. Não toca em inscrição,
 * pagamento ou confirmação; a inscrição só guarda de qual layout veio.
 */
@Injectable()
export class LandingService {
  constructor(private readonly prisma: PrismaService) {}

  async record(body: EventsBody, userAgent: string | undefined) {
    if (userAgent && BOT_UA.test(userAgent)) return { recorded: 0, ignored: 'bot' };
    const classId = Number(body?.classId);
    const visitorId = visitorOrNull(body?.visitorId);
    if (!Number.isInteger(classId) || classId <= 0 || !visitorId || !isLayout(body?.layout)) {
      throw new BadRequestException('Evento inválido');
    }
    const list = Array.isArray(body.events) ? (body.events as EventInput[]).slice(0, MAX_EVENTS) : [];
    const events = list
      .filter((e) => (LANDING_EVENTS as readonly string[]).includes(String(e?.event)))
      .map((e) => ({ event: String(e.event), block: typeof e.block === 'string' && BLOCK.test(e.block) ? e.block : null }))
      .filter((e) => e.event !== 'block' || e.block);
    if (!events.length) return { recorded: 0 };

    // só turmas que estão na vitrine recebem eventos
    const turma = await this.prisma.courseClass.findFirst({
      where: { id: classId, inactiveAt: null, openClass: true },
      select: { companyId: true },
    });
    if (!turma) throw new NotFoundException('Turma não encontrada');

    const device = body.device === 'mobile' || body.device === 'desktop' ? body.device : null;
    const base = {
      companyId: turma.companyId,
      classId,
      visitorId,
      layout: body.layout as string,
      source: shortText(body.source, 120),
      medium: shortText(body.medium, 120),
      campaign: shortText(body.campaign, 120),
      device,
    };
    const { count } = await this.prisma.courseClass_LandingEvent.createMany({
      data: events.map((e) => ({ ...base, event: e.event, block: e.block })),
    });
    return { recorded: count };
  }

  /** Resultado do teste por layout, para o painel da turma. */
  async results(classId: number, companyId: number) {
    const turma = await this.prisma.courseClass.findFirst({
      where: { id: classId, companyId },
      select: { id: true, name: true, landingLayout: true, landingAbTest: true, landingAbLayouts: true },
    });
    if (!turma) throw new NotFoundException('Turma não encontrada');

    const funnelRows = await this.prisma.$queryRaw<{ layout: string; event: string; n: number }[]>(Prisma.sql`
      SELECT "layout", "event", COUNT(DISTINCT "visitorId")::int AS n
      FROM "CourseClass_LandingEvent" WHERE "classId" = ${classId}
      GROUP BY "layout", "event"`);
    const blockRows = await this.prisma.$queryRaw<{ layout: string; block: string; n: number }[]>(Prisma.sql`
      SELECT "layout", "block", COUNT(DISTINCT "visitorId")::int AS n
      FROM "CourseClass_LandingEvent" WHERE "classId" = ${classId} AND "event" = 'block'
      GROUP BY "layout", "block"`);
    // origem e aparelho de quem visitou e de quem enviou o formulário
    const segRows = await this.prisma.$queryRaw<{ layout: string; source: string; device: string; event: string; n: number }[]>(Prisma.sql`
      SELECT "layout", COALESCE(NULLIF("source", ''), 'direto') AS source, COALESCE("device", '?') AS device, "event",
             COUNT(DISTINCT "visitorId")::int AS n
      FROM "CourseClass_LandingEvent" WHERE "classId" = ${classId} AND "event" IN ('view', 'submit')
      GROUP BY 1, 2, 3, 4`);
    const subs = await this.prisma.courseClassSubscription.groupBy({
      by: ['landingLayout', 'subscribeStatus'],
      where: { classId, landingLayout: { not: null } },
      _count: { _all: true },
    });

    const seen = new Set<string>([
      ...funnelRows.map((r) => r.layout),
      ...subs.map((s) => s.landingLayout as string),
      ...layoutList(turma.landingAbLayouts),
    ]);
    if (!seen.size) seen.add(turma.landingLayout || 'classico');
    const layouts = LANDING_LAYOUTS.filter((l) => seen.has(l));

    const get = (layout: string, event: string) => funnelRows.find((r) => r.layout === layout && r.event === event)?.n ?? 0;
    const rows = layouts.map((layout) => {
      const visitors = get(layout, 'view');
      const submits = get(layout, 'submit');
      const subOf = (status?: string) =>
        subs.filter((s) => s.landingLayout === layout && (!status || s.subscribeStatus === status)).reduce((sum, s) => sum + s._count._all, 0);
      return {
        layout,
        visitors,
        ctaClicks: get(layout, 'cta_click'),
        formStarts: get(layout, 'form_start'),
        submits,
        whatsappClicks: get(layout, 'whatsapp_click'),
        subscriptions: subOf(),
        confirmed: subOf('confirmed'),
        conversion: visitors ? submits / visitors : null,
        enoughData: visitors >= MIN_VISITORS && submits >= MIN_SUBMITS,
        blocks: blockRows.filter((b) => b.layout === layout).map((b) => ({ block: b.block, visitors: b.n, share: visitors ? b.n / visitors : null })),
      };
    });

    const chance = chanceToBeBest(rows.map((r) => ({ layout: r.layout, visitors: r.visitors, submits: r.submits })));
    const segments = (key: 'source' | 'device') => {
      const groups = new Map<string, { key: string; layout: string; visitors: number; submits: number }>();
      for (const r of segRows) {
        const id = `${r.layout}|${r[key]}`;
        const g = groups.get(id) ?? { key: r[key], layout: r.layout, visitors: 0, submits: 0 };
        if (r.event === 'view') g.visitors += r.n;
        else g.submits += r.n;
        groups.set(id, g);
      }
      return [...groups.values()].sort((a, b) => b.visitors - a.visitors);
    };

    return {
      classId: turma.id,
      name: turma.name,
      config: { layout: turma.landingLayout || 'classico', abTest: turma.landingAbTest, abLayouts: layoutList(turma.landingAbLayouts) },
      minimum: { visitors: MIN_VISITORS, submits: MIN_SUBMITS },
      layouts: rows.map((r) => ({ ...r, chanceToBeBest: chance[r.layout] ?? null })),
      bySource: segments('source'),
      byDevice: segments('device'),
    };
  }

  /** Visão geral: qual layout converte mais somando todas as turmas (últimos 180 dias). */
  async summary(companyId: number) {
    const since = new Date(Date.now() - 180 * 86400000);
    const rows = await this.prisma.$queryRaw<{ layout: string; event: string; n: number }[]>(Prisma.sql`
      SELECT "layout", "event", COUNT(DISTINCT ("classId", "visitorId"))::int AS n
      FROM "CourseClass_LandingEvent"
      WHERE "companyId" = ${companyId} AND "createdAt" >= ${since} AND "event" IN ('view', 'submit')
      GROUP BY "layout", "event"`);
    const classes = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT "classId")::int AS n FROM "CourseClass_LandingEvent"
      WHERE "companyId" = ${companyId} AND "createdAt" >= ${since}`);
    const layouts = LANDING_LAYOUTS.map((layout) => {
      const visitors = rows.find((r) => r.layout === layout && r.event === 'view')?.n ?? 0;
      const submits = rows.find((r) => r.layout === layout && r.event === 'submit')?.n ?? 0;
      return { layout, visitors, submits, conversion: visitors ? submits / visitors : null };
    }).filter((r) => r.visitors > 0);
    const chance = chanceToBeBest(layouts);
    return { since: since.toISOString().slice(0, 10), classes: classes[0]?.n ?? 0, layouts: layouts.map((l) => ({ ...l, chanceToBeBest: chance[l.layout] ?? null })) };
  }
}

/* ------------------------------------------------------------------ estatística */

/**
 * Chance de cada layout ter a maior taxa de conversão: cada taxa vira uma
 * distribuição Beta(1 + inscrições, 1 + visitas sem inscrição) e sorteamos
 * muitas vezes quem fica na frente. Semente fixa para o número não mudar a
 * cada recarga com os mesmos dados.
 */
export function chanceToBeBest(rows: { layout: string; visitors: number; submits: number }[], draws = 20000): Record<string, number> {
  const valid = rows.filter((r) => r.visitors > 0);
  if (valid.length < 2) return valid.length === 1 ? { [valid[0].layout]: 1 } : {};
  const rand = mulberry32(12345);
  const wins: Record<string, number> = Object.fromEntries(valid.map((r) => [r.layout, 0]));
  for (let i = 0; i < draws; i++) {
    let best = -1;
    let bestLayout = '';
    for (const r of valid) {
      const failures = Math.max(0, r.visitors - r.submits);
      const value = betaSample(1 + r.submits, 1 + failures, rand);
      if (value > best) { best = value; bestLayout = r.layout; }
    }
    wins[bestLayout]++;
  }
  return Object.fromEntries(Object.entries(wins).map(([k, v]) => [k, v / draws]));
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Gamma(shape, 1) por Marsaglia-Tsang. */
function gammaSample(shape: number, rand: () => number): number {
  if (shape < 1) return gammaSample(shape + 1, rand) * Math.pow(rand() || 1e-12, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do { x = normal(rand); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function betaSample(a: number, b: number, rand: () => number) {
  const x = gammaSample(a, rand);
  const y = gammaSample(b, rand);
  return x / (x + y);
}

export type { LandingLayout };
