import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { HELP_EVENTS, HelpActor, isLessonId } from './help.rules';

type IncomingEvent = {
  event?: unknown;
  tourId?: unknown;
  step?: unknown;
  target?: unknown;
  route?: unknown;
};
const MAX_EVENTS = 50;

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/**
 * Central de ajuda. Guarda os tutoriais que cada pessoa já assistiu até o fim (vale em
 * qualquer aparelho) e registra o uso — onde as pessoas começam, erram e param.
 */
@Injectable()
export class HelpService {
  constructor(private readonly prisma: PrismaService) {}

  /** Tudo o que a pessoa já concluiu ou dispensou, por id do tour. */
  async state(actor: HelpActor) {
    const rows = await this.prisma.help_State.findMany({
      where: { userId: actor.userId, companyId: actor.companyId },
      select: { tourId: true, completedAt: true, dismissedAt: true },
    });
    return {
      tours: Object.fromEntries(
        rows.map((row) => [
          row.tourId,
          { completedAt: row.completedAt, dismissedAt: row.dismissedAt },
        ]),
      ),
    };
  }

  /** Concluir, dispensar ou zerar um tutorial. Refazer não apaga a conclusão. */
  async setState(actor: HelpActor, tourId: string, action: unknown) {
    if (!isLessonId(tourId)) throw new BadRequestException('Tutorial inválido');
    if (action !== 'complete' && action !== 'dismiss' && action !== 'reset')
      throw new BadRequestException(
        'Ação inválida: use complete, dismiss ou reset',
      );
    const now = new Date();
    const data =
      action === 'complete'
        ? { completedAt: now }
        : action === 'dismiss'
          ? { dismissedAt: now }
          : { completedAt: null, dismissedAt: null };
    const row = await this.prisma.help_State.upsert({
      where: { userId_tourId: { userId: actor.userId, tourId } },
      create: {
        companyId: actor.companyId,
        userId: actor.userId,
        tourId,
        ...data,
      },
      update: data,
      select: { tourId: true, completedAt: true, dismissedAt: true },
    });
    return row;
  }

  /** Eventos de uso em lote. Os inválidos são descartados em silêncio: medir nunca atrapalha a tela. */
  async record(actor: HelpActor, body: { events?: unknown }) {
    const list = Array.isArray(body?.events)
      ? (body.events as IncomingEvent[]).slice(0, MAX_EVENTS)
      : [];
    const rows = list
      .filter(
        (item) =>
          item &&
          typeof item.event === 'string' &&
          (HELP_EVENTS as readonly string[]).includes(item.event),
      )
      .map((item) => {
        const tourId =
          typeof item.tourId === 'string' && isLessonId(item.tourId)
            ? item.tourId
            : null;
        const step =
          Number.isInteger(item.step) &&
          (item.step as number) >= 0 &&
          (item.step as number) < 1000
            ? (item.step as number)
            : null;
        return {
          companyId: actor.companyId,
          userId: actor.userId,
          event: item.event as string,
          tourId,
          step,
          target: text(item.target, 120),
          route: text(item.route, 200),
        };
      });
    if (rows.length) await this.prisma.help_Event.createMany({ data: rows });
    return { recorded: rows.length };
  }
}
