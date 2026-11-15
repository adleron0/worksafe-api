import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { actorOf } from '../ai.controller';
import { ReportService } from './report.service';

type Json = Record<string, any>;

/** Relatórios agendados (configuração) e relatórios gerados (leitura). */
@Controller('ai')
export class ReportController {
  constructor(private readonly reports: ReportService) {}

  // a agenda é de quem usa os bots (cada um vê as próprias tarefas); quem configura os bots vê todas
  @Permissions('usar_bots') @Get('schedules')
  schedules(@Req() req: Request) { return this.reports.list(actorOf(req)); }

  @Permissions('usar_bots', 'agendar_bots') @Post('schedules')
  create(@Req() req: Request, @Body() body: Json) { return this.reports.create(actorOf(req), body ?? {}); }

  @Permissions('usar_bots', 'agendar_bots') @Put('schedules/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reports.update(actorOf(req), id, body ?? {}); }

  @Permissions('usar_bots', 'agendar_bots') @Patch('schedules/:id/remove')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.remove(actorOf(req), id); }

  @Permissions('usar_bots', 'agendar_bots') @Patch('schedules/:id/pause')
  pause(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.setActive(actorOf(req), id, false); }

  @Permissions('usar_bots', 'agendar_bots') @Patch('schedules/:id/resume')
  resume(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.setActive(actorOf(req), id, true); }

  @Permissions('usar_bots', 'agendar_bots') @Post('schedules/:id/run') @HttpCode(200)
  run(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.runNow(actorOf(req), id); }

  @Permissions('usar_bots') @Get('reports')
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.reports.reports(actorOf(req), query ?? {}); }

  @Permissions('usar_bots') @Get('reports/:id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.report(actorOf(req), id); }
}
