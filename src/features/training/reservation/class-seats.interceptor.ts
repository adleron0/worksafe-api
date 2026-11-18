import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, mergeMap } from 'rxjs';
import { PrismaService } from 'src/prisma/prisma.service';
import { seatsOfClasses } from './seats';

/**
 * Listagem/leitura de turmas: acrescenta `seats` (vagas com as reservas de
 * empresa) e faz `_count.subscriptions` valer as vagas OCUPADAS — o site, a
 * divulgação e a agenda usam esse número para "vagas restantes" e "lotada", e
 * vaga reservada para empresa já está vendida.
 */
@Injectable()
export class ClassSeatsInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(mergeMap((body) => from(this.enrich(body))));
  }

  private async enrich(body: any) {
    try {
      const rows: any[] = Array.isArray(body?.rows) ? body.rows : Array.isArray(body) ? body : body && typeof body === 'object' && 'courseId' in body ? [body] : [];
      const ids = rows.map((r) => Number(r?.id)).filter((id) => id > 0);
      if (!ids.length) return body;
      const seats = await seatsOfClasses(this.prisma, ids);
      for (const row of rows) {
        const s = seats.get(Number(row?.id));
        if (!s) continue;
        row.seats = s;
        if (row._count && typeof row._count === 'object' && 'subscriptions' in row._count) row._count.subscriptions = s.occupied;
      }
    } catch {
      // vagas são enfeite da listagem: erro aqui não derruba a página
    }
    return body;
  }
}
