import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Public } from 'src/auth/decorators/public.decorator';
import { LandingService } from './landing.service';

/** Página de inscrição da turma: eventos do teste A/B e resultados. */
@Controller('landing')
export class LandingController {
  constructor(private readonly landing: LandingService) {}

  /** Eventos do site (visita, rolagem, cliques, envio). Público e limitado por IP. */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Post('events')
  @HttpCode(200)
  record(@Body() body: Record<string, unknown>, @Req() req: Request) {
    return this.landing.record(body, req.headers['user-agent']);
  }

  @Permissions('list_classes')
  @Get('results/:classId')
  results(@Param('classId', ParseIntPipe) classId: number, @Req() req: Request) {
    return this.landing.results(classId, Number((req as Request & { user?: { companyId?: number } }).user?.companyId ?? 0));
  }

  @Permissions('list_classes')
  @Get('summary')
  summary(@Req() req: Request) {
    return this.landing.summary(Number((req as Request & { user?: { companyId?: number } }).user?.companyId ?? 0));
  }
}
